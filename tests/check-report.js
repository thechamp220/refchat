'use strict';

// File « EXTREME » : capture des cas graves pour un signalement Twitch manuel.
//
// Un score eleve ou un hitHeavy de filtre n'est jamais une preuve suffisante.
//
//   node tests/check-report.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const noop = () => {};
const listener = { addListener: noop, removeListener: noop, hasListener: () => false };
const sent = [];

// Storage local fidele : ce que le worker ecrit, on le relit.
const store = {};
const localApi = {
  get: (d, cb) => {
    const out = {};
    for (const k of Object.keys(d || {})) out[k] = k in store ? JSON.parse(JSON.stringify(store[k])) : d[k];
    if (cb) cb(out);
  },
  set: (o, cb) => {
    for (const k of Object.keys(o || {})) store[k] = o[k];
    if (cb) cb();
  },
  remove: (k, cb) => {
    for (const key of [].concat(k)) delete store[key];
    if (cb) cb();
  }
};

const chrome = {
  runtime: { onMessage: listener, onInstalled: listener, onStartup: listener, lastError: null, id: 'test', getURL: (p) => p, sendMessage: noop },
  storage: { local: localApi, sync: localApi, session: localApi, onChanged: listener },
  alarms: { create: noop, clear: noop, onAlarm: listener },
  notifications: { create: noop, clear: noop, onClicked: listener, onButtonClicked: listener },
  tabs: {
    query: (q, cb) => cb && cb([]),
    sendMessage: (id, msg, cb) => {
      sent.push({ id, msg });
      if (cb) cb();
    },
    onUpdated: listener,
    onRemoved: listener,
    create: noop
  },
  scripting: { executeScript: () => Promise.resolve([]) },
  webNavigation: { onCompleted: listener, onHistoryStateUpdated: listener },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setTitle: noop, onClicked: listener },
  windows: { create: noop }
};

const sandbox = { chrome, console, fetch: () => Promise.reject(new Error('offline')), AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, URL, TextEncoder, TextDecoder };
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.importScripts = (f) => {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
};
const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'keywords.js'), 'utf8'), ctx, { filename: 'keywords.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });

const run = (code) => vm.runInContext(code, ctx);
const { upsertFt, reportAddManual, parseReportVerdict, runReportAudit } = sandbox;
const REPORT_AUDIT = run('REPORT_AUDIT');

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (ok ? '' : '\n        obtenu  ' + JSON.stringify(got) + '\n        attendu ' + JSON.stringify(want)));
}

const reports = () => store.csg_reports || {};
const dossierOf = (key) => (reports()[key] || {}).msgs || [];

run('setSelfNicks(["moi", "moimeme"]);');

console.log('\n--- capture : motifs graves, pas score de mute ---');
upsertFt({ id: 'r1', author: 'Rageux', text: 'je vais te frapper ce soir', channel: 'twitch/streamer_fr' }, { label: 'mute', source: 'llm', score: 0.7 });
check('dossier cree par menace explicite', dossierOf('rageux|twitch/streamer_fr').length, 1);
check('flag extrême compté', reports()['rageux|twitch/streamer_fr'].ext, 1);

upsertFt({ id: 'r2', author: 'Bavard', text: 'gg wp bien joué la', channel: 'twitch/streamer_en' }, { label: 'mute', source: 'llm', score: 0.95 });
check('score 0.95 seul : pas de dossier', dossierOf('bavard|twitch/streamer_en').length, 0);
upsertFt({ id: 'religion', author: 'Sceptique', text: "non mais la Religion c'est le pire des fléaux, quelle que soit", channel: 'twitch/streamer_fr' }, { label: 'mute', source: 'llm', score: 0.94 });
check('opinion sur la religion à 94 % : pas de dossier', dossierOf('sceptique|twitch/streamer_fr').length, 0);

for (const [id, text] of [
  ['wish', "j'espère que tu meurs"],
  ['harass', 'fais-toi harceler'],
  ['harm', 'je te souhaite que du mal'],
  ['suicide', 'va te suicider'],
  ['dox', 'je connais ton adresse'],
  ['hate', 'sale juif']
]) {
  upsertFt({ id, author: id, text, channel: 'twitch/streamer_fr' }, { label: 'mute', source: 'llm', score: 0.6 });
  check('cas grave ' + id, dossierOf(id + '|twitch/streamer_fr').length, 1);
}
upsertFt({ id: 'quote', author: 'Citation', text: "il a dit j'espère que tu meurs", channel: 'twitch/streamer_fr' }, { label: 'mute', source: 'llm', score: 0.98 });
check('citation explicite : pas de dossier', dossierOf('citation|twitch/streamer_fr').length, 0);
upsertFt({ id: 'game', author: 'Jeu', text: 'je vais te retrouver en game', channel: 'twitch/streamer_fr' }, { label: 'mute', source: 'llm', score: 0.99 });
check('expression de jeu : pas de dossier', dossierOf('jeu|twitch/streamer_fr').length, 0);
upsertFt({ id: 'laugh', author: 'Rire', text: "j'espère que tu meurs de rire", channel: 'twitch/streamer_fr' }, { label: 'mute', source: 'llm', score: 0.99 });
check('mourir de rire : pas de dossier', dossierOf('rire|twitch/streamer_fr').length, 0);
upsertFt({ id: 'game2', author: 'Jeu', text: 'je vais te tuer en game', channel: 'twitch/streamer_fr' }, { label: 'mute', source: 'llm', score: 0.99 });
check('menace en jeu : pas de dossier', dossierOf('jeu|twitch/streamer_fr').length, 0);
upsertFt({ id: 'harsh', author: 'Insulte', text: 'sale connard', channel: 'twitch/streamer_fr' }, { label: 'mute', source: 'local', score: 1 });
check('simple insulte lourde : pas de dossier', dossierOf('insulte|twitch/streamer_fr').length, 0);

console.log('\n--- deduplication ---');
upsertFt({ id: 'r1', author: 'Rageux', text: 'je vais te frapper ce soir', channel: 'twitch/streamer_fr' }, { label: 'mute', source: 'llm', score: 0.7 });
check('même id : rien de plus', dossierOf('rageux|twitch/streamer_fr').length, 1);
upsertFt({ id: 'r3', author: 'Rageux', text: 'je vais te frapper ce soir', channel: 'twitch/streamer_fr' }, { label: 'mute', source: 'llm', score: 0.7 });
check('même texte, autre id : rien de plus', dossierOf('rageux|twitch/streamer_fr').length, 1);

console.log('\n--- non-qualifications ---');
upsertFt({ id: 'r4', author: 'Bavard', text: 'quel round ce passage', channel: 'twitch/streamer_en' }, { label: 'mute', source: 'llm', score: 0.6 });
check('message banal : pas de dossier', dossierOf('bavard|twitch/streamer_en').length, 0);
upsertFt({ id: 'r5', author: 'Bavard', text: 'CHICK', channel: 'twitch/streamer_en' }, { label: 'mute', source: 'muted', score: 1 });
check('source muted sans texte extreme : pas capturé', dossierOf('bavard|twitch/streamer_en').length, 0);
upsertFt({ id: 'r6', author: 'Moimeme', text: 'je vais te tuer', channel: 'twitch/streamer_fr' }, { label: 'mute', source: 'llm', score: 0.95 });
check('soi-même : jamais capturé', Object.keys(reports()).some((k) => k.startsWith('moimeme|')), false);
upsertFt({ id: 'r7', author: 'Anodin', text: 'je vais te tuer', channel: 'twitch/streamer_fr' }, { label: 'keep', source: 'llm', score: 0.1 });
check('label keep : pas capturé', Object.keys(reports()).some((k) => k.startsWith('anodin|')), false);

console.log('\n--- canaux séparés, plafond de messages ---');
upsertFt({ id: 'r8', author: 'Rageux', text: 'je connais ton adresse', channel: 'kick/streamer_fr' }, { label: 'mute', source: 'llm', score: 0.8 });
check('même auteur, autre site : dossier séparé', dossierOf('rageux|kick/streamer_fr').length, 1);
for (let i = 0; i < 30; i++) {
  upsertFt({ id: 'spam' + i, author: 'Rageux', text: 'je vais te frapper ce soir numero ' + i, channel: 'twitch/streamer_fr' }, { label: 'mute', source: 'llm', score: 0.7 });
}
check('plafond de preuves', dossierOf('rageux|twitch/streamer_fr').length <= run('REPORT.MAX_MSGS'), true);

console.log('\n--- ajout manuel depuis le tableau ---');
let manual = null;
reportAddManual('Bavard', '', (r) => (manual = r));
check('ajout manuel ok', manual && manual.ok, true);
check('ajout manuel marqué comme tel', reports()['bavard|twitch/streamer_en'].man, 1);
check('preuves pillees de ftLog (mutes seulement)', (reports()['bavard|twitch/streamer_en'].msgs || []).every((m) => m.text !== 'quel round ce passage'), false);
let manualFail = null;
reportAddManual('Inconnu_Au_Bataillon', '', (r) => (manualFail = r));
check('auteur inconnu : refus net', manualFail && !manualFail.ok && /aucun message/.test(manualFail.err), true);

console.log('\n--- persistence : plafond d auteurs ---');
check('plafond dossiers', Object.keys(reports()).length <= run('REPORT.MAX_AUTHORS'), true);

console.log('\n--- audit manuel 1.3 (thinking + web, Muse Go) ---');
if (typeof parseReportVerdict !== 'function' || typeof runReportAudit !== 'function') {
  fails++;
  console.log(' FAIL parseReportVerdict / runReportAudit introuvables');
} else {
  check(
    'parse : faux positif',
    parseReportVerdict('{"report":false,"score":0.1,"kind":"faux-positif","why":"blague","evidence":[1]}'),
    { report: false, score: 0.1, why: 'blague', kind: 'faux-positif', evidence: [1] }
  );
  check(
    'parse : menace',
    parseReportVerdict('{"report":true,"score":0.94,"kind":"menace","why":"menace credite","evidence":[1,2]}'),
    { report: true, score: 0.94, why: 'menace credite', kind: 'menace', evidence: [1, 2] }
  );
  check('parse : JSON mort', parseReportVerdict('pas du json'), null);
  check('thinking high d abord', REPORT_AUDIT.EFFORTS[0], 'high');
  check('puis degradation', REPORT_AUDIT.EFFORTS, ['high', 'medium', 'minimal']);
}

const srcBg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const srcBoard = fs.readFileSync(path.join(ROOT, 'board.js'), 'utf8');
check('handler CSG_REPORT_AUDIT', srcBg.indexOf("msg.type === 'CSG_REPORT_AUDIT'") !== -1, true);
check('analyse via le modele unique', srcBg.indexOf('function goDeepLane') !== -1, true);
check('bouton Analyser (1.3)', srcBoard.indexOf('Analyser (1.3)') !== -1 && srcBoard.indexOf('CSG_REPORT_AUDIT') !== -1, true);
const srcHtml = fs.readFileSync(path.join(ROOT, 'board.html'), 'utf8');
check('bouton barre Réanalyser', srcHtml.indexOf('id="repAudit"') !== -1 && srcBoard.indexOf('Réanalyser') !== -1, true);
check('onglet Signalements accessible', srcHtml.includes('data-tab="report"'), true);
check('panneau Signalements présent', srcHtml.includes('id="tab-report"'), true);
const auditFn = srcBg.slice(srcBg.indexOf('async function runReportAudit'), srcBg.indexOf('function bulkCandidates'));
check('analyse ne mute pas', auditFn.indexOf('addMute(') === -1 && auditFn.indexOf('runReportAudit') !== -1, true);

(async () => {
  if (typeof runReportAudit !== 'function') {
    console.log(fails ? '\n' + fails + ' échec(s)' : '\ntout est bon');
    process.exit(fails ? 1 : 0);
    return;
  }

  const empty = await runReportAudit('');
  check('dossier vide refuse', !!(empty && empty.ok === false && /vide/.test(empty.err)), true);
  const missing = await runReportAudit('personne|twitch/x');
  check('dossier inconnu refuse', !!(missing && missing.ok === false && /introuvable/.test(missing.err)), true);

  // Moteur unique : Grok 4.6 via l'OAuth SuperGrok, seule cle que laneKey lit.
  store.csg_engine = { googleKey: '', glmKey: '', apiKey: '', xaiOAuth: { access: 'xai-oauth-report', refresh: 'r', exp: Date.now() + 3600000 } };
  const calls = [];
  sandbox.__llmCalls = calls;
  sandbox.__llmFake = {
    output: [
      { type: 'web_search_call', status: 'completed' },
      {
        type: 'message',
        content: [{
          type: 'output_text',
          text: '{"report":false,"score":0.12,"kind":"faux-positif","why":"Citation ironique, pas une menace.","evidence":[1]}',
          annotations: [{ type: 'url_citation', url: 'https://example/slang', title: 'argot', start_index: 0, end_index: 4 }]
        }]
      }
    ]
  };
  run(
    'llmFetch = async function(url, apiKey, body, ms, path) {' +
      '__llmCalls.push({ url: url, model: body && body.model, effort: body && body.reasoning && body.reasoning.effort, tools: !!(body && body.tools), instructions: body && body.instructions, messages: body && body.messages });' +
      'return __llmFake;' +
    '}'
  );

  const beforeMute = Object.keys(sandbox.mutedUsers || {}).length;
  const r = await runReportAudit('rageux|twitch/streamer_fr');
  check('audit ok', !!(r && r.ok), true);
  check('classé faux positif', !!(r && r.report === false && r.kind === 'faux-positif'), true);
  check('modèle Grok 4.6', calls[0] && calls[0].model, 'grok-4.6');
  check('pas de web_search', !(calls[0] && calls[0].tools), true);
  check('prompt de signalement, pas de mute', !!(calls[0] && /FALSE POSITIVE/.test(calls[0].instructions || (calls[0].messages && calls[0].messages[0] && calls[0].messages[0].content))), true);
  check('dossier pas marqué fait', (reports()['rageux|twitch/streamer_fr'] || {}).done || 0, 0);
  check('verdict persisté', !!(reports()['rageux|twitch/streamer_fr'] && reports()['rageux|twitch/streamer_fr'].audit && reports()['rageux|twitch/streamer_fr'].audit.report === false), true);
  check('aucun mute appliqué', Object.keys(sandbox.mutedUsers || {}).length, beforeMute);
  check('URL xAI', !!(calls[0] && /api\.x\.ai/.test(calls[0].url)), true);

  console.log(fails ? '\n' + fails + ' échec(s)' : '\ntout est bon');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
