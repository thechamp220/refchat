'use strict';

// Doublon exact : le verdict deja rendu doit etre rejoue sur la nouvelle ligne.
//
// auditSeen ecarte les doublons pour ne pas payer deux fois le modele. Mais le
// content script n'a aucun cache de verdict : sans renvoi du verdict connu, la
// copie restait visible a cote d'une ligne identique masquee — vue de
// l'utilisateur, un message « accepte » sans jamais passer par le modele.
//
//   node tests/check-dedupe.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const noop = () => {};
const listener = { addListener: noop, removeListener: noop, hasListener: () => false };
const sent = [];

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
vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });

const run = (code) => vm.runInContext(code, ctx);
const { enqueueAudit, applyItemVerdict } = sandbox;

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (ok ? '' : '\n        obtenu  ' + JSON.stringify(got) + '\n        attendu ' + JSON.stringify(want)));
}
const hidesFor = (id) => sent.filter((s) => s.msg && s.msg.type === 'CSG_LLM_HIDE' && s.msg.id === id).length;

// Mode message : l'auteur n'est pas mute, donc rien d'autre que le verdict par
// ligne ne peut masquer le doublon. C'est le cas ou la memoire est indispensable.
run('punishTarget = "message";');
run('auditQueue.length = 0; auditSeen.clear(); verdictMemo.clear();');

console.log('\n--- un doublon de ligne jugee toxique est masque a son tour ---');
check('1re ligne mise en file', enqueueAudit('Bob', 'sale merde', { id: 'a1', tabId: 7, channel: 'twitch/x' }), true);
const item1 = run('auditQueue[0]');
applyItemVerdict(item1, { score: 0.94, tag: 'lot' }, 0.4, 5, { id: 'fake', canMuteAuthor: true });
check('verdict mémorisé', run('verdictMemo.has("twitch:bob|sale merde")'), true);
check('1re ligne masquee', hidesFor('a1'), 1);

sent.length = 0;
check('doublon accepte sans repasser par le modele', enqueueAudit('Bob', 'sale merde', { id: 'a2', tabId: 7, channel: 'twitch/x' }), true);
check('  et le verdict est rejoue sur la nouvelle ligne', hidesFor('a2'), 1);
check('  la file ne regonfle pas', run('auditQueue.length'), 1);

console.log('\n--- un doublon de ligne gardee reste silencieux ---');
check('ligne gardee mise en file', enqueueAudit('Alice', 'bonjour', { id: 'b1', tabId: 7, channel: 'twitch/x' }), true);
run('auditQueue.length = 0;');
const item2 = { a: 'Alice', t: 'bonjour', id: 'b1', k: 'twitch:alice|bonjour', tabId: 7, channel: 'twitch/x' };
applyItemVerdict(item2, { score: 0.06, tag: 'lot' }, 0.4, 5, { id: 'fake', canMuteAuthor: true });
check('un keep est memorise aussi', run('JSON.stringify(verdictMemo.get("twitch:alice|bonjour"))'), JSON.stringify({ mute: false, score: 0.06 }));

sent.length = 0;
enqueueAudit('Alice', 'bonjour', { id: 'b2', tabId: 7, channel: 'twitch/x' });
check('doublon garde : rien a masquer', hidesFor('b2'), 0);

// Journal : c'est lui que l'utilisateur lit. Sur salon_kick (Kick), 58 % des
// lignes envoyees etaient des doublons exacts ; elles restaient « en attente »
// puis « perdues », et le filtre avait l'air de ne rien attraper.
const ft = (id) => {
  const r = run('ftById.get(' + JSON.stringify(id) + ')');
  return r ? r.label + ':' + r.source : null;
};
const capture = (author, text, id) => run('upsertFt')({ id, author, text, channel: 'kick/x' }, { label: 'pending', source: 'pending' });

console.log('\n--- journal : un doublon d une ligne deja jugee est tranche aussitot ---');
capture('Bob', 'sale merde', 'a3');
enqueueAudit('Bob', 'sale merde', { id: 'a3', tabId: 7, channel: 'twitch/y' });
check('copie d une ligne toxique', ft('a3'), 'mute:doublon');
capture('Alice', 'bonjour', 'b3');
enqueueAudit('Alice', 'bonjour', { id: 'b3', tabId: 7, channel: 'twitch/y' });
check('copie d une ligne gardee', ft('b3'), 'keep:doublon');
capture('Alice', 'bonjour', 'b3');
check('la capture arrivee en retard n ecrase pas le verdict', ft('b3'), 'keep:doublon');

console.log('\n--- journal : un doublon arrive pendant que l original attend ---');
run('auditQueue.length = 0; auditSeen.clear(); verdictMemo.clear(); dupWaiters.clear();');
capture('Carl', 'WHERE IS BLUCIFER', 'c1');
enqueueAudit('Carl', 'WHERE IS BLUCIFER', { id: 'c1', tabId: 7, channel: 'kick/x' });
for (const id of ['c2', 'c3']) {
  capture('Carl', 'WHERE IS BLUCIFER', id);
  enqueueAudit('Carl', 'WHERE IS BLUCIFER', { id, tabId: 7, channel: 'kick/x' });
}
check('une seule ligne en file', run('auditQueue.length'), 1);
check('les copies attendent', [ft('c2'), ft('c3')], ['pending:pending', 'pending:pending']);
applyItemVerdict(run('auditQueue[0]'), { score: 0.05, tag: 'lot' }, 0.4, 5, { id: 'fake', canMuteAuthor: true });
check('le verdict de l original tombe sur les copies', [ft('c1'), ft('c2'), ft('c3')], ['keep:llm', 'keep:doublon', 'keep:doublon']);
check('plus rien en attente de copie', run('dupWaiters.size'), 0);

console.log('\n--- UI : un doublon toxique arrive pendant que l original attend ---');
run('auditQueue.length = 0; auditSeen.clear(); verdictMemo.clear(); dupWaiters.clear();');
sent.length = 0;
capture('Carl', 'sale merde', 'ct1');
enqueueAudit('Carl', 'sale merde', { id: 'ct1', tabId: 7, channel: 'kick/x' });
capture('Carl', 'sale merde', 'ct2');
enqueueAudit('Carl', 'sale merde', { id: 'ct2', tabId: 8, channel: 'kick/x' });
applyItemVerdict(run('auditQueue[0]'), { score: 0.95, tag: 'lot' }, 0.4, 5, { id: 'fake', canMuteAuthor: true });
check('original masque dans son onglet', hidesFor('ct1'), 1);
check('copie en attente masquee dans son onglet', hidesFor('ct2'), 1);

console.log('\n--- journal : original abandonne, les copies ne sont pas maquillees ---');
run('auditQueue.length = 0; auditSeen.clear(); verdictMemo.clear(); dupWaiters.clear();');
capture('Dan', 'spam spam', 'd1');
enqueueAudit('Dan', 'spam spam', { id: 'd1', tabId: 7, channel: 'kick/x' });
capture('Dan', 'spam spam', 'd2');
enqueueAudit('Dan', 'spam spam', { id: 'd2', tabId: 7, channel: 'kick/x' });
run('finalizeFt')(run('auditQueue.shift()'), { label: 'dropped', source: 'file pleine' });
check('la copie suit l abandon, sans pretendre a un verdict', ft('d2'), 'dropped:file pleine');

console.log('\n--- original sorti sans verdict : la copie suivante est jugee ---');
run('auditQueue.length = 0; auditSeen.clear(); verdictMemo.clear(); dupWaiters.clear();');
enqueueAudit('Eve', 'bizarre', { id: 'e1', tabId: 7, channel: 'kick/x' });
run('auditQueue.length = 0;');
check('pas de verdict connu, original plus en file', run('verdictMemo.has("kick:eve|bizarre")'), false);
enqueueAudit('Eve', 'bizarre', { id: 'e2', tabId: 7, channel: 'kick/x' });
check('la copie repart au modele', run('auditQueue.map((q) => q.id)'), ['e2']);

console.log('\n--- auteur mute pendant que sa ligne voyageait ---');
run('auditQueue.length = 0; punishTarget = "author";');
run('mutedUsers.frank = { score: 0.95, reason: "flou", at: Date.now() };');
capture('Frank', 'BITCH UR IN BADDIES', 'f1');
enqueueAudit('Frank', 'BITCH UR IN BADDIES', { id: 'f1', tabId: 7, channel: 'kick/x' });
check('la ligne sort du « en attente »', ft('f1'), 'mute:muted');

// Twitch et Kick : un meme pseudo sur les deux sites, ce sont deux personnes.
// Avant, mutes, profils et doublons etaient ranges par pseudo seul : un « bob »
// Kick mute masquait le « bob » Twitch, et son historique Kick pesait sur lui.
console.log('\n--- Twitch et Kick separes : doublons ---');
run('auditQueue.length = 0; auditSeen.clear(); verdictMemo.clear(); dupWaiters.clear(); mutedUsers = {};');
enqueueAudit('Gus', 'ratio', { id: 'g1', tabId: 7, channel: 'kick/x' });
applyItemVerdict(run('auditQueue.shift()'), { score: 0.05, tag: 'lot' }, 0.4, 5, { id: 'fake', canMuteAuthor: true });
enqueueAudit('Gus', 'ratio', { id: 'g2', tabId: 8, channel: 'twitch/y' });
check('meme pseudo, meme texte, autre site : juge pour lui-meme', run('auditQueue.map((q) => q.id)'), ['g2']);
enqueueAudit('Gus', 'ratio', { id: 'g3', tabId: 7, channel: 'kick/z' });
check('meme site, autre chaine : reste un doublon', run('auditQueue.map((q) => q.id)'), ['g2']);

console.log('\n--- Twitch et Kick separes : mutes ---');
run('auditQueue.length = 0; auditSeen.clear(); mutedUsers = {};');
run('addMute')('Hugo', 0.9, 'flou', { channel: 'kick/x' });
check('mute pose sur Kick', run('muteSite(mutedUsers.hugo)'), 'kick');
check('  le Hugo Twitch passe encore au modele', enqueueAudit('Hugo', 'salut', { id: 'h1', tabId: 8, channel: 'twitch/y' }), true);
check('  le Hugo Kick, lui, est ecarte', enqueueAudit('Hugo', 'salut 2', { id: 'h2', tabId: 7, channel: 'kick/x' }), false);
run('addMute')('Hugo', 0.9, 'flou', { channel: 'twitch/y' });
// Deux sites = une fiche `sites: { kick, twitch }`, chaque entree gardant son canal.
check('flag aussi sur Twitch : le mute vaut pour les deux', run('muteSites(mutedUsers.hugo)'), ['kick', 'twitch']);
check('  chaque site garde son canal', [run('mutedUsers.hugo.sites.kick.channel'), run('mutedUsers.hugo.sites.twitch.channel')], ['kick/x', 'twitch/y']);
check('  le Hugo Twitch est ecarte a son tour', enqueueAudit('Hugo', 'salut 3', { id: 'h3', tabId: 8, channel: 'twitch/y' }), false);
run('mutedUsers = { vieux: { at: 1, pct: 90, channel: "twitch/y" }, inconnu: { at: 1, pct: 90 } };');
check('ancien mute avec canal Twitch : Twitch seulement', [!!run('mutedOn("vieux", "twitch")'), !!run('mutedOn("vieux", "kick")')], [true, false]);
check('ancien mute sans canal : les deux, personne n est demute', [!!run('mutedOn("inconnu", "twitch")'), !!run('mutedOn("inconnu", "kick")')], [true, true]);

console.log('\n--- Twitch et Kick separes : profil d auteur ---');
run('mutedUsers = {}; authorHistory.clear();');
const trackOn = (ch, t) => run('trackAuthor')('Ivy', t, { channel: ch, ts: Date.now() });
for (const t of ['k1', 'k2', 'k3']) trackOn('kick/x', t);
trackOn('twitch/y', 't1');
check('3 messages Kick + 1 Twitch : pas encore de profil', run('authorHistory.get("ivy").lastCheck'), 0);
check('le profil Twitch ne voit que le message Twitch', run('getAuthorMessages("ivy", 60, "twitch").map((m) => m.t)'), ['t1']);
trackOn('kick/x', 'k4');
check('4e message Kick : toujours pas de profil auto', run('authorHistory.get("ivy").lastCheck'), 0);
check('le profil Kick ne voit que Kick', run('getAuthorMessages("ivy", 60, "kick").map((m) => m.t)'), ['k1', 'k2', 'k3', 'k4']);

console.log(fails ? '\n' + fails + ' ECHEC(S)\n' : '\ntout est vert\n');
process.exit(fails ? 1 : 0);
