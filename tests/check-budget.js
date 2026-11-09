'use strict';

// Budget de sortie du juge, et le compteur qui masquait la panne.
//
// Symptome rapporte : toutes les lanes au vert, 194 analyses, 194 ACCEPTES,
// 0 rejete, et un chat ouvertement toxique qui passe entier.
//
// Chaine reelle :
//   judgeParts    budgetait 22 + 4N tokens, calcule au token pres sur un JSON
//                 minimal. Lot de 24 : ~107 tokens necessaires, 118 accordes.
//   le modele     ajoute une cloture ```json / des espaces / un <thought>
//   -> reponse TRONQUEE
//   parseJsonLoose exige l accolade fermante -> null
//   parseBatchVerdicts -> keepBit('skip') pour TOUT le lot
//   applyItemVerdict -> le else final comptait chaque skip en ACCEPT
//
// Resultat : un filtre qui n a rien lu affiche 100% d acceptation.

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

globalThis.THINK_RE = /<(?:think|thought|reasoning)>[\s\S]*?<\/(?:think|thought|reasoning)>/gi;
globalThis.llmOnly = false;
globalThis.localVerdictsOn = () => !globalThis.llmOnly;

const code = [
  between('function parseJsonLoose', '\nfunction parseMuteSet'),
  between('function parseMuteSet', '\nfunction localToxic'),
  between('function localToxic(text)', '\nfunction parseBatchVerdicts'),
  between('function parseBatchVerdicts', '\n// Gemma (et Gemini'),
  'Object.assign(globalThis, { parseJsonLoose, parseMuteSet, parseBatchVerdicts, verdictBit, keepBit });'
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

// --- 1. le budget ----------------------------------------------------------
// Formule extraite du source, pas recopiee : si quelqu un la resserre, ce
// fichier casse.
const line = src.match(/const maxTok = Math\.max\((\d+), (\d+) \+ n \* (\d+)\)/);
if (!line) throw new Error('formule maxTok introuvable dans judgeParts');
const [, floor, base, per] = line.map(Number);
const maxTok = (n) => Math.max(floor, base + n * per);

// Cout reel d une reponse. Un booleen JSON + sa virgule = 2 tokens chez tous
// les tokenizers BPE courants ; la structure {"v":[ ],"p":[ ]} en vaut ~12.
// On facture en plus ce que les modeles ajoutent VRAIMENT dans la vraie vie.
function cost(n, opts) {
  const o = opts || {};
  let t = 12 + n * 2 * 2;
  if (o.fence) t += 5; // ```json … ```
  if (o.spaces) t += n * 2; // « false, false » au lieu de « false,false »
  return t;
}

console.log('\n=== check-budget : le juge doit pouvoir FINIR sa phrase ===');
console.log('\n--- le budget couvre les reponses reelles ---');
for (const n of [8, 12, 16, 20, 24]) {
  const need = cost(n, { fence: true, spaces: true });
  check(
    'lot de ' + n + ' : ' + maxTok(n) + ' tokens accordes, ' + need + ' necessaires (fence + espaces)',
    maxTok(n) >= need,
    true
  );
}
// La regression precise : l ancienne formule ne passait PAS le lot de 24.
const old = (n) => Math.max(32, 22 + n * 4);
check("l'ancienne formule echouait bien sur un lot de 24", old(24) >= cost(24, { fence: true, spaces: true }), false);

console.log('\n--- marge : au moins 40% au-dessus du JSON minimal ---');
for (const n of [8, 24]) {
  check('lot de ' + n, maxTok(n) >= cost(n) * 1.4, true);
}

// --- 2. une reponse tronquee ne doit jamais passer pour un CLEAR ------------
console.log('\n--- reponse tronquee : skip, jamais accept ---');
const items = [
  { id: 'a1', a: 'x', t: 'ferme ta gueule sale merde' },
  { id: 'a2', a: 'y', t: 'gg les gars' }
];
// Ce que renvoie une reponse coupee en plein vol par max_output_tokens.
const tronque = '{"v":[true,false],"p":[fal';
check('JSON tronque = illisible', globalThis.parseJsonLoose(tronque), null);
const bits = globalThis.parseBatchVerdicts(tronque, items);
check('tout le lot est marque skip', bits.map((b) => b.tag), ['skip', 'skip']);

// C est la ligne exacte qui manquait dans applyItemVerdict.
const compte = (r) => (r.tag === 'skip' || r.tag === 'timeout' ? 'skip' : r.score >= 0.4 ? 'reject' : 'accept');
check('un skip ne compte pas comme accepte', bits.map(compte), ['skip', 'skip']);
check(
  "applyItemVerdict distingue bien le skip",
  /r\.tag === 'skip' \|\| r\.tag === 'timeout'/.test(between('function applyItemVerdict', '\nfunction holdWait')),
  true
);

console.log('\n--- reponse complete : les verdicts passent ---');
// Le contrat actuel exige le JSON strict du schéma, sans balise Markdown.
const entier = '{"v":[true,false],"p":[false,false]}';
const ok = globalThis.parseBatchVerdicts(entier, items);
check('la ligne toxique est coupee', ok.map(compte), ['reject', 'accept']);
check('JSON dans une balise Markdown reste sans verdict',
  globalThis.parseBatchVerdicts('```json\n' + entier + '\n```', items).map(compte), ['skip', 'skip']);

console.log('\n--- /responses : le budget couvre le RAISONNEMENT, pas seulement la sortie ---');
// Sur /responses, max_output_tokens plafonne raisonnement + sortie ENSEMBLE.
// Mesures reelles contre l API OpenCode (sonde, 2026-09-10), muse-spark-1.2
// avec reasoning.effort='minimal', 14 appels, contexte de 30 lignes inclus :
//
//   lot de 4  : 115-116 tokens de raisonnement
//   lot de 8  : 158-193 (muse-spark-1.3, effort 'low')
//   lot de 24 : 339, 351, 411, 422, 429, 430, 437, 440, 442, 450, 452, 476, 533, 535
//
// Le PIC est a 535, soit 23 tokens de plus que l ancien budget TOTAL de 512.
// C est la mesure qui compte, pas la moyenne : a 512 accordes, un appel sur
// deux repartait en `incomplete:max_output_tokens` avec zero token de sortie.
// Sans reasoning du tout : 509-520 des le lot de 4, et 0 token utile.
const REASON_TOK = Number((src.match(/const REASON_TOK = (\d+)/) || [])[1] || 0);
const REASON_PER_ITEM = Number((src.match(/const REASON_PER_ITEM = (\d+)/) || [])[1] || 0);
check('une reserve de raisonnement existe', REASON_TOK > 0, true);
check('et elle grandit avec le lot', REASON_PER_ITEM > 0, true);

const PICS = { 4: 116, 8: 193, 24: 535 };
const respTok = (n) => maxTok(n) + REASON_TOK + n * REASON_PER_ITEM;
for (const n of Object.keys(PICS).map(Number)) {
  const besoin = PICS[n] + cost(n, { fence: true, spaces: true });
  check(
    'lot de ' + n + ' : ' + respTok(n) + ' accordes, pic mesure ' + PICS[n] +
      ' + sortie ' + cost(n, { fence: true, spaces: true }) + ' = ' + besoin,
    respTok(n) >= besoin,
    true
  );
  check('  et au moins 2x de marge sur le pic', respTok(n) >= besoin * 2, true);
}
// La regression exacte : le forfait seul ne passait PAS le pic du lot de 24.
check(
  "l'ancien forfait de 320 echouait sur le pic reel",
  maxTok(24) + 320 >= PICS[24] + cost(24, { fence: true, spaces: true }),
  false
);
check(
  'la reserve est bien branchee sur /responses',
  /thinkBudget\(lane, n\)/.test(between('function judgeParts', '\nfunction judgeBody')),
  true
);
check(
  "et le raisonnement est coupe explicitement",
  /body\.reasoning = lane\.reasoning \|\| \{ effort: 'minimal' \}/.test(src),
  true
);

console.log('\n--- un lot illisible repart, il ne disparait pas ---');
// Avant : tryLane rendait 24 'skip', runLaneJob les appliquait, et 24 messages
// etaient perdus sans que personne ne les ait lus. recycleBatch ne pouvait pas
// rattraper : il ne vit que dans le catch, et un lot illisible ne LEVE PAS.
const rj = between('function rejudgeBatch', '\nasync function runLaneJob');
check('rejudgeBatch existe', rj.length > 0, true);
check('  il ne se declenche que si TOUT le lot est skip', /results\.every\(\(r\) => r && r\.tag === 'skip'\)/.test(rj), true);
check('  il compte les essais par message', /it\.rj = \(Number\(it\.rj\) \|\| 0\) \+ 1/.test(rj), true);
check('  il plafonne les reprises', /it\.rj <= REJUDGE_MAX/.test(rj), true);
check('  il met la lane fautive en pause', /skipLane\(lane\.id, REJUDGE_PAUSE_MS/.test(rj), true);
check('  il remet le lot en file', /auditQueue\.unshift\(again\[i\]\)/.test(rj), true);
check('  essais epuises -> on assume le skip', /behLog\('rejudge_abandon'/.test(rj), true);
check(
  'runLaneJob sort avant d appliquer le moindre verdict',
  /if \(rejudgeBatch\(lane, batch, results\)\) return;[\s\S]{0,200}applyItemVerdict/.test(src),
  true
);
const REJUDGE_MAX = Number((src.match(/const REJUDGE_MAX = (\d+)/) || [])[1] || 0);
check('le plafond de reprises est fini', REJUDGE_MAX > 0 && REJUDGE_MAX <= 3, true);

console.log(fails ? '\n' + fails + ' ECHEC(S)' : '\ntout est vert');
process.exit(fails ? 1 : 0);
