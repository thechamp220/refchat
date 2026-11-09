'use strict';

// Quitter Brave puis le relancer ne doit RIEN perdre : ni la file d'attente
// (lignes en attente, lots en vol, escalades, copies qui attendent le verdict
// de leur original), ni les compteurs du popup, ni le journal des verdicts, ni
// les stats de lane.
//
// Le banc charge background.js ENTIER. Son faux chrome.storage suit l'ordre de
// Chromium : chaque get/set agit dans l'ordre des appels, le rappel arrive plus
// tard. On « quitte » en gardant le disque, on « relance » un nouveau worker
// dessus, et l'onglet restaure parle AVANT la fin de la relecture : ses
// KEEPALIVE / ENQUEUE / FLUSH ecrivaient une file vide et des compteurs a zero
// que la relecture relisait ensuite.
//
//   node tests/check-relaunch.js
//   REFCHAT_BG=chemin/vers/ancien/background.js node tests/check-relaunch.js  (doit echouer)

const { bench, tick, checker } = require('./bench');

const st = checker();
const check = st.check;

async function settle() {
  for (let i = 0; i < 60; i++) await tick();
}

// Le worker ignore sans repondre un message dont l'expediteur ne colle pas :
// onglet Kick/Twitch pour le content script, page de l'extension sinon.
const CHAT_SENDER = { tab: { id: 7, url: 'https://kick.com/sim' } };
const PAGE_SENDER = { url: 'chrome-extension://refchat/popup.html' };
const FROM_CHAT = /^CSG_(KEEPALIVE|CAPTURE|ENQUEUE|FLUSH)$/;

function send(b, msg) {
  return new Promise((resolve) => {
    b.emit('runtime.onMessage', msg, FROM_CHAT.test(msg.type) ? CHAT_SENDER : PAGE_SENDER, resolve);
  });
}

// Une reponse qui ne vient jamais vide la boucle d'evenements : Node sortait
// alors en 0 au milieu du test, sans rien verifier.
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.log('\n ECHEC test interrompu : un message est reste sans reponse\n');
    process.exitCode = 1;
  }
});

// Capture au journal par content.js, puis mise en file. One-click : CSG_ENQUEUE
// ne met plus rien en file, seul le lot manuel appelle enqueueAudit.
async function line(b, author, text, id) {
  await send(b, { type: 'CSG_CAPTURE', author, text, id, channel: 'kick/sim', label: 'pending', source: 'pending' });
  return b.run('enqueueAudit')(author, text, { id, tabId: 7, channel: 'kick/sim' });
}

function take(b, id) {
  const q = b.run('auditQueue');
  const i = q.findIndex((it) => it.id === id);
  return i < 0 ? null : q.splice(i, 1)[0];
}

const LANE = { id: 'fake', canMuteAuthor: true };
const ids = (list) => (list || []).map((it) => it.id);
const ft = (b, id) => {
  const r = b.run('ftById.get(' + JSON.stringify(id) + ')');
  return r ? r.label + ':' + r.source : null;
};
const view = (b) => ({
  queue: b.run('queueToPersist().map((it) => it.id)'),
  counts: b.run('countsSnapshot()'),
  log: b.run('auditLog.length'),
  lane: b.run('laneStats[CHAIN[0].id] || null'),
  // Sans dupsToPersist (ancien code) : on lit la memoire, pour un ECHEC lisible.
  dups: b.run('Array.from(dupWaiters).map(([k, l]) => k + "=" + l.map((d) => d.id).join("+"))')
});

(async () => {
  console.log('\n--- 1re session : une file, des verdicts, un lot en vol ---');
  const b1 = bench({});
  await settle();
  for (let i = 1; i <= 7; i++) await line(b1, 'viewer' + i, 'message numero ' + i, 'L' + i);
  await line(b1, 'viewer1', 'message numero 1', 'C1'); // copie de L1 : attend son verdict
  await line(b1, 'spam', 'WHERE IS BLUCIFER', 'X');
  await line(b1, 'spam', 'WHERE IS BLUCIFER', 'X2'); // 2e cle en attente au meme moment
  check('deux originaux ont chacun leur copie en attente', b1.run('dupWaiters.size'), 2);

  b1.run('applyItemVerdict')(take(b1, 'L5'), { score: 0.92, tag: 'lot' }, 0.4, 900, LANE);
  b1.run('applyItemVerdict')(take(b1, 'L6'), { score: 0.05, tag: 'lot' }, 0.4, 900, LANE);
  b1.run('applyItemVerdict')(take(b1, 'L7'), { score: 0.06, tag: 'skip' }, 0.4, 900, LANE);
  b1.run('escalate')(take(b1, 'L2'), 0.55, 0.4, true);
  const batch = [take(b1, 'L3'), take(b1, 'L4')];
  b1.run('inflightJobs').set('job-test', { lane: b1.run('CHAIN[0]'), batch, startedAt: b1.run('Date.now()'), jobId: 'job-test' });
  const noteLaneStat = b1.run('noteLaneStat');
  const laneId = b1.run('CHAIN[0].id');
  noteLaneStat(laneId, 1200, true);
  noteLaneStat(laneId, 1800, true);
  noteLaneStat(laneId, 0, false);

  // Brave se ferme : ses fenetres partent, le worker est tue sans onSuspend.
  b1.emit('windows.onRemoved', 1);
  await settle();
  const before = view(b1);
  check('etat avant de quitter', before.queue, ['L3', 'L4', 'L2', 'L1', 'X']);
  check('  compteurs avant de quitter', [before.counts.judged, before.counts.accepted, before.counts.rejected, before.counts.skipped, before.counts.escalated], [3, 1, 1, 1, 1]);

  console.log('\n--- relance : l onglet restaure parle avant la relecture ---');
  const b2 = bench(b1.store, { sync: b1.sync });
  const early = [
    send(b2, { type: 'CSG_KEEPALIVE', channel: 'kick/sim', why: 'ok', captured: 1, last: { author: 'nouveau', text: 'bonsoir' } }),
    send(b2, { type: 'CSG_CAPTURE', author: 'viewer1', text: 'message numero 1', id: 'L1', channel: 'kick/sim', label: 'pending', source: 'pending' }),
    send(b2, { type: 'CSG_CAPTURE', author: 'nouveau', text: 'bonsoir le chat', id: 'N1', channel: 'kick/sim', label: 'pending', source: 'pending' }),
    // Ancien content script encore ouvert : son ENQUEUE ne doit rien casser.
    send(b2, { type: 'CSG_ENQUEUE', author: 'nouveau', text: 'bonsoir le chat', id: 'N1', channel: 'kick/sim' }),
    send(b2, { type: 'CSG_FLUSH' })
  ];
  const popup = send(b2, { type: 'CSG_AUDIT_STATS' });
  await settle();
  await Promise.all(early);
  const stats = await popup;
  const after = view(b2);
  // One-click : au reveil, l'ancienne file est versee dans le journal en attente
  // du prochain lot manuel, puis videe. Rien n'est perdu, rien n'est juge seul.
  check('la file est videe au reveil', after.queue, []);
  check('  chaque ligne en file attend au journal', before.queue.map((id) => ft(b2, id)), before.queue.map(() => 'pending:one_click'));
  check('  aucune n est abandonnee', before.queue.filter((id) => /^dropped/.test(ft(b2, id) || '')), []);
  check('  L1 recapturee au reveil n est pas en double', b2.run('ftLog.filter((r) => r.id === "L1").length'), 1);
  check('  la capture neuve est au journal', ft(b2, 'N1'), 'pending:one_click');
  check('analyses / acceptes / rejetes / ignores / escalades', [after.counts.judged, after.counts.accepted, after.counts.rejected, after.counts.skipped, after.counts.escalated], [3, 1, 1, 1, 1]);
  check('  en file : ni la capture ni l ancien ENQUEUE ne comptent', after.counts.enqueued, before.counts.enqueued);
  check('journal des verdicts', after.log, before.log);
  check('stats de lane', after.lane, before.lane);
  check('copies en attente', after.dups, before.dups);
  // En attente = captures pending du journal : L1-L4, X, leurs copies C1/X2, et N1.
  check('popup ouvert pendant la relecture : pas de zeros', [stats.judged, stats.waiting], [3, 8]);
  check('disque : la fusion est ecrite', ids(b2.store.csg_queue), after.queue);
  check('  avec ses compteurs', b2.store.csg_counts, after.counts);
  check('  et l instantane du popup', [b2.store.csg_audit && b2.store.csg_audit.judged, b2.store.csg_audit && b2.store.csg_audit.log.length], [3, before.log]);

  console.log('\n--- apres la relance, les copies recoivent le verdict de leur original ---');
  // Le lot manuel remet les originaux en file.
  await line(b2, 'viewer1', 'message numero 1', 'L1');
  await line(b2, 'spam', 'WHERE IS BLUCIFER', 'X');
  b2.run('applyItemVerdict')(take(b2, 'L1'), { score: 0.9, tag: 'lot' }, 0.4, 800, LANE);
  b2.run('applyItemVerdict')(take(b2, 'X'), { score: 0.04, tag: 'lot' }, 0.4, 800, LANE);
  check('copie de L1', ft(b2, 'C1'), 'mute:doublon');
  check('copie de X', ft(b2, 'X2'), 'keep:doublon');
  check('L1 recapturee apres la relance garde sa source', ft(b2, 'L1'), 'mute:llm');

  console.log('\n--- deuxieme relance : rien ne double ---');
  b2.emit('windows.onRemoved', 1);
  await settle();
  const quit2 = view(b2);
  const b3 = bench(b2.store, { sync: b2.sync });
  await settle();
  const again = view(b3);
  check('file identique', again.queue, quit2.queue);
  check('compteurs identiques, pas additionnes deux fois', again.counts, quit2.counts);
  check('stats de lane identiques', again.lane, quit2.lane);

  console.log('\n--- jugement coupe : le demarrage n efface plus la file ---');
  // loadPunishTarget appliquait judge:false avant la relecture, et le passage
  // true -> false ecrivait aussitot la file vide et des compteurs a zero.
  const b4 = bench(b1.store, { sync: { csg_settings: { judge: false } } });
  await settle();
  const off = view(b4);
  check('file versee au journal, pas effacee', before.queue.map((id) => ft(b4, id)), before.queue.map(() => 'pending:one_click'));
  check('compteurs intacts', off.counts, before.counts);

  console.log('\n--- un FLUSH qui reveille le worker n ecrase pas le disque ---');
  const b5 = bench(b1.store, { sync: b1.sync });
  await send(b5, { type: 'CSG_FLUSH' });
  check('disque intact avant la relecture', ids(b5.store.csg_queue), before.queue);
  await settle();
  check('puis la file passe au journal', before.queue.map((id) => ft(b5, id)), before.queue.map(() => 'pending:one_click'));

  console.log('\n--- fenetre fermee : la derniere ligne part sur disque tout de suite ---');
  const b6 = bench({});
  await settle();
  b6.advance(1000);
  await line(b6, 'a', 'premiere ligne', 'W1');
  await line(b6, 'b', 'deuxieme ligne', 'W2');
  // Plus de debounce a verifier ici : jugement live coupe, enqueueAudit ecrit
  // tout de suite (et seul le lot manuel l'appelle encore).
  b6.emit('windows.onRemoved', 1);
  check('fenetre fermee : les deux sont ecrites', ids(b6.store.csg_queue), ['W1', 'W2']);

  finished = true;
  console.log(st.fails ? '\n' + st.fails + ' ECHEC(S)\n' : '\ntout est vert\n');
  process.exit(st.fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
