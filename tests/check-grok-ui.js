'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const board = fs.readFileSync(path.join(root, 'board.js'), 'utf8');
function section(source, start, end) {
  const a = source.indexOf(start); const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'section UI disponible : ' + start);
  return source.slice(a, b);
}
class Element {
  constructor() {
    this.textContent = ''; this.hidden = false; this.disabled = false; this.value = '';
    this.style = {}; this.children = []; this.listeners = {}; this.classes = new Set();
    this.classList = { add: x => this.classes.add(x), remove: x => this.classes.delete(x),
      toggle: (x, on) => on ? this.classes.add(x) : this.classes.delete(x) };
  }
  appendChild(x) { this.children.push(x); return x; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  removeAttribute(name) { delete this[name]; }
  setAttribute(name, value) { this[name] = value; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text; }
  get text() { return this.textContent + this.children.map(x => x.text).join(' '); }
}
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('ok  ' + name); }

async function main() {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const calls = []; let reply = { ok: true }; let refreshed = 0;
  const context = vm.createContext({ $, window: {}, codexBridgeEnabled: false, liveUi: { mode: 'off' },
    fmt: String, xaiBtn: $('xaiOAuthBtn'), xaiLogoutBtn: $('xaiOAuthLogout'), xaiStatusEl: $('xaiOAuthStatus'),
    chrome: { runtime: { sendMessage: (msg, cb) => { calls.push(msg); cb(reply); } } },
    refreshLive: () => refreshed++ });
  vm.runInContext(section(popup, 'function paintAnalyze', '\nfunction liveMessage') + '\n' +
    section(popup, 'function paintXaiOAuth', '\nif (xaiBtn)') + '\n' +
    section(popup, "$('stopAnalyze').addEventListener", "\n$('openBoard').addEventListener"), context);
  const paint = (bulk, waiting = 10, key = true) => context.paintAnalyze({ bulk, waiting }, key);
  paint({ running: true, peopleDone: 3, peopleTotal: 8 });
  check('analyse active : progression et commande d’arrêt disponibles', () => {
    assert.equal($('analyzeCaptured').disabled, true); assert.equal($('stopAnalyze').hidden, false);
    assert.equal($('stopAnalyze').disabled, false); assert.equal($('analyzeProgress').value, 37.5);
  });
  paint({ running: false, stopping: true, peopleDone: 3, peopleTotal: 8 });
  check('arrêt en cours : aucun redémarrage concurrent proposé', () => {
    assert.equal($('analyzeCaptured').disabled, true); assert.equal($('stopAnalyze').disabled, true);
    assert.match($('analyzeStatus').textContent, /restent en attente/);
  });
  paint({ running: false, err: 'interrompu à la demande' });
  check('arrêt terminé : captures réanalysables et progression masquée', () => {
    assert.equal($('analyzeCaptured').disabled, false); assert.equal($('stopAnalyze').hidden, true);
    assert.equal($('analyzeProgress').hidden, true); assert.match($('analyzeStatus').textContent, /interrompu/);
  });
  paint({ running: false, err: 'HTTP 503' }, 10, false);
  check('reprise indisponible tant que SuperGrok est déconnecté', () => assert.equal($('analyzeCaptured').disabled, true));
  paint({}, 0);
  check('file vide : bouton désactivé sans arrêt affiché', () => {
    assert.equal($('analyzeCaptured').disabled, true); assert.equal($('stopAnalyze').hidden, true);
  });
  reply = null; $('stopAnalyze').listeners.click();
  check('arrêt non confirmé : erreur visible et bouton de nouvelle tentative', () => {
    assert.equal(calls[0].type, 'CSG_AUDIT_ALL_STOP'); assert.equal($('stopAnalyze').disabled, false);
    assert.match($('analyzeStatus').textContent, /Arrêt non confirmé/); assert.equal(refreshed, 0);
  });
  reply = { ok: true }; $('stopAnalyze').listeners.click();
  check('arrêt confirmé : état relu auprès du service worker', () => assert.equal(refreshed, 1));
  context.paintXaiOAuth({ has: true, err: 'renouvellement temporairement indisponible' });
  check('panne OAuth temporaire : connexion conservée et cause visible', () => {
    assert.match($('xaiOAuthStatus').textContent, /Connexion conservée.*temporairement/);
    assert.equal($('xaiOAuthBtn').style.display, 'none'); assert.equal($('xaiOAuthLogout').style.display, '');
  });
  context.paintXaiOAuth({ has: true });
  check('renouvellement réussi : ancienne erreur effacée', () => assert.doesNotMatch($('xaiOAuthStatus').textContent, /temporairement/));

  const document = { createElement: () => new Element(), querySelector: () => ({ id: 'tab-mutes' }) };
  const boardCalls = []; const timers = [];
  let grokStatus = { running: false, err: 'réponse illisible', total: 20, peopleDone: 3, peopleTotal: 8 };
  const bc = vm.createContext({ $, document, bulkTimer: null, grokWasRunning: false,
    clearTimeout() {}, setTimeout: (fn, ms) => { timers.push(ms); return 1; }, loadMutes() {},
    send: async msg => { boardCalls.push(msg.type); return msg.type === 'CSG_AUDIT_ALL_STATUS'
      ? { ok: true, status: grokStatus } : { ok: true, enabled: true, status: { total: 0 } }; } });
  vm.runInContext(section(board, 'const FILTER_INDEX_HINT', '\nfunction ago'), bc);
  check('indice affiché sur 100, valeur manquante laissée inconnue', () => {
    assert.equal(bc.filterIndex(0.94), '94/100'); assert.equal(bc.filterIndex(94, 1), '94/100');
    assert.equal(bc.filterIndex(null), '—'); assert.equal(bc.filterIndex(''), '—');
  });
  vm.runInContext(section(board, 'function renderBulk', "\n$('auditAll').addEventListener"), bc);
  await bc.pollBulk();
  check('tableau : une erreur Grok reste affichée malgré le relais Codex', () => {
    assert.deepEqual(boardCalls, ['CSG_AUDIT_ALL_STATUS']); assert.match($('bulkBox').text, /analyse arrêtée.*réponse illisible/);
    assert.doesNotMatch($('bulkBox').text, /terminé/);
  });
  grokStatus = { running: false, stopping: true, total: 20, peopleDone: 3, peopleTotal: 8 };
  await bc.pollBulk();
  check('tableau : arrêt en cours suivi jusqu’à sa fin', () => {
    assert.equal($('auditAll').disabled, true); assert.equal($('auditAllStop').disabled, true);
    assert.doesNotMatch($('bulkBox').text, /réponse illisible/);
    assert.equal(timers.at(-1), 3000);
  });
  bc.renderBulk({ running: false, total: 1, peopleDone: 1, peopleTotal: 1, results: [
    { a: 'viewer', ok: true, mute: true, applied: true, score: 0.94 }
  ] });
  check('tableau : verdict binaire sans faux pourcentage de confiance', () => {
    assert.match($('bulkBox').text, /verdict de mute/); assert.doesNotMatch($('bulkBox').text, /94\s*%/);
  });
  console.log('grok UI : ' + checks + ' vérifications OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
