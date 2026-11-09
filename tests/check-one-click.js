'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bg = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const popup = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
const board = fs.readFileSync(path.join(__dirname, '..', 'board.html'), 'utf8');
const boardJs = fs.readFileSync(path.join(__dirname, '..', 'board.js'), 'utf8');
const between = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

assert.match(between(content, 'function handleLine', 'function hideMuted'),
  /source: 'pending', label: 'pending', hint, burst \}\)\);/);
assert.match(between(bg, "if (msg.type === 'CSG_ENQUEUE')", "if (msg.type === 'CSG_SELF')"),
  /queued: false/);
assert.match(between(bg, "if (msg.type === 'CSG_LOCAL_TOXIC')", "if (msg.type === 'CSG_IDLE_RUN')"),
  /applied: false/);
assert.match(between(bg, 'function syncJudge', 'function applySettings'), /llmJudge = false/);
assert.doesNotMatch(popup, /id="judge"|id="scope"/);
assert.match(popup, /id="analyzeCaptured"[^>]*>Analyser les messages capturés</,
  'le clic principal doit etre accessible depuis le popup');
assert.match(popupJs, /\$\('analyzeCaptured'\)\.addEventListener\('click'/);
assert.match(popupJs, /type: 'CSG_AUDIT_ALL_START'/,
  'le popup doit déclencher la meme analyse globale que le tableau');
assert.match(popup, /id="laneSel"/, 'sélecteur de modèle présent dans le popup');
assert.match(popup, /id="googleKey"[\s\S]*id="glmKey"[\s\S]*id="xaiKey"[\s\S]*id="customUrl"/, 'clés API multi-fournisseurs présentes');
assert.match(popup, /id="xaiOAuthBtn"[^>]*>Se connecter avec SuperGrok</);
assert.match(board, /id="auditAll"[^>]*>Analyser les messages capturés</);
assert.match(boardJs, /\$\('auditAll'\)\.addEventListener\('click'/);
assert.match(boardJs, /type: 'CSG_AUDIT_ALL_START'/);
for (const tab of ['idle', 'learn', 'skips']) {
  assert.doesNotMatch(board, new RegExp('data-tab="' + tab + '"'), 'onglet ' + tab + ' retiré du dashboard');
  assert.match(board, new RegExp('id="tab-' + tab + '"[^>]*\\bhidden\\b'), 'ancienne vue ' + tab + ' inaccessible');
}

const rows = [
  { id: '1', ts: 1, author: 'alice', text: 'bonjour', label: 'pending', channel: 'twitch/a' },
  { id: '2', ts: 2, author: 'bob', text: 'mot interdit', label: 'pending', channel: 'twitch/a' },
  { id: '3', ts: 3, author: 'alice', text: 'attaque', label: 'dropped', channel: 'twitch/a' },
  { id: '4', ts: 4, author: 'bob', text: 'déjà jugé', label: 'keep', channel: 'twitch/a' }
];
const calls = [];
const storage = {};
const ctx = {
  ftLog: rows,
  ftById: new Map(rows.map((r) => [r.id, r])),
  codexJudgments: {}, codexLocalKey: (r) => r.channel + '\n' + r.author + '\n' + r.text,
  isSelf: () => false,
  chrome: {
    storage: {
      local: { set: (v) => Object.assign(storage, v) },
      sync: { get: (_, cb) => cb({ csg_settings: { extraWords: 'mot interdit' } }) }
    },
    alarms: { create() {}, clear() {} }
  },
  publishAudit() {}, broadcastMutes() {},
  getEngine: async () => ({}), resolveGoogleModels: async () => {},
  openLanes: () => [{ id: 'test' }], laneBatch: () => 16, laneMs: () => 100,
  tryLane: async (_, __, items) => {
    calls.push(Array.from(items, (it) => it.id));
    return items.map((it) => ({ score: it.t === 'attaque' ? 0.95 : 0.1, tag: 'lot' }));
  },
  applyItemVerdict: (item, verdict) => {
    ctx.ftById.get(item.id).label = verdict.score >= 0.5 ? 'mute' : 'keep';
    if (verdict.score >= 0.5) {
      if (!ctx.mutedUsers) ctx.mutedUsers = {};
      ctx.mutedUsers[String(item.a).toLowerCase()] = true;
    }
  },
  finalizeFt: (item, verdict) => { ctx.ftById.get(item.id).label = verdict.label; },
  trimFtLabeled() {},
  verdictBit: () => ({ score: 0.94, tag: 'lot' }),
  thresholdCache: 0.4, AUDIT: { CALL_MS: 100 }, BULK: { GAP_MS: 0 },
  liveOn: () => false, scheduleLiveBulk() {},
  mutedOn: (author) => ctx.mutedUsers && !!ctx.mutedUsers[author],
  siteOf: () => 'twitch',
  nickKey: (name) => String(name || '').toLowerCase(),
  self: { CSG_KEYWORDS: {
    parseExtra: (raw) => raw.split(',').map((x) => x.trim()),
    hitExtra: (text, words) => words.some((w) => text.includes(w))
  } },
  setTimeout, Date
};
vm.createContext(ctx);
vm.runInContext(between(bg, '// --- Jugement manuel des captures', '\nfunction authorKind'), ctx);

const keepAlive = setInterval(() => {}, 1000);
(async () => {
  assert.equal(ctx.bulkCandidates().length, 3);
  const status = await ctx.runBulkAudit();
  assert.equal(status.total, 3);
  assert.equal(status.done, 3);
  assert.equal(status.peopleTotal, 2);
  assert.equal(status.peopleDone, 2);
  assert.equal(status.running, false);
  assert.deepEqual(calls, [['1', '3']]);
  assert.deepEqual(rows.map((r) => r.label), ['keep', 'mute', 'mute', 'keep']);
  assert.equal(storage.csg_manual_run.done, 3);

  // File de personnes : Alice est prise en entier (ligne ancienne + ligne plus
  // tard), Bob attend son tour. Un message d'Alice pendant l'appel reste sur elle.
  ctx.mutedUsers = {};
  const peopleCalls = [];
  const peopleRows = [
    { id: 'p1', ts: 1, author: 'alice', text: 'bonjour', label: 'pending', channel: 'twitch/a' },
    { id: 'p2', ts: 2, author: 'bob', text: 'salut', label: 'pending', channel: 'twitch/a' },
    { id: 'p3', ts: 3, author: 'alice', text: 'plus tard', label: 'pending', channel: 'twitch/a' }
  ];
  ctx.ftLog = peopleRows;
  ctx.ftById = new Map(peopleRows.map((r) => [r.id, r]));
  ctx.tryLane = async (_, __, items) => {
    peopleCalls.push(Array.from(items, (it) => it.id));
    if (items.some((it) => it.id === 'p1') && !ctx.ftById.has('p4')) {
      const late = { id: 'p4', ts: 4, author: 'alice', text: 'pendant', label: 'pending', channel: 'twitch/a' };
      ctx.ftLog.push(late);
      ctx.ftById.set('p4', late);
    }
    return items.map(() => ({ score: 0.1, tag: 'lot' }));
  };
  const peopleStatus = await ctx.runBulkAudit();
  assert.equal(peopleStatus.running, false);
  assert.deepEqual(peopleCalls, [['p1', 'p3'], ['p4'], ['p2']]);
  assert.equal(ctx.ftById.get('p4').label, 'keep');

  // Un message qui arrive pendant l'appel rejoint le même passage, au lieu
  // de rester en file jusqu'au prochain clic.
  calls.length = 0;
  const live = { id: '5', ts: 5, author: 'cara', text: 'en direct', label: 'pending', channel: 'twitch/a' };
  ctx.ftLog.push(live);
  ctx.ftById.set('5', live);
  ctx.tryLane = async (_, __, items) => {
    calls.push(Array.from(items, (it) => it.id));
    if (!ctx.ftById.has('6')) {
      const flowed = { id: '6', ts: Date.now() + 5000, author: 'dino', text: 'arrivé pendant', label: 'pending', channel: 'twitch/a' };
      ctx.ftLog.push(flowed);
      ctx.ftById.set('6', flowed);
    }
    return items.map(() => ({ score: 0.1, tag: 'lot' }));
  };
  const flowed = await ctx.runBulkAudit();
  assert.equal(flowed.running, false);
  assert.equal(flowed.done, 2);
  assert.deepEqual(calls, [['5'], ['6']]);
  assert.equal(ctx.ftById.get('6').label, 'keep');
  assert.equal(ctx.bulkCandidates().length, 0);

  // Auteur déjà muté : ses messages en attente sont nettoyés à 0 appel modèle.
  const mutedSkipCalls = [];
  const mutedSkipRows = [
    { id: 'm1', ts: 10, author: 'troll', text: 'premier mot toxique', label: 'pending', channel: 'twitch/a' },
    { id: 'm2', ts: 11, author: 'troll', text: 'deuxieme message inutile de juger', label: 'pending', channel: 'twitch/a' }
  ];
  ctx.ftLog = mutedSkipRows;
  ctx.ftById = new Map(mutedSkipRows.map((r) => [r.id, r]));
  ctx.tryLane = async (_, __, items) => {
    mutedSkipCalls.push(Array.from(items, (it) => it.id));
    return items.map(() => ({ score: 0.95, tag: 'lot' }));
  };
  const mutedSkipStatus = await ctx.runBulkAudit();
  assert.equal(mutedSkipStatus.running, false);
  // Un seul lot appelé : après le mute de troll sur m1, m2 est finalisé directement sans second appel.
  assert.deepEqual(mutedSkipCalls, [['m1', 'm2']]);
  assert.equal(ctx.ftById.get('m1').label, 'mute');
  assert.equal(ctx.ftById.get('m2').label, 'mute');
  assert.equal(ctx.bulkCandidates().length, 0);

  // Le vrai service worker, ses stockages et son faux serveur de modèle.
  const { bench, booted, tick } = require('./bench');
  const OAUTH_ENGINE = { xaiOAuth: { access: 'test-oauth', refresh: 'refresh-oauth', expires: Date.now() + 3600000 } };
  const b = bench({ csg_engine: OAUTH_ENGINE }, { sync: { csg_settings: { judge: true } } });
  await booted(b);
  for (let i = 0; i < 10 && !b.run('ftLoaded'); i++) await tick();
  b.run('BULK.GAP_MS = 0');
  b.run("upsertFt({ id: 'manual-1', author: 'alice', text: 'bonjour', channel: 'twitch/a' }, { label: 'pending', source: 'one_click' })");
  b.run("upsertFt({ id: 'manual-2', author: 'bob', text: 'attaque toxique', channel: 'twitch/a' }, { label: 'pending', source: 'one_click' })");
  await tick();
  assert.equal(b.api.calls.length, 0, 'aucun appel avant le clic');
  assert.equal(b.run('llmJudgeOn()'), false);
  const realStatus = await b.run('runBulkAudit()');
  assert.equal(realStatus.done, 2);
  assert.equal(b.api.calls.length, 2, 'un appel par personne');
  assert.equal(b.run("ftById.get('manual-1').label"), 'keep');
  assert.equal(b.run("ftById.get('manual-2').label"), 'mute');
  assert.equal(!!b.run("mutedUsers['bob']"), true);

  const broken = bench({ csg_engine: OAUTH_ENGINE });
  await booted(broken);
  broken.run('BULK.GAP_MS = 0');
  broken.run("upsertFt({ id: 'unreadable', author: 'eve', text: 'toxique', channel: 'twitch/a' }, { label: 'pending' })");
  broken.api.mode = () => 'prose';
  const failed = await broken.run('runBulkAudit()');
  assert.equal(failed.running, true, 'le lot reste actif pour la reprise automatique');
  assert.equal(failed.done, 0);
  assert.match(failed.err, /illisible.*reprise automatique/);
  assert.equal(broken.run("ftById.get('unreadable').label"), 'pending', 'pas de faux keep sur une réponse illisible');
  assert.equal(!!broken.run("mutedUsers['eve']"), false);

  const unlimited = bench({ csg_engine: OAUTH_ENGINE });
  await booted(unlimited);
  unlimited.run('FT.MAX = 2; FT.PERSIST_KEEP = 2');
  for (let i = 0; i < 5; i++) {
    unlimited.run(`upsertFt({ id: 'waiting-${i}', author: 'user-${i}', text: 'message ${i}', channel: 'twitch/a' }, { label: 'pending', source: 'one_click' })`);
  }
  assert.equal(unlimited.run('bulkCandidates().length'), 5, 'aucune capture en attente évincée par FT.MAX');
  assert.equal(unlimited.run('ftPersistRows().length'), 5, 'toutes les captures en attente survivent au redémarrage');

  // Mode local sans aucune clé API ni compte SuperGrok : le clic juge avec les règles locales.
  const localBench = bench({ csg_engine: {} });
  await booted(localBench);
  localBench.run("upsertFt({ id: 'loc-1', author: 'clean_user', text: 'gg wp belle game', channel: 'twitch/a' }, { label: 'pending' })");
  localBench.run("upsertFt({ id: 'loc-2', author: 'toxic_user', text: 'va crever fdp', channel: 'twitch/a' }, { label: 'pending' })");
  const localStatus = await localBench.run('runBulkAudit()');
  assert.equal(localStatus.running, false);
  assert.equal(localStatus.done, 2);
  assert.equal(localBench.api.calls.length, 0, 'zéro appel réseau en mode local');
  assert.equal(localBench.run("ftById.get('loc-1').label"), 'keep');
  assert.equal(localBench.run("ftById.get('loc-2').label"), 'mute');
  assert.equal(!!localBench.run("mutedUsers['toxic_user']"), true);

  console.log('one-click : capture seule, lot manuel, mode local sans clé, mots personnels, progression OK');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
