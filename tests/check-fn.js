'use strict';
// Passe tests/fn-corpus.js dans le vrai keywords.js et classe chaque message
// selon ce que content.js en ferait :
//
//   FLAG     heavy | harsh | vitalityHate | brainrot  -> mute local immediat
//   HARD_FN  trivial | clean                          -> KEEP sec, le modele ne
//                                                        voit JAMAIS le message
//   SOFT_FN  aucun flag                               -> part en file LLM, donc
//                                                        passe si l'API est HS,
//                                                        en quota ou sans cle
//
// Usage :  node tests/check-fn.js          synthese + listes
//          node tests/check-fn.js --json   dump machine

globalThis.self = globalThis;
const path = require('path');
require(path.join(__dirname, '..', 'keywords.js'));
const K = globalThis.CSG_KEYWORDS;
const corpus = require('./fn-corpus.js');

function classify(text) {
  const v = K.analyze(text);
  const flags = ['heavy', 'harsh', 'vitalityHate', 'brainrot'].filter((f) => v[f]);
  if (flags.length) return { verdict: 'FLAG', by: flags.join('+') };
  if (v.trivial) return { verdict: 'HARD_FN', by: 'trivial' };
  if (v.clean) return { verdict: 'HARD_FN', by: 'clean' };
  // susp = tag de suspicion : priorite + indice (hint) pour le modele, ET mute
  // local de repli quand l'API est HS (recycleBatch, seuil <= 0.6).
  return { verdict: 'SOFT_FN', by: v.susp ? 'susp:' + (v.hint || '?') : 'LLM' };
}

const rows = corpus.map(([cat, text]) => ({ cat, text, ...classify(text) }));
// 'contexte' : jetons anodins seuls (F, xD, oui), toxiques seulement en rafale ;
// c'est content.js (noteBurst) qui les route, pas analyze(). Comptes a part.
const ctxRows = rows.filter((r) => r.cat === 'contexte');
const toxic = rows.filter((r) => r.cat !== 'CLEAN' && r.cat !== 'CLEAN-KNOWN' && r.cat !== 'contexte');
const clean = rows.filter((r) => r.cat === 'CLEAN');
const falsePos = clean.filter((r) => r.verdict === 'FLAG');
// CLEAN-KNOWN : faux positifs documentés et non corrigeables dans keywords.js.
// Reportés mais hors code de sortie, sinon la régression est rouge en continu.
const known = rows.filter((r) => r.cat === 'CLEAN-KNOWN' && r.verdict === 'FLAG');
const by = (v) => toxic.filter((r) => r.verdict === v);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 1));
  process.exit(0);
}

// Ce fichier produisait des tableaux sans jamais dire ce qu'il etait en train
// de faire ni conclure : lance dans la suite, il paraissait ne rien tester.
// Meme format que les autres desormais — etapes annoncees, verdicts nommes.
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

console.log('\n=== check-fn : le filtre local, sans reseau ===');
console.log(corpus.length + ' messages de fn-corpus.js passes dans keywords.js et classes');
console.log('comme le ferait content.js. Aucun modele n est appele ici.');
console.log('  FLAG     = mute local immediat, le message ne part jamais');
console.log('  SOFT_FN  = part en file LLM, donc passe si l API est HS');
console.log('  HARD_FN  = keep sec, le modele ne le voit JAMAIS');

console.log('\n--- couverture : ce que le filtre local attrape seul ---');
const pct = (n) => Math.round((n / toxic.length) * 100) + '%';
console.log(toxic.length + ' messages toxiques dans le corpus');
console.log('FLAG     ' + String(by('FLAG').length).padStart(3) + '  ' + pct(by('FLAG').length) + '   mute local');
const softSusp = by('SOFT_FN').filter((r) => r.by.startsWith('susp')).length;
console.log('SOFT_FN  ' + String(by('SOFT_FN').length).padStart(3) + '  ' + pct(by('SOFT_FN').length) + '   depend du LLM (dont ' + softSusp + ' tagges susp = mutes si API HS)');
console.log('HARD_FN  ' + String(by('HARD_FN').length).padStart(3) + '  ' + pct(by('HARD_FN').length) + '   keep sec, jamais juge');
console.log('contexte ' + String(ctxRows.length).padStart(3) + '       jetons anodins seuls, routes par la rafale (hors total)');
console.log('\n--- regression : le filtre ne doit muter aucun message sain ---');
// C est LA garantie du fichier. Un faux positif ici, c est un innocent mute
// sans qu aucun modele n ait eu son mot a dire.
check('aucun faux positif sur les ' + clean.length + ' messages CLEAN', falsePos.length, 0);
falsePos.forEach((r) => console.log('        [FP ' + r.by + '] ' + r.text));
if (known.length) {
  console.log('  (' + known.length + ' faux positifs CLEAN-KNOWN, documentes et hors code de sortie)');
  known.forEach((r) => console.log('        [structurel · ' + r.by + '] ' + r.text));
}

console.log('\n--- non flagges par categorie ---');
console.log('HARD_FN = jamais vu par le modele (le risque reel). SOFT_FN = part au');
console.log('modele, c est le fonctionnement prevu — pas une alarme en soi.');
for (const c of [...new Set(toxic.map((r) => r.cat))]) {
  const sub = toxic.filter((r) => r.cat === c);
  // Le barregraphe melangeait HARD_FN (jamais vu par le modele, le vrai risque)
  // et SOFT_FN (part au modele, c'est le fonctionnement prevu). Un score
  // "12/13" a fait croire a un trou alors que c'etait 12 SOFT_FN et 0 HARD_FN —
  // la categorie marchait comme concu. Les deux sont maintenant separes, et
  // seul HARD_FN dessine une barre : c'est la seule qui doit alarmer.
  const hard = sub.filter((r) => r.verdict === 'HARD_FN').length;
  const soft = sub.filter((r) => r.verdict === 'SOFT_FN').length;
  const mark = hard ? '⚠' : ' ';
  console.log(
    mark + ' ' + c.padEnd(22) +
    'HARD_FN ' + String(hard).padStart(2) + '  SOFT_FN ' + String(soft).padStart(2) +
    ' / ' + String(sub.length).padStart(3) +
    '  ' + '!'.repeat(hard)
  );
}

console.log('\n--- HARD_FN : toxiques que le modele ne verra JAMAIS ---');
console.log('Ecartes en local comme anodins. Aucun rattrapage possible ensuite.');
by('HARD_FN').forEach((r) => console.log('  [' + r.cat + '/' + r.by + '] ' + r.text));

console.log('\n--- SOFT_FN : toxiques qui passent si l API est HS ---');
by('SOFT_FN').forEach((r) => console.log('  [' + r.cat + '] ' + r.text));

const polRows = rows.filter((r) => r.cat === 'politique');
const polHard = polRows.filter((r) => r.verdict === 'HARD_FN');
const polFlag = polRows.filter((r) => r.verdict === 'FLAG');
console.log('\n--- politique : doit TOUJOURS passer par le modele ---');
// Ni mute local (trop grossier pour du politique), ni keep sec (ce serait le
// laisser filer). Les deux extremes sont des erreurs, seul SOFT_FN est correct.
console.log(polRows.length + ' messages politiques · ' + polRows.filter((r) => r.verdict === 'SOFT_FN').length + ' correctement routes vers le LLM');
check('aucun politique ecarte en local (HARD_FN)', polHard.length, 0);
polHard.forEach((r) => console.log('        [HARD_FN ' + r.by + '] ' + r.text));
check('aucun politique mute en local (FLAG)', polFlag.length, 0);
polFlag.forEach((r) => console.log('        [FLAG ' + r.by + '] ' + r.text));

console.log(fails ? '\n' + fails + ' ECHEC(S)\n' : '\ntout est vert\n');
// Sortie non-zero si le set CLEAN regresse : utilisable en pre-commit.
process.exit(fails ? 1 : 0);
