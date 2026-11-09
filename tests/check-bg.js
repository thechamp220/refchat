'use strict';

// Travail en arriere-plan (relecture du journal + apprentissage de termes).
//
// C'est le SEUL trafic reseau que l'utilisateur ne voit pas partir : stream
// ferme, onglet ferme, il tourne quand meme et consomme quotas et abonnement.
// Il est donc opt-in strict. Ce fichier verifie qu'un reglage absent vaut
// « coupe », et qu'aucun chemin ne rallume ca tout seul.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function between(a, b) {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('bloc introuvable : ' + a);
  return src.slice(i, j);
}

// Faux chrome.alarms : on observe ce que le code pose et retire.
const alarms = new Set();
globalThis.chrome = {
  alarms: {
    create: (n) => alarms.add(n),
    clear: (n) => alarms.delete(n)
  }
};
globalThis.punishTarget = 'author';
// applySettings valide le modele choisi contre CHAIN : deux ids suffisent, on
// ne teste pas la chaine ici (voir check-lanes.js et check-pick.js).
globalThis.CHAIN = [{ id: 'glm-4.5-flash' }, { id: 'gemma-4-26b-a4b-it' }];
globalThis.pickedLane = '';
globalThis.thresholdCache = 0.4;
globalThis.notifyEnabled = true;
globalThis.watchingLive = () => false;
globalThis.learnLoaded = true;
globalThis.learnBusy = false;
globalThis.learnLastAt = 0;
globalThis.learnIdleSince = 1;
globalThis.learnSeenFt = 0;
globalThis.ftCount = 9999;
globalThis.LEARN = { EVERY_MS: 0, IDLE_MS: 0, MIN_NEW: 1 };

const code = [
  // llmJudge démarre à l'ancien état pour vérifier que applySettings le coupe.
  'var bgEnabled = false, learnEnabled = true, fullAudit = false, llmOnly = true, llmJudge = true; var liveSettingsLoaded = false, liveMasterEnabled = false, liveLoaded = false, liveCfg = { mode: "off" };',
  // syncJudge ne force plus le jugement au-delà du seuil.
  'var auditQueue = [], aborts = 0; const behLog = () => {}, abortInflight = () => { aborts += 1; }, persistQueueSoon = () => {}, publishAudit = () => {}, pumpAudit = () => {};',
  between('const AUTO_JUDGE_QUEUE', '\nfunction applySettings'),
  between('function applySettings', '\nfunction loadPunishTarget'),
  between('function shouldLearn', '\nasync function runLearnPass'),
  'Object.assign(globalThis, { applySettings, shouldLearn, syncIdleAlarm, syncJudge, AUTO_JUDGE_QUEUE, setQueueLen: (n) => { auditQueue.length = n; }, getJudge: () => [llmJudge, judgeForced], getAborts: () => aborts, getBg: () => bgEnabled, getLearn: () => learnEnabled, getFull: () => fullAudit, getLlmOnly: () => llmOnly });'
].join('\n');

// eslint-disable-next-line no-eval
eval(code);
const { applySettings, shouldLearn, getBg, getLearn, getLlmOnly } = globalThis;

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (ok ? '' : '\n        obtenu  ' + JSON.stringify(got) + '\n        attendu ' + JSON.stringify(want)));
}

// Les cases ont ete retirees du popup : arriere-plan, liste apprise,
// verification complete et « tout juger au LLM » ne sont plus negociables.
// applySettings ne LIT plus le storage pour eux — c'est la seule facon qu'une
// vieille valeur synchronisee (ecrite du temps ou la case existait) ne les
// rallume pas dans le dos. Ce bloc verifie qu'aucune entree ne les fait bouger.
console.log('\n--- reglages figes : rien ne les rallume ---');
const REVEILS = [
  {},
  undefined,
  { bg: true, learn: true, fullAudit: true, llmOnly: false },
  { bg: 1, learn: 'oui', fullAudit: 'true', llmOnly: 0 },
  { enabled: true, notify: true, threshold: 0.5 }
];
for (const cfg of REVEILS) {
  applySettings(cfg);
  const label = JSON.stringify(cfg) || 'undefined';
  check(label + ' -> arriere-plan coupe', getBg(), false);
  check(label + ' -> liste apprise coupee', getLearn(), false);
  check(label + ' -> verification complete coupee', globalThis.getFull(), false);
  check(label + ' -> tout juger au LLM', getLlmOnly(), true);
  check(label + ' -> aucune alarme de fond', alarms.has('csg_idle'), false);
  check(label + ' -> aucune passe auto', shouldLearn(), false);
}

// Grok ne repond qu'aux personnes confiees a la main (voir check-bait.js) :
// aucun reglage synchronise, meme l'ancienne case `baitReply`, n'y touche.
check(
  'applySettings ne lit pas baitReply',
  /baitReply|setBaitTarget|stopBait/.test(between('function applySettings', '\n// L alarme').replace(/\/\/.*$/gm, '')),
  false
);

console.log('\n--- les valeurs figees le sont dans le SOURCE ---');
for (const [nom, re] of [
  ['bgEnabled', /\n\s*bgEnabled = false;/],
  ['learnEnabled', /\n\s*learnEnabled = false;/],
  ['fullAudit', /\n\s*fullAudit = false;/],
  ['llmOnly', /\n\s*llmOnly = true;/],
  ['notifyEnabled', /\n\s*notifyEnabled = false;/]
]) {
  check(nom + ' est fige dans applySettings', re.test(between('function applySettings', '\n// L alarme')), true);
}
check(
  'applySettings ne lit plus cfg pour ces reglages',
  /cfg\.(bg|learn|fullAudit|llmOnly|notify)\b/.test(between('function applySettings', '\n// L alarme')),
  false
);

// Aucune accumulation ni ancien interrupteur ne rallume le live.
console.log('\n--- ancien jugement live toujours coupe ---');
{
  const N = globalThis.AUTO_JUDGE_QUEUE;
  const { syncJudge, setQueueLen, getJudge, getAborts } = globalThis;
  check('le seuil vaut 2000', N, 2000);
  setQueueLen(0);
  applySettings({ judge: false });
  check('case decochee, file vide -> coupe', getJudge(), [false, false]);
  setQueueLen(N);
  syncJudge();
  check('file = seuil -> reste coupe', getJudge(), [false, false]);
  applySettings({ judge: false });
  check('ancien reglage off -> reste coupe', getJudge(), [false, false]);
  const abortsBefore = getAborts();
  setQueueLen(N - 1);
  syncJudge();
  check('file redescendue -> reste coupe', getJudge(), [false, false]);
  check('aucun lot en vol a tuer', getAborts(), abortsBefore);
  applySettings({ judge: true });
  setQueueLen(N + 500);
  syncJudge();
  setQueueLen(10);
  syncJudge();
  check('ancien reglage on -> reste coupe', getJudge(), [false, false]);
  check('syncJudge appele a chaque entree en file', /auditQueue\.push\([\s\S]{0,4000}syncJudge\(\)/.test(src), true);
  check('syncJudge appele a la publication', /function doPublish\(\)[\s\S]{0,500}syncJudge\(\)/.test(src), true);
  setQueueLen(0);
}

console.log('\n--- garde-fous dans le code source ---');
check(
  'runIdleReview refuse quand bg est coupe',
  /async function runIdleReview\(engine, force\) \{\s*\n\s*if \(!bgEnabled && !force\)/.test(src),
  true
);
// `force` existe pour le bouton du tableau. Il doit rester reserve a une action
// EXPLICITE de l'utilisateur : si un appel automatique le passait, l'arriere-plan
// se rallumerait tout seul, ce qui est exactement ce qu'on interdit ici.
const forcedCalls = src.match(/runIdleReview\([^)]*,\s*true\)/g) || [];
check('un seul appel force runIdleReview', forcedCalls.length, 1);
check(
  'et il vient du message manuel du tableau',
  /CSG_IDLE_RUN[\s\S]{0,400}runIdleReview\(engineCache, true\)/.test(src),
  true
);
check(
  "la pompe automatique n'utilise jamais force",
  /runIdleReview\(engineCache\);/.test(src),
  true
);
check('shouldLearn teste bgEnabled', /function shouldLearn\(\)[\s\S]{0,200}!bgEnabled/.test(src), true);
check(
  'la pompe sort avant la relecture quand bg est coupe',
  src.indexOf('if (!bgEnabled) {') !== -1 && src.indexOf('if (!bgEnabled) {') < src.indexOf('runIdleReview(engineCache)'),
  true
);
check("l'alarme n'est plus posee en dur au demarrage", /alarms\.create\('csg_idle'/.test(between('function warmup', '\n}')), false);

// Le profileur d'auteur n'est PAS du travail de fond : il se declenche sur
// l'arrivee de messages, donc uniquement stream ouvert. Il doit rester intact.
check('le profileur ne part plus tout seul', /scheduleAuthorCheck\(key[,)]/.test(between('function trackAuthor', '\n}')), false);
check('le bouton relance le profil', /CSG_AUTHOR_CHECK[\s\S]{0,400}force:\s*true/.test(src), true);
// Depuis la 3.39.5 le lot passe par judgeBulkLot, qui le recoupe s'il est illisible.
check('le bouton de masse juge les captures en lots',
  /judgeBulkLot\(engine, lane, remote/.test(src) && /async function judgeBulkLot[\s\S]{0,800}tryLane\(engine, lane, items/.test(src), true);
// Le popup compare cette version au manifest pour repérer un ancien worker.
check('les stats donnent la version du code qui tourne',
  /CSG_AUDIT_STATS[\s\S]{0,500}\{ code: CODE_VERSION \}/.test(src) && /^const CODE_VERSION = '[^']+';$/m.test(src), true);
check('le diagnostic aussi', /function diagSnapshot[\s\S]{0,1500}code: CODE_VERSION/.test(src), true);
// Une analyse au clic coupée par un rechargement repart : l'alarme est reposée
// au démarrage si Chrome l'a effacée, sans écraser une pause déjà posée.
check('reprise de l analyse au demarrage', /auditRestored = true;[\s\S]{0,900}if \(bulk\.running && !bulk\.live\) ensureBulkAlarm\(\);/.test(src), true);
check('alarme reposee seulement si absente', /function ensureBulkAlarm\(\)[\s\S]{0,300}alarms\.get\('csg_manual'[\s\S]{0,120}if \(!a && bulk\.running/.test(src), true);
// La passe manuelle depuis le tableau de bord doit continuer de marcher.
// runLearnPass lui-meme ne doit PAS tester bgEnabled : sinon le bouton du
// tableau de bord deviendrait mort en meme temps que l'arriere-plan.
check('la passe manuelle reste possible', /CSG_LEARN_RUN[\s\S]{0,600}runLearnPass\([^;]*true\)/.test(src), true);
check('runLearnPass existe', /async function runLearnPass\(engine, force\)/.test(src), true);
check('runLearnPass ne se bloque pas sur bgEnabled', /async function runLearnPass[\s\S]{0,400}!bgEnabled/.test(src), false);

console.log(fails ? '\n' + fails + ' ECHEC(S)\n' : '\ntout est vert\n');
process.exit(fails ? 1 : 0);
