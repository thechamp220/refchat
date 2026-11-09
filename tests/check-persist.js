'use strict';

// Le service worker MV3 est tue par Chrome apres ~30s d'inactivite et repart
// de zero. Trois etats vivaient en simple variable, jamais dans
// chrome.storage : les pauses de rate-limit (modelSkipUntil et ses series),
// les stats de lane du popup (laneStats), et les compteurs/le journal de la
// relecture hors live (idle*). Ce fichier simule le redemarrage — on vide les
// variables JS SANS toucher au faux magasin, comme le ferait vraiment Chrome —
// et verifie que chaque etat revient tel qu il aurait ete sans coupure.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function between(a, b) {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('bloc introuvable : ' + a);
  return src.slice(i, j);
}

// Faux chrome.storage.local : un objet en memoire, API get/set par callback
// comme le vrai. C'est le seul etat qui doit SURVIVRE au « redemarrage ».
let store = {};
globalThis.chrome = {
  storage: {
    local: {
      // Le vrai chrome.storage clone par valeur (structured clone) : stocker
      // puis muter l objet source ne doit RIEN changer au magasin. Sans ce
      // clone, `laneStats` et le `store` finissent par pointer sur le meme
      // objet et `resetLaneStats()` efface le magasin en meme temps que la
      // memoire — un faux positif du fake, pas un bug du code teste.
      get(defaults, cb) {
        const out = {};
        for (const k of Object.keys(defaults)) out[k] = JSON.parse(JSON.stringify(k in store ? store[k] : defaults[k]));
        cb(out);
      },
      set(obj, cb) {
        for (const k of Object.keys(obj)) store[k] = JSON.parse(JSON.stringify(obj[k]));
        if (cb) cb();
      }
    }
  }
};

const code = [
  between('const IDLE = {', '\nlet lastWatchAt'),
  between('let lastWatchAt = 0;', '\nfunction liveLane'),
  between('const modelSkipUntil = {};', '\nlet punishTarget'),
  between('function skipLane(id, ms, reason) {', '\nfunction noteLaneFail'),
  between("// Le service worker MV3 est tue", '\n// Ids Google exacts'),
  // Les `let` primitifs ne survivent pas a un Object.assign par valeur : on
  // expose des fonctions qui lisent/ecrivent le binding reel au moment de
  // l appel, meme patron que getBg()/getLearn() dans check-bg.js.
  `Object.assign(globalThis, {
    modelSkipUntil, modelSkipReason, modelFailStreak, model429Streak, modelUnreadStreak, laneStats,
    skipLane, noteLaneOk, noteLaneStat,
    saveLaneSkip, loadLaneSkip, saveLaneStats, loadLaneStats, saveIdleState, loadIdleState,
    noteWatch, watchingLive,
    setLastWatchAt: (t) => { lastWatchAt = t; },
    idleGet: () => ({ wake: idleWake, reviewed: idleReviewed, web: idleWebUsed, lastAt: idleLastAt, lastRun: idleLastRun, trail: idleTrail.slice() }),
    idleSet: (v) => { idleWake = v.wake || 0; idleReviewed = v.reviewed || 0; idleWebUsed = v.web || 0; idleLastAt = v.lastAt || 0; idleLastRun = v.lastRun || 0; idleTrail = v.trail || []; },
    resetLaneMemory: () => {
      for (const k of Object.keys(modelSkipUntil)) delete modelSkipUntil[k];
      for (const k of Object.keys(modelSkipReason)) delete modelSkipReason[k];
      for (const k of Object.keys(modelFailStreak)) delete modelFailStreak[k];
      for (const k of Object.keys(model429Streak)) delete model429Streak[k];
      for (const k of Object.keys(modelUnreadStreak)) delete modelUnreadStreak[k];
    },
    resetLaneStats: () => { for (const k of Object.keys(laneStats)) delete laneStats[k]; },
    resetIdleMemory: () => { idleWake = 0; idleReviewed = 0; idleWebUsed = 0; idleLastAt = 0; idleLastRun = 0; idleTrail = []; }
  });`
].join('\n');

// eslint-disable-next-line no-eval
eval(code);
const {
  modelSkipUntil, modelSkipReason, modelFailStreak, model429Streak, modelUnreadStreak, laneStats,
  skipLane, noteLaneOk, noteLaneStat,
  saveLaneSkip, loadLaneSkip, saveLaneStats, loadLaneStats, saveIdleState, loadIdleState,
  noteWatch, watchingLive, setLastWatchAt,
  idleGet, idleSet, resetLaneMemory, resetLaneStats, resetIdleMemory
} = globalThis;

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (ok ? '' : '\n        obtenu  ' + JSON.stringify(got) + '\n        attendu ' + JSON.stringify(want)));
}

console.log('\n--- une pause de rate-limit survit au redemarrage ---');
skipLane('lane-a', 5000, 'timeout');
saveLaneSkip();
resetLaneMemory();
check('en memoire, plus rien avant le chargement', modelSkipUntil['lane-a'], undefined);
loadLaneSkip();
check('la pause revient', modelSkipUntil['lane-a'] > Date.now(), true);
check('la raison revient', modelSkipReason['lane-a'], 'timeout');

console.log('\n--- une pause perimee ne ressuscite pas ---');
resetLaneMemory();
store.csg_lane_skip = { 'lane-b': { until: Date.now() - 5000, reason: 'erreur', fail: 0, r429: 0 } };
loadLaneSkip();
check('pause expiree -> pas restauree', modelSkipUntil['lane-b'], undefined);

console.log('\n--- le backoff progressif (series d echecs) survit ---');
resetLaneMemory();
modelFailStreak['lane-c'] = 2;
model429Streak['lane-c'] = 1;
skipLane('lane-c', 7000, 'quota');
saveLaneSkip();
resetLaneMemory();
loadLaneSkip();
check('serie d echecs restauree', modelFailStreak['lane-c'], 2);
check('serie de 429 restauree', model429Streak['lane-c'], 1);
// Sans ca, le backoff (7s -> 25s -> 180s) repart de la 1re marche a chaque
// redemarrage au lieu de vraiment monter — exactement ce qu on corrige ici.

console.log('\n--- noteLaneOk efface la serie, et ca doit tenir ---');
resetLaneMemory();
modelFailStreak['lane-d'] = 3;
skipLane('lane-d', 5000, 'erreur');
noteLaneOk('lane-d');
saveLaneSkip();
resetLaneMemory();
loadLaneSkip();
check('la serie remise a zero ne ressuscite pas a 3', modelFailStreak['lane-d'] || 0, 0);

console.log('\n--- la serie de reponses illisibles survit aussi ---');
// Sans elle, une lane cassee a demeure repartait a 12 s de pause a chaque
// reveil du service worker au lieu de rester ecartee (1 min, 5 min, 30 min).
resetLaneMemory();
modelUnreadStreak['lane-g'] = 3;
skipLane('lane-g', 300000, 'illisible');
saveLaneSkip();
resetLaneMemory();
loadLaneSkip();
check('serie illisible restauree', modelUnreadStreak['lane-g'], 3);
check('  avec sa raison', modelSkipReason['lane-g'], 'illisible');
noteLaneOk('lane-g');
check('une reponse lisible l efface', modelUnreadStreak['lane-g'], 0);

console.log('\n--- une mise a jour efface la pause « illisible », pas le quota ---');
// DeepSeek restait « illisible · 15min » apres la 3.18.4 : la pause et la serie
// posees par l'ancien code (drapeau noeffort) revenaient du stockage.
resetLaneMemory();
store.csg_lane_skip = {
  'lane-h': { until: Date.now() + 900000, reason: 'illisible', fail: 0, r429: 0, unread: 3, ver: '3.18.3' },
  'lane-i': { until: Date.now() + 900000, reason: 'quota', fail: 0, r429: 3, unread: 0, ver: '3.18.3' }
};
loadLaneSkip();
check('pause illisible d une autre version : levee', modelSkipUntil['lane-h'], undefined);
check('  et sa serie repart de zero', modelUnreadStreak['lane-h'] || 0, 0);
check('pause quota d une autre version : gardee', modelSkipUntil['lane-i'] > Date.now(), true);
check('  avec sa serie de 429', model429Streak['lane-i'], 3);

console.log('\n--- rien a sauver = rien n encombre le stockage ---');
resetLaneMemory();
modelSkipUntil['lane-e'] = Date.now() - 9999; // perimee, aucune serie en cours
saveLaneSkip();
check('une pause perimee sans serie est elaguee', 'lane-e' in (store.csg_lane_skip || {}), false);

console.log('\n--- stats de lane (popup : avgMs / appels / echecs) ---');
resetLaneStats();
noteLaneStat('m1', 100, true);
noteLaneStat('m1', 200, true);
noteLaneStat('m1', 0, false);
saveLaneStats();
const before = JSON.parse(JSON.stringify(laneStats.m1));
resetLaneStats();
check('en memoire, plus rien avant le chargement', laneStats.m1, undefined);
loadLaneStats();
check('appels restaures', laneStats.m1.calls, before.calls);
check('echecs restaures', laneStats.m1.fails, before.fails);
check('latence moyenne restauree', laneStats.m1.avgMs, before.avgMs);

console.log('\n--- le chargement ne fait jamais reculer un compteur deja avance ---');
laneStats.m1.calls = 999;
loadLaneStats(); // le stockage dit encore l ancienne valeur, plus petite
check('999 reste 999, pas ecrase par une valeur plus vieille', laneStats.m1.calls, 999);

console.log('\n--- stats ecrites avant l epoque : ignorees une fois ---');
// Avant la file FIFO du portillon Go, sa latence comptait l attente : la popup
// affichait 85864 ms et 225941 ms. Ces moyennes ne doivent pas revenir.
resetLaneStats();
store.csg_lane_stats = { 'lane-go': { calls: 552, fails: 3, avgMs: 85864 } };
delete store.csg_lane_stats_epoch;
loadLaneStats();
check('moyenne gonflee par le portillon : pas restauree', laneStats['lane-go'], undefined);
noteLaneStat('lane-go', 2100, true);
saveLaneStats();
check('le premier enregistrement pose l epoque', store.csg_lane_stats_epoch, 1);
resetLaneStats();
loadLaneStats();
check('  et les stats suivantes se rechargent', [laneStats['lane-go'].calls, laneStats['lane-go'].avgMs], [1, 2100]);

console.log('\n--- relecture hors live : compteurs et journal ---');
resetIdleMemory();
idleSet({ wake: 7, reviewed: 3, web: 1, lastAt: 111, lastRun: 222, trail: [{ author: 'x', text: 'y' }] });
saveIdleState();
resetIdleMemory();
check('en memoire, plus rien avant le chargement', idleGet().wake, 0);
setLastWatchAt(0); // pas de live en cours
loadIdleState();
const r = idleGet();
check('reveils restaures (protege le plafond de 40)', r.wake, 7);
check('relus restaures', r.reviewed, 3);
check('recherches web restaurees', r.web, 1);
check('dernier lot restaure', r.lastRun, 222);
check('le journal de la relecture revient', r.trail.length, 1);
check('le contenu du journal revient', r.trail[0].author, 'x');

console.log('\n--- mais pas si un live a deja repris entre-temps ---');
// noteWatch() vient de remettre idleWake a 0 pour une VRAIE raison (nouvelle
// periode de veille) : un chargement tardif ne doit pas ecraser ce zero avec
// un vieux 7 venu du stockage.
resetIdleMemory();
setLastWatchAt(Date.now()); // watchingLive() === true maintenant
loadIdleState();
check('idleWake reste a 0, pas ressuscite a 7', idleGet().wake, 0);
check('mais les compteurs historiques reviennent quand meme', idleGet().reviewed, 3);

console.log('\n--- noteWatch() persiste lui-meme sa remise a zero ---');
resetIdleMemory();
idleSet({ wake: 9, reviewed: 0, web: 0, lastAt: 0, lastRun: 0, trail: [] });
saveIdleState();
noteWatch();
saveIdleState(); // meme appel que saveIdleStateSoon() flush immediatement
check('un futur redemarrage ne retrouvera pas 9 mais 0', store.csg_idle_state.wake, 0);

console.log(fails ? '\n' + fails + ' ECHEC(S)\n' : '\ntout est vert\n');
process.exit(fails ? 1 : 0);
