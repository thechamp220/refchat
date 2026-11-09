'use strict';

// File bloquee sans cle.
//
// Symptome : « ca bloque a 39 dans la liste d'attente et ca ne fait rien ».
// pumpAudit sortait sur `!hasAnyKey` en laissant la file intacte, et le repli
// local (recycleBatch) vivait dans le catch de runLaneJob — donc inatteignable
// tant qu'aucun appel n'etait TENTE. Sans cle, aucun appel n'est jamais tente :
// la file se figeait telle quelle, indefiniment, zero verdict, zero coupe.
//
// Ce fichier fige le repli : sans cle, la liste locale vide la file. Ce qui
// doit y rester (politique, mode 100% LLM) y reste.

globalThis.self = globalThis;
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'keywords.js'));

const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

function between(a, b) {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('bloc introuvable : ' + a);
  return src.slice(i, j);
}

// --- doublures -------------------------------------------------------------
// On garde le VRAI localToxic / looksSuspicious / recycleBatch / drainQueueLocally.
// Seul ce qui sort du module (persistance, journal, verdict applique) est double.
const applied = [];
globalThis.thresholdCache = 0.4;
globalThis.auditQueue = [];
globalThis.llmOnly = false;
globalThis.localVerdictsOn = () => !globalThis.llmOnly;
globalThis.persistQueueSoon = () => {};
globalThis.behLog = () => {};
globalThis.verdictBit = () => ({ tag: 'local', score: 0.99, pol: false });
globalThis.keepBit = (tag) => ({ tag, score: 0, pol: false });
globalThis.applyItemVerdict = (it, bit) => applied.push({ t: it.t, mute: bit.score >= 0.4 });

const code = [
  between('function localToxic(text)', '\nfunction parseBatchVerdicts'),
  between('// Vide la file par la liste locale', '\nasync function runLaneJob'),
  'Object.assign(globalThis, { drainQueueLocally, recycleBatch, localToxic, looksSuspicious });'
].join('\n');

// eslint-disable-next-line no-eval
eval(code);

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(
    (ok ? '  ok  ' : ' FAIL ') +
      name +
      (ok ? '' : '\n        obtenu  ' + JSON.stringify(got) + '\n        attendu ' + JSON.stringify(want))
  );
}

function seed(items) {
  globalThis.auditQueue.length = 0;
  applied.length = 0;
  for (const it of items) globalThis.auditQueue.push(it);
}

console.log('\n=== check-drain : la file ne doit jamais se figer sans cle ===');

console.log('\n--- le cas signale : 39 messages bloques ---');
// Un chat reel : des insultes franches, du bruit, de l anodin.
const q = [];
for (let i = 0; i < 13; i++) q.push({ a: 'u' + i, t: 'ferme ta gueule sale merde', id: 'x' + i });
for (let i = 0; i < 13; i++) q.push({ a: 'v' + i, t: 'gg les gars belle map', id: 'y' + i });
for (let i = 0; i < 13; i++) q.push({ a: 'w' + i, t: 'il joue vraiment mal ce bot', id: 'z' + i });
seed(q);
check('39 en file au depart', globalThis.auditQueue.length, 39);
const out = globalThis.drainQueueLocally();
check('la file est videe', globalThis.auditQueue.length, 0);
check('39 messages tranches', out, 39);
check('39 verdicts appliques', applied.length, 39);
const mutes = applied.filter((r) => r.mute).length;
check('les insultes sont coupees', mutes >= 13, true);
check('les messages sains sont rendus', applied.filter((r) => !r.mute).length >= 13, true);

console.log('\n--- ce qui doit RESTER en file ---');
seed([
  { a: 'a', t: 'macron demission', id: 'p1', pol: true },
  { a: 'b', t: 'ferme ta gueule sale merde', id: 'p2' }
]);
globalThis.drainQueueLocally();
check('la politique reste au modele', globalThis.auditQueue.map((it) => it.id), ['p1']);
check('le reste est tranche', applied.length, 1);

console.log('\n--- mode 100% LLM : le repli local est desactive ---');
globalThis.llmOnly = true;
seed([{ a: 'a', t: 'ferme ta gueule sale merde', id: 'k1' }]);
const n = globalThis.drainQueueLocally();
check('rien n est tranche en local', n, 0);
check('la file est intacte', globalThis.auditQueue.length, 1);
check('aucun verdict applique', applied.length, 0);
globalThis.llmOnly = false;

console.log('\n--- file vide : pas de travail inutile ---');
seed([]);
check('drain sur file vide', globalThis.drainQueueLocally(), 0);

console.log(fails ? '\n' + fails + ' ECHEC(S)' : '\ntout est vert');
process.exit(fails ? 1 : 0);
