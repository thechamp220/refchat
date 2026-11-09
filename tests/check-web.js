'use strict';
// Vérifie la lecture d'une réponse /responses AVEC search grounding :
// comptage des recherches, extraction des citations, et surtout le fait que le
// verdict JSON reste lisible quand des items web_search_call s'intercalent dans
// output[]. C'est le seul risque que je peux tester hors ligne — savoir si la
// passerelle Go relaie l'outil demande un vrai appel.
//
//   node tests/check-web.js
//
// background.js est chargé tel quel dans un bac à sable : ce sont les VRAIES
// fonctions qui sont testées.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const noop = () => {};
const listener = { addListener: noop, removeListener: noop, hasListener: () => false };

const chrome = {
  runtime: { onMessage: listener, onInstalled: listener, onStartup: listener, lastError: null, id: 'test', getURL: (p) => p, sendMessage: noop },
  storage: {
    local: { get: (d, cb) => cb && cb(typeof d === 'object' && d !== null ? d : {}), set: (o, cb) => cb && cb(), remove: noop },
    sync: { get: (d, cb) => cb && cb(typeof d === 'object' && d !== null ? d : {}), set: (o, cb) => cb && cb() },
    session: { get: (d, cb) => cb && cb({}), set: (o, cb) => cb && cb() },
    onChanged: listener
  },
  alarms: { create: noop, clear: noop, onAlarm: listener },
  notifications: { create: noop, clear: noop, onClicked: listener, onButtonClicked: listener },
  tabs: { query: (q, cb) => cb && cb([]), sendMessage: noop, onUpdated: listener, onRemoved: listener, create: noop },
  scripting: { executeScript: () => Promise.resolve([]) },
  webNavigation: { onCompleted: listener, onHistoryStateUpdated: listener },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setTitle: noop, onClicked: listener },
  windows: { create: noop }
};

const sandbox = {
  chrome,
  console,
  fetch: () => Promise.reject(new Error('offline')),
  AbortController,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  JSON,
  URL,
  TextEncoder,
  TextDecoder
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.importScripts = (f) => {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
};

const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });

const { webUsage, rejectedParam, messageText, parseFullVerdict, parseReportVerdict, incompleteReason } = sandbox;
// `const` au top-level d'un script vm est une liaison lexicale, pas une propriété
// du global : contrairement aux fonctions, AUDIT_FULL n'apparaît pas dans sandbox.
const AUDIT_FULL = vm.runInContext('AUDIT_FULL', ctx);
const REASON_BUDGET = vm.runInContext('REASON_BUDGET', ctx);
for (const [n, f] of [['webUsage', webUsage], ['rejectedParam', rejectedParam], ['messageText', messageText], ['parseFullVerdict', parseFullVerdict]]) {
  if (typeof f !== 'function') {
    console.error(n + ' introuvable — background.js a-t-il changé ?');
    process.exit(2);
  }
}

let ko = 0;
function check(label, got, want) {
  const okk = JSON.stringify(got) === JSON.stringify(want);
  if (!okk) ko += 1;
  console.log((okk ? '  ok  ' : '  KO  ') + label + (okk ? '' : '\n        obtenu ' + JSON.stringify(got) + '\n        attendu ' + JSON.stringify(want)));
}

const cite = (url, title) => ({ type: 'url_citation', url, title, start_index: 0, end_index: 10 });

// Forme documentée : reasoning + web_search_call + message annoté.
const GROUNDED = {
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'web_search_call', status: 'completed' },
    { type: 'web_search_call', status: 'completed' },
    {
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: '{"mute":true,"score":0.82,"why":"Hostilité répétée envers un joueur nommé.","evidence":[2,5]}',
          annotations: [cite('https://a.example/slang', 'Que veut dire bouffi'), cite('https://b.example/cs2', 'Lexique CS2')]
        }
      ]
    }
  ]
};

console.log('--- lecture du grounding ---');
check('2 recherches, 2 sources', webUsage(GROUNDED, true), {
  on: true,
  searched: 2,
  sources: [
    { url: 'https://a.example/slang', title: 'Que veut dire bouffi' },
    { url: 'https://b.example/cs2', title: 'Lexique CS2' }
  ]
});

check('outil retiré → tout à zéro', webUsage(GROUNDED, false), { on: false, searched: 0, sources: [] });

check('le modèle n a pas cherché', webUsage({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }] }, true), {
  on: true,
  searched: 0,
  sources: []
});

check('réponse /chat/completions (pas d output[])', webUsage({ choices: [{ message: { content: '{}' } }] }, true), {
  on: true,
  searched: 0,
  sources: []
});

const dup = {
  output: [
    { type: 'web_search_call' },
    { type: 'message', content: [{ type: 'output_text', text: 'x', annotations: [cite('https://a.example/x', 'A'), cite('https://a.example/x', 'A bis')] }] }
  ]
};
check('URL dupliquée comptée une fois', webUsage(dup, true).sources.length, 1);

const many = {
  output: [
    {
      type: 'message',
      content: [{ type: 'output_text', text: 'x', annotations: Array.from({ length: 12 }, (_, i) => cite('https://s' + i + '.example/', 'S' + i)) }]
    }
  ]
};
check('plafond à 6 sources', webUsage(many, true).sources.length, 6);

check('citation sans url ignorée', webUsage({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'x', annotations: [{ type: 'url_citation' }] }] }] }, true).sources, []);

// LE test qui compte : les items web_search_call ne doivent pas casser
// l'extraction du verdict. S'ils la cassaient, l'audit renverrait
// « réponse illisible » alors que le modèle a répondu correctement.
console.log('\n--- le verdict survit aux items de recherche ---');
const verdict = parseFullVerdict(messageText(GROUNDED));
check('verdict lu malgré les web_search_call', verdict && { mute: verdict.mute, score: verdict.score, evidence: verdict.evidence }, {
  mute: true,
  score: 0.82,
  evidence: [2, 5]
});

console.log('\n--- dégradation sur refus de la passerelle ---');
for (const [label, err, want] of [
  ['outil non relayé', new Error('llm_http_400 unsupported tool: web_search'), 'web'],
  ['search_context_size refusé', new Error('llm_http_400 unknown parameter search_context_size'), 'web'],
  ['palier refusé', new Error('llm_http_400 invalid reasoning effort xhigh'), 'effort'],
  ['erreur serveur', new Error('llm_http_500 internal'), ''],
  ['timeout', new Error('llm_timeout'), ''],
  ['quota', new Error('llm_http_429 rate limited'), '']
]) {
  check(label, rejectedParam(err), want);
}

console.log('\n--- budget de raisonnement épuisé ---');
// Le cas qui a produit « réponse illisible » : le modele repond 200 OK, mais
// tout le budget est parti en raisonnement et le texte est vide.
const CUT = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning', summary: [] }] };
check('texte vide sur budget épuisé', messageText(CUT), '');
check('cause identifiée', incompleteReason(CUT), 'max_output_tokens');
check('réponse complète → aucune cause', incompleteReason(GROUNDED), '');
check('objet vide → aucune cause', incompleteReason(null), '');
check('incomplete sans détail', incompleteReason({ status: 'incomplete' }), 'incomplete');
// Un plafond calibre sur 'low' ne peut pas tenir a xhigh : c'etait la cause.
check('xhigh a un plafond propre', REASON_BUDGET.xhigh > REASON_BUDGET.high, true);
check('audit manuel : palier unique = minimal', AUDIT_FULL.EFFORTS, ['minimal']);
check('les paliers de l audit ont un budget', AUDIT_FULL.EFFORTS.every((e) => REASON_BUDGET[e] > 0), true);

console.log('\n--- budget de tentatives ---');
// web + un palier : 2 essais. Plus de cascade xhigh→high→medium.
check('la boucle couvre le retrait du web + le palier', AUDIT_FULL.EFFORTS.length + 1, 2);
check('outil envoyé au bon format', AUDIT_FULL.SEARCH, { type: 'web_search', search_context_size: 'medium' });

const REPORT_AUDIT = vm.runInContext('REPORT_AUDIT', ctx);
console.log('\n--- audit dossier (thinking high, distinct de l audit auteur) ---');
check('dossier : high puis degradation', REPORT_AUDIT.EFFORTS, ['high', 'medium', 'minimal']);
check('parseReportVerdict existe', typeof parseReportVerdict, 'function');
const GROUNDED_REP = {
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'web_search_call', status: 'completed' },
    {
      type: 'message',
      content: [{
        type: 'output_text',
        text: '{"report":false,"score":0.2,"kind":"faux-positif","why":"Meme, pas une menace.","evidence":[1]}'
      }]
    }
  ]
};
check(
  'verdict dossier lu malgré web_search_call',
  parseReportVerdict(messageText(GROUNDED_REP)),
  { report: false, score: 0.2, why: 'Meme, pas une menace.', kind: 'faux-positif', evidence: [1] }
);

console.log(ko ? '\n' + ko + ' échec(s)' : '\ntout est vert');
process.exit(ko ? 1 : 0);
