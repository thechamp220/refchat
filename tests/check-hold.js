'use strict';

// Fenetre d'accumulation des lots, et diagnostic des lots illisibles.
//
// HOLD_MS etait a 0 : chaque tour de pompe expediait ce qu'il avait sous la
// main. Sur un chat moyen, des lots de 2-3 messages alors que les lanes en
// acceptent 16 a 24 — un creneau RPM complet brule pour trois lignes.
//
// La correction a deux declencheurs, et les DEUX comptent : la fenetre (le lot
// se remplit) et le lot plein (en hype, ne pas attendre pour rien).

globalThis.self = globalThis;
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

function between(a, b) {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('bloc introuvable : ' + a);
  return src.slice(i, j);
}

// AUDIT est lu DEPUIS le source : si quelqu un remet HOLD_MS a 0, ce fichier casse.
globalThis.auditQueue = [];
globalThis.CHAIN = [];
globalThis.soleLaneId = () => '';
globalThis.liveLane = (l) => l;
globalThis.laneBatch = (lane) => {
  const n = Number(lane && lane.batch);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const code = [
  between('const AUDIT = {', '\n// Escalade fast'),
  between('function holdCap', '\nfunction takeAuditBatch'),
  between('function finishReason', '\nfunction noteSkipSample'),
  'Object.assign(globalThis, { AUDIT, holdCap, holdWait, finishReason });'
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

const A = globalThis.AUDIT;
const now = () => Date.now();
function seed(n, ageMs) {
  globalThis.auditQueue.length = 0;
  for (let i = 0; i < n; i++) globalThis.auditQueue.push({ t: 'msg' + i, ts: now() - (ageMs || 0) });
}

console.log('\n=== check-hold : remplir les lots au lieu de bruler des creneaux ===');

console.log('\n--- la fenetre existe ---');
check('HOLD_MS n est plus a zero', A.HOLD_MS > 0, true);
check('HOLD_MS reste sous la seconde (juge unique : inference 2-7 s derriere)', A.HOLD_MS <= 1000, true);
check('HOLD_MS ne redescend pas sous 400 ms (sinon lots de 1-2)', A.HOLD_MS >= 400, true);
check('HOLD_MAX repli = sweet spot 16', A.HOLD_MAX, 16);

console.log('\n--- declencheur 1 : le lot attend qu il se remplisse ---');
seed(0);
check('file vide -> rien a attendre', globalThis.holdWait(), 0);
seed(3, 0);
check('3 messages tout frais -> on attend', globalThis.holdWait() > 0, true);
seed(3, A.HOLD_MS + 50);
check('3 messages assez vieux -> on part', globalThis.holdWait(), 0);

console.log('\n--- declencheur 2 : lot plein, on ne fait pas attendre ---');
seed(A.HOLD_MAX, 0);
check('lot plein et tout frais -> on part quand meme', globalThis.holdWait(), 0);
seed(A.HOLD_MAX - 1, 0);
check('juste en dessous du plein -> on attend encore', globalThis.holdWait() > 0, true);
seed(A.HOLD_MAX * 4, 0);
check('hype : file qui deborde -> on part', globalThis.holdWait(), 0);

console.log('\n--- holdCap suit le juge unique, pas le max de la chaine ---');
globalThis.CHAIN = [{ id: 'gemma-4-26b-a4b-it', batch: 8 }];
globalThis.soleLaneId = () => 'gemma-4-26b-a4b-it';
check('Gemma batch 8', globalThis.holdCap(), 8);
seed(8, 0);
check('8 lignes fraiches = lot Gemma plein -> on part', globalThis.holdWait(), 0);
seed(7, 0);
check('7 lignes = pas encore plein -> on attend', globalThis.holdWait() > 0, true);
globalThis.CHAIN = [{ id: 'gemini-3.5-flash-lite', batch: 16 }];
globalThis.soleLaneId = () => 'gemini-3.5-flash-lite';
check('Flash-Lite batch 16', globalThis.holdCap(), 16);
seed(8, 0);
check('8 lignes ne remplissent pas un Flash-Lite -> on attend', globalThis.holdWait() > 0, true);
seed(16, 0);
check('16 lignes = lot Flash-Lite plein -> on part', globalThis.holdWait(), 0);
globalThis.CHAIN = [];
globalThis.soleLaneId = () => '';
check('sans lane : repli HOLD_MAX', globalThis.holdCap(), A.HOLD_MAX);

console.log('\n--- le gain reel, selon le debit du chat ---');
// Sans fenetre la pompe repart toutes les ~40 ms, donc elle emporte ~1 message
// par appel quel que soit le debit. Avec la fenetre elle emporte HOLD_MS de
// trafic, plafonne par le `batch` de la lane.
//
// Le gain vaut donc exactement debit x fenetre. A 1 msg/s avec une fenetre de
// 1 s, il n y a AUCUN gain : un message par lot dans les deux cas. C est
// attendu — un chat lent ne sature aucun quota, il n y a rien a economiser.
// Le gain apparait quand le chat s emballe, c est-a-dire quand il sert.
const MSGS = 120;
function appels(parSec, withHold) {
  const lot = withHold ? Math.min(A.HOLD_MAX, Math.max(1, Math.round((A.HOLD_MS / 1000) * parSec))) : 1;
  return Math.ceil(MSGS / lot);
}
for (const parSec of [1, 5, 12, 30]) {
  const avant = appels(parSec, false);
  const apres = appels(parSec, true);
  const label = parSec + ' msg/s : ' + avant + ' -> ' + apres + ' appels';
  if (parSec === 1) check(label + ' (chat lent : aucun gain attendu)', apres === avant, true);
  else check(label, apres < avant, true);
}
check('chat charge (30 msg/s) : au moins 12x moins d appels', appels(30, false) / appels(30, true) >= 12, true);

console.log('\n--- finish_reason : le champ qui tranche pour les lots illisibles ---');
check('troncature par le budget', globalThis.finishReason({ choices: [{ finish_reason: 'length' }] }), 'length');
check('le modele a fini sa phrase', globalThis.finishReason({ choices: [{ finish_reason: 'stop' }] }), 'stop');
check(
  '/responses incomplet',
  globalThis.finishReason({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
  'incomplete:max_output_tokens'
);
check('/responses complet', globalThis.finishReason({ status: 'completed' }), 'completed');
check('reponse vide -> pas de raison', globalThis.finishReason(null), '');

console.log('\n--- la capture est bien branchee sur le lot integralement skip ---');
const lane = between('const raw = messageText(data);', 'noteLaneStat');
check("tryLane echantillonne quand tout est 'skip'", /every\(\(r\) => r && r\.tag === 'skip'\)/.test(lane), true);
check('  et appelle noteSkipSample', /noteSkipSample\(lane, raw, items\.length, data\)/.test(lane), true);
const note = between('function noteSkipSample', '\nasync function tryLane');
for (const champ of ['lane:', 'finish:', 'len:', 'raw:']) {
  check("l'echantillon garde " + champ, note.indexOf(champ) !== -1, true);
}
check('il est persiste dans csg_skips', /csg_skips: skipSamples/.test(note), true);

console.log('\n--- la vue de diagnostic retirée du dashboard ---');
const bjs = fs.readFileSync(path.join(ROOT, 'board.js'), 'utf8');
const bhtml = fs.readFileSync(path.join(ROOT, 'board.html'), 'utf8');
check('board.js lit csg_skips', /csg_skips: \[\]/.test(bjs), true);
check("l'onglet Ignorés est absent", /data-tab="skips"/.test(bhtml), false);
check("l'ancienne vue est inaccessible", /id="tab-skips"[^>]*\bhidden\b/.test(bhtml), true);
check('le popup ne renvoie plus vers cet onglet', /onglet Ignorés/.test(fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8')), false);
check('elle ne se rafraichit plus toute seule', /changes\.csg_skips/.test(bjs), false);
check("elle n'est plus chargee au demarrage", /^loadSkips\(\);$/m.test(bjs), false);

console.log('\n--- familles de mutes ---');
const kindAt = bjs.indexOf('function muteKind');
const kindFn = new Function(bjs.slice(kindAt, bjs.indexOf('function chanLabel', kindAt)) + '\nreturn muteKind;')();
check('modele evident = IA', kindFn({ strikes: 'évident' }), 'ia');
check('reprise = IA', kindFn({ strikes: 'reprise 4.7' }), 'ia');
check('direct = IA', kindFn({ strikes: 'direct' }), 'ia');
check('suivi auteur', kindFn({ strikes: 'suivi auteur toxique · 4msgs' }), 'suivi');
check('liste locale', kindFn({ strikes: 'liste locale' }), 'local');
check('politique', kindFn({ strikes: 'politique' }), 'pol');

console.log(fails ? '\n' + fails + ' ECHEC(S)' : '\ntout est vert');
process.exit(fails ? 1 : 0);
