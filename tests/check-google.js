'use strict';

// Lanes Google (Gemini / Gemma). Tout ce qui est verifie ici a d'abord ete
// MESURE contre l'API reelle ; le test fige ces observations pour qu'une
// retouche du corps de requete ou du parsing ne les reperde pas.
//
// Rappel de ce qui a casse une fois : Google repond 400 « Request contains an
// invalid argument » quand un CHAMP est refuse. L'ancien test de cle cherchait
// le mot « invalid » n'importe ou dans le corps -> toutes les lanes Google
// passaient en « cle refusee » 5 min alors que la cle etait bonne.

const fs = require('fs');
const path = require('path');

const P = path.join(__dirname, '..', 'background.js');
const src = fs.readFileSync(P, 'utf8');

function between(a, b) {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('bloc introuvable dans background.js : ' + a);
  return src.slice(i, j);
}

const code = [
  between('const GOOGLE_URL', 'function resolveGoogleModels'),
  between('const laneQuirks', 'async function chatCall'),
  between('function chatBody', '\nfunction openLanes'),
  between('function stripThought', '\nfunction abortInflight'),
  'var ALL_LANES = ' + between('const ALL_LANES = [', '\nconst CHAIN = ').replace('const ALL_LANES = ', ''),
  'var CHAIN = ALL_LANES;'
]
  .join('\n')
  .replace(/\bconst (laneQuirks|laneUse|GOOGLE_URL|GOOGLE_EFFORT|GLM_URL)\b/g, 'var $1');

const GO_URL = 'go';
const ZEN_URL = 'zen';
// Le fichier est en mode strict : un eval y a sa propre portee, donc on
// republie explicitement ce dont le test se sert.
// eslint-disable-next-line no-eval
eval(
  code +
    '\n;Object.assign(globalThis, { CHAIN, chatBody, chatQuirk, pickGoogleModel, laneBudgetWait, noteLaneUse, noteLaneTokens, stripThought, messageText, laneQuirks });'
);
const { CHAIN, chatBody, chatQuirk, pickGoogleModel, laneBudgetWait, noteLaneUse, noteLaneTokens, stripThought, messageText, laneQuirks } = globalThis;

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (ok ? '' : '\n        obtenu ' + JSON.stringify(got) + '\n        attendu ' + JSON.stringify(want)));
}

// ---------------------------------------------------------------- cle morte
const keyRe = eval(src.match(/if \(res\.status === 401 \|\| res\.status === 403 \|\| (\/.*?\/i)\.test\(t\)\)/)[1]);
const isKeyErr = (status, body) => status === 401 || status === 403 || keyRe.test(body);

console.log('\n--- 400 : cle morte ou champ refuse ? (reponses mesurees) ---');
check('cle morte -> cle morte', isKeyErr(400, '{"error":{"message":"Please pass a valid API key"}}'), true);
check('champ refuse -> PAS cle morte', isKeyErr(400, '{"error":{"message":"Request contains an invalid argument."}}'), false);
check('champ inconnu -> PAS cle morte', isKeyErr(400, '{"error":{"message":"Invalid JSON payload received. Unknown name \\"google\\""}}'), false);
check('modele retire -> PAS cle morte', isKeyErr(404, '{"error":{"message":"no longer available to new users"}}'), false);
check('surcharge -> PAS cle morte', isKeyErr(503, '{"error":{"message":"The model is overloaded."}}'), false);
check('quota -> PAS cle morte', isKeyErr(429, '{"error":{"message":"Resource has been exhausted"}}'), false);
check('API_KEY_INVALID -> cle morte', isKeyErr(400, '{"details":[{"reason":"API_KEY_INVALID"}]}'), true);
check('401 -> cle morte', isKeyErr(401, ''), true);

// ------------------------------------------------------------- corps envoye
console.log('\n--- corps /chat/completions ---');
const lite = CHAIN.find((l) => l.id === 'gemini-3.5-flash-lite');
const b = chatBody(lite, 'SYS', 'USER', 38);
check('reasoning_effort minimal', b.reasoning_effort, 'minimal');
check('pas de extra_body (refuse en 400)', b.extra_body === undefined, true);
check('pas de bloc google racine (refuse en 400)', b.google === undefined, true);
check('role system conserve', b.messages.map((m) => m.role), ['system', 'user']);
check('marge de 1024 tokens', b.max_tokens, 38 + 1024);

// Plus aucune lane effort:false depuis le retrait de 3.7 Flash : lane factice.
const noEffort = Object.assign({}, lite, { id: 'fake-no-effort', effort: false });
check('lane effort:false -> champ absent', chatBody(noEffort, 'S', 'U', 10).reasoning_effort === undefined, true);

laneQuirks[lite.id] = { noeffort: true, nosys: true };
const b2 = chatBody(lite, 'SYS', 'USER', 38);
check('quirk noeffort retire le champ', b2.reasoning_effort === undefined, true);
check('quirk nosys fusionne dans user', b2.messages, [{ role: 'user', content: 'SYS\n\nUSER' }]);
delete laneQuirks[lite.id];

// un 400 opaque doit quand meme declencher les deux essais, dans l'ordre
console.log('\n--- apprentissage sur 400 opaque ---');
const opaque = new Error('llm_http_400 {"error":{"message":"Request contains an invalid argument."}}');
const tried = {};
const q1 = chatQuirk(opaque, tried);
tried[q1] = true;
const q2 = chatQuirk(opaque, tried);
tried[q2] = true;
check('1er essai retire reasoning_effort', q1, 'noeffort');
check('2e essai retire le role system', q2, 'nosys');
check('3e essai : on abandonne', chatQuirk(opaque, tried), '');
check('500 : aucun apprentissage', chatQuirk(new Error('llm_http_500 boom'), {}), '');

// --------------------------------------------------------- ids des modeles
console.log('\n--- resolution des ids (liste reelle de l API) ---');
const ids = [
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemma-4-26b-a4b-it',
  'gemma-4-31b-it'
];
check('id exact', pickGoogleModel('gemini-3.5-flash-lite', ids), 'gemini-3.5-flash-lite');
check('suffixe -preview', pickGoogleModel('gemini-3-flash', ids), 'gemini-3-flash-preview');
check('exact prefere au -preview', pickGoogleModel('gemini-3.1-flash-lite', ids), 'gemini-3.1-flash-lite');
check('gemma a4b', pickGoogleModel('gemma-4-26b-a4b-it', ids), 'gemma-4-26b-a4b-it');
check('absent -> vide', pickGoogleModel('gemini-9-flash', ids), '');
check('flash-lite ne capte pas flash', pickGoogleModel('gemini-3.5-flash', ids), 'gemini-3.5-flash');

let sansId = 0;
for (const lane of CHAIN) {
  if (lane.key !== 'google') continue;
  if (!pickGoogleModel(lane.id, ids)) sansId++;
}
check('toutes les lanes ont un id reel', sansId, 0);

// ------------------------------------------------------------------ budget
console.log('\n--- budget local RPM / TPM / RPD ---');
const g = CHAIN.find((l) => l.id === 'gemma-4-26b-a4b-it');
check('budget libre au depart', laneBudgetWait(g).reason, '');
for (let i = 0; i < g.rpm; i++) noteLaneUse(g);
check('RPM atteint -> pause', laneBudgetWait(g).reason, 'rpm');

const flash = CHAIN.find((l) => l.id === 'gemini-3.1-flash-lite');
noteLaneUse(flash);
noteLaneTokens(flash, { usage: { total_tokens: 200 } });
check('un appel leger ne bloque pas', laneBudgetWait(flash).reason, '');

const tpm = CHAIN.find((l) => l.id === 'gemma-4-31b-it');
noteLaneUse(tpm);
noteLaneTokens(tpm, { usage: { total_tokens: 15000 } });
check('TPM depasse -> pause', laneBudgetWait(tpm).reason, 'tpm');

const day = CHAIN.find((l) => l.id === 'gemini-3.5-flash-lite');
for (let i = 0; i < day.rpd; i++) noteLaneUse(day);
check('RPD atteint -> pause jour', laneBudgetWait(day).reason, 'jour');
check('pause jour < 24h', laneBudgetWait(day).ms <= 86400000, true);

// --------------------------------------------------------------- <thought>
console.log('\n--- bloc <thought> de Gemma ---');
const JSON_OUT = '{"v":[false,true],"p":[false,false]}';
check('thought ferme retire', stripThought('<thought>je reflechis</thought>' + JSON_OUT), JSON_OUT);
check('thought multiligne retire', stripThought('<thought>a\nb\nc</thought>\n' + JSON_OUT), JSON_OUT);
check('sortie propre intacte', stripThought(JSON_OUT), JSON_OUT);
check('messageText nettoie aussi', messageText({ choices: [{ message: { content: '<thought>x</thought>' + JSON_OUT } }] }), JSON_OUT);

// ---------------------------------------------------------------- la chaine
console.log('\n--- chaine ---');
const goog = CHAIN.filter((l) => l.key === 'google');
check(
  '4 lanes google gros quota seulement',
  goog.map((l) => l.id).sort(),
  ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemma-4-26b-a4b-it', 'gemma-4-31b-it']
);
check('Flash-Lite en tete', goog.slice(0, 2).map((l) => l.id), [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite'
]);
check('aucun modele 2.5 (404 pour les nouveaux comptes)', goog.filter((l) => l.id.indexOf('2.5') !== -1).length, 0);
check('aucun alias -latest (meme quota)', goog.filter((l) => /-latest$/.test(l.id)).length, 0);
check('toutes ont un quota declare', goog.filter((l) => !(l.rpm && l.rpd)).length, 0);
check('toutes en /chat/completions', goog.filter((l) => l.path !== '/chat/completions').length, 0);
check('aucune ne mute un auteur', goog.filter((l) => l.canMuteAuthor).length, 0);
check('ids uniques', new Set(CHAIN.map((l) => l.id)).size, CHAIN.length);

const glm47 = CHAIN.find((l) => l.id === 'glm-4.5-flash');
const glmBody = chatBody(glm47, 'SYS', 'USER', 80);
check('Z.ai thinking disabled', glmBody.thinking, { type: 'disabled' });
check('Z.ai pas de reasoning_effort', glmBody.reasoning_effort === undefined, true);
check('Z.ai do_sample false', glmBody.do_sample, false);

console.log(fails ? '\n' + fails + ' ECHEC(S)\n' : '\ntout est vert\n');
process.exit(fails ? 1 : 0);
