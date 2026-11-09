'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { checker } = require('./bench');

const src = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
const code = src.slice(src.indexOf('function isRateLimited'), src.indexOf('function paintLed'));
const status = { textContent: '', title: '', className: '', classList: { add() {} } };
const ctx = { Date, $: () => status, fmt: String };
vm.createContext(ctx);
vm.runInContext(code, ctx);

const T = checker();
const check = T.check;
const auth = {
  state: 'offline',
  label: 'Grok 4.20 non-thinking (xAI) · reconnecte SuperGrok',
  lastError: 'rate limit',
  cooldownUntil: Date.now() + 300000,
  rateLimited: true,
  lanes: [{ id: 'grok-4.20-0309-non-reasoning', picked: true, status: 'nokey' }]
};
check('auth refusée : ancien cooldown ignoré', ctx.isRateLimited(auth), false);
ctx.paintStatus(auth, true, null, '');
check('auth refusée : bandeau nomme le modèle', status.textContent, auth.label);
check('vrai 429 : affiché', ctx.isRateLimited({ ...auth, lanes: [{ picked: true, status: 'limit' }] }), true);
for (const state of ['err', 'ready', 'busy']) {
  check(state + ' : ancien cooldown ignoré', ctx.isRateLimited({ ...auth, lanes: [{ picked: true, status: state }] }), false);
}
const failure = { ...auth, state: 'paused', lanes: [{ picked: true, status: 'err', label: 'Grok 4.20', detail: 'erreur · HTTP 503 · 7s' }] };
ctx.paintStatus(failure, true, null, '');
check('erreur : bandeau affiche la cause malgré ancien snapshot', status.textContent, 'Grok 4.20 · erreur · HTTP 503 · 7s');

// Fond resté sur l'ancien code (réponse sans `code`, ou code plus ancien) : après
// une relance, Brave garde l'ancien service worker. Le popup, relu sur le disque,
// recharge l'extension lui-même, avec le garde-fou partagé csg_selfheal ; au-delà
// de deux essais il demande ↻. Même version des deux côtés : rien.
let stored = null;
let reloads = 0;
const later = [];
ctx.setTimeout = (fn) => later.push(fn);
ctx.chrome = {
  runtime: { getManifest: () => ({ version: '3.39.7' }), reload: () => { reloads += 1; } },
  storage: {
    local: {
      get: (d, cb) => cb(Object.assign({}, d, stored ? { csg_selfheal: stored } : {})),
      set: (o, cb) => { stored = o.csg_selfheal; if (cb) cb(); }
    }
  }
};
vm.runInContext('liveCode = ""; healState = null', ctx);
check('ancien worker : réparation, pas une panne', ctx.paintStatus(failure, true, null, ''), 'warn');
check('ancien worker : le dit', /^Refchat se met à jour : son fond tournait encore sur l’ancien code \(une version antérieure à la 3\.39\.6\)\. Rechargement automatique : le popup va se fermer/.test(status.textContent), true);
check('garde-fou noté avant le rechargement', [stored && stored.want, stored && stored.n, stored && stored.by], ['3.39.7', 1, 'popup']);
check('rechargement après le délai de lecture', [reloads, later.length], [0, 1]);
later.shift()();
check('chrome.runtime.reload appelé une fois', reloads, 1);
ctx.paintStatus(failure, true, null, '');
check('pas de second rechargement dans le même popup', [reloads, later.length], [1, 0]);

stored = { want: '3.39.7', at: Date.now(), n: 2, by: 'popup' };
vm.runInContext('liveCode = "3.39.5"; healState = null', ctx);
check('deux essais déjà faits : bandeau rouge', ctx.paintStatus(failure, true, null, ''), 'bad');
check('deux essais déjà faits : demande ↻', /tourne toujours sur l’ancien code \(v3\.39\.5, popup v3\.39\.7\) · dans brave:\/\/extensions, clique sur ↻ sous Refchat\.$/.test(status.textContent), true);
check('deux essais déjà faits : aucun rechargement', [reloads, later.length], [1, 0]);

stored = { want: '3.39.7', at: Date.now() - 11 * 60000, n: 2, by: 'popup' };
vm.runInContext('healState = null', ctx);
ctx.paintStatus(failure, true, null, '');
check('essais de plus de 10 min oubliés', [later.length, stored.n], [1, 1]);
later.length = 0;
stored = { want: '3.39.6', at: Date.now(), n: 2, by: 'fond' };
vm.runInContext('healState = null', ctx);
ctx.paintStatus(failure, true, null, '');
check('essais pour une autre version : ne comptent pas', [later.length, stored.want, stored.n], [1, '3.39.7', 1]);
later.length = 0;

vm.runInContext('liveCode = "3.39.7"; healState = null', ctx);
ctx.paintStatus(failure, true, null, '');
check('même version : bandeau normal', status.textContent, 'Grok 4.20 · erreur · HTTP 503 · 7s');
vm.runInContext('liveCode = "3.39.8"', ctx);
ctx.paintStatus(failure, true, null, '');
check('fond plus récent que le popup : aucune alerte', status.textContent, 'Grok 4.20 · erreur · HTTP 503 · 7s');
vm.runInContext('liveCode = null', ctx);
ctx.paintStatus(failure, true, null, '');
check('pas encore de réponse du fond : aucune alerte', status.textContent, 'Grok 4.20 · erreur · HTTP 503 · 7s');
check('aucun rechargement hors fond périmé', [reloads, later.length], [1, 0]);
check('3.39.10 plus récent que 3.39.9', ctx.versionCmp('3.39.10', '3.39.9'), 1);
if (T.fails) process.exitCode = 1;
