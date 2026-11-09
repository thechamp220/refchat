'use strict';
// Vérifie le garde-fou de l'auto-apprentissage : quels termes proposés par le
// modèle sont acceptés, lesquels sont refusés et pourquoi.
//
//   node tests/check-learn.js
//
// background.js est chargé tel quel dans un bac à sable avec des stubs chrome :
// on teste les VRAIES fonctions, pas une copie de leur logique.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const noop = () => {};
const listener = { addListener: noop, removeListener: noop, hasListener: () => false };

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
  tabs: { query: (q, cb) => cb && cb([]), sendMessage: noop, onUpdated: listener, onRemoved: listener, create: noop },
  scripting: { executeScript: () => Promise.resolve([]) },
  webNavigation: { onCompleted: listener, onHistoryStateUpdated: listener },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setTitle: noop, onClicked: listener },
  windows: { create: noop }
};

const sandbox = {
  chrome,
  console,
  fetch: () => Promise.reject(new Error('offline')),
  AbortController,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  JSON,
  URL,
  TextEncoder,
  TextDecoder
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.importScripts = (f) => {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
};

const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });

const { learnReject, learnNormalize, parseLearnAdd } = sandbox;
if (typeof learnReject !== 'function') {
  console.error('learnReject introuvable — background.js a-t-il changé ?');
  process.exit(2);
}

// --- Jeu d'essai ---------------------------------------------------------
// fns = messages rejetés par le modèle et manqués par les mots-clés (la preuve).
const FNS = [
  { text: 'reste a tes casseroles' },
  { text: 'elle ferait mieux de rester a tes casseroles' },
  { text: 'quel gros bouffi ce mec' },
  { text: 'gros bouffi va' },
  { text: 'il joue comme ma grand mere' },
  // « bon joueur » apparaît 2× ici (preuve suffisante) ET dans les keeps :
  // c'est le cas qui doit être arrêté par le garde-fou anti-faux-positif,
  // pas par le compteur de preuves.
  { text: 'ce joueur est un bon joueur quand meme' },
  { text: 'franchement bon joueur mais quel bouffi' },
  // « feignasse » est entre dans HEAVY_WORDS (audit 2) : on prend un terme
  // encore absent de toutes les listes pour tester le cas ACCEPT.
  { text: 'gros trouduc ce joueur' },
  { text: 'quel trouduc serieux' }
];
// keeps = messages que le pipeline a acceptés. Un terme qui apparaît là dedans
// produira un faux positif dès sa prochaine occurrence : il doit être refusé.
const KEEPS = [
  'ce joueur est un bon joueur quand meme',
  'gg wp les gars',
  'il a un bon ratio sur inferno',
  'bravo pour le clutch'
];

const CASES = [
  ['ACCEPT', 'casseroles', '2 preuves, absent des keeps'],
  ['ACCEPT', 'bouffi', '2 preuves, absent des keeps'],
  ['ACCEPT', 'trouduc', '2 preuves, absent des keeps'],
  ['REJET', 'bot', 'mot neutre (LEARN_STOP)'],
  ['REJET', 'ratio', 'mot neutre (LEARN_STOP)'],
  ['REJET', 'joueur', 'mot neutre (LEARN_STOP)'],
  ['REJET', 'bon joueur', 'GARDE-FOU CLÉ : 2 preuves mais présent dans un keep'],
  ['REJET', 'ta gueule', 'déjà couvert par les règles locales'],
  ['REJET', 'ntm', 'déjà couvert par les règles locales'],
  ['REJET', 'retourne a la cuisine', 'déjà dans HEAVY_WORDS depuis les correctifs'],
  ['REJET', 'ab', 'trop court'],
  ['REJET', 'grand mere', 'une seule preuve'],
  ['REJET', 'inexistant', 'aucune preuve'],
  ['REJET', 'quelque chose de vraiment tres long comme terme ici', 'longueur'],
  ['REJET', 'un deux trois quatre cinq', 'trop de mots']
];

let ko = 0;
console.log('--- garde-fou learnReject ---');
for (const [attendu, terme, note] of CASES) {
  const why = learnReject(learnNormalize(terme), KEEPS, FNS);
  const got = why ? 'REJET' : 'ACCEPT';
  if (got !== attendu) ko += 1;
  console.log(
    (got === attendu ? '  ok  ' : '  KO  ') +
      attendu.padEnd(7) +
      '→ ' + got.padEnd(7) +
      ' | ' + terme.padEnd(46) +
      ' | ' + (why || note)
  );
}

console.log('\n--- normalisation ---');
for (const [input, want] of [
  ['  Retourne À La CUISINE  ', 'retourne a la cuisine'],
  ['ｇｒｏｓ ｂｏｕｆｆｉ', 'gros bouffi'],
  ['sale!!! con???', 'sale con'],
  ['t-shirt', 't-shirt']
]) {
  const got = learnNormalize(input);
  if (got !== want) ko += 1;
  console.log((got === want ? '  ok  ' : '  KO  ') + JSON.stringify(input) + ' → ' + JSON.stringify(got));
}

console.log('\n--- parsing de la réponse modèle ---');
const parsed = parseLearnAdd('```json\n{"add":[{"w":"Gros Bouffi","why":"insulte"},{"w":"","why":"vide"},"feignasse"]}\n```');
const okParse = parsed.length === 2 && parsed[0].w === 'gros bouffi' && parsed[1].w === 'feignasse';
if (!okParse) ko += 1;
console.log((okParse ? '  ok  ' : '  KO  ') + JSON.stringify(parsed));

console.log('\n' + (ko === 0 ? 'tout est vert' : ko + ' échec(s)'));
process.exit(ko ? 1 : 0);
