'use strict';
// Real UI functions, simulated storage and delayed callbacks; no account calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const board = fs.readFileSync(path.join(root, 'board.js'), 'utf8');
const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'section disponible : ' + start);
  return source.slice(a, b);
}
class Element {
  constructor() {
    this.value = ''; this.checked = true; this.style = {}; this.listeners = {}; this.dataset = {};
    this.classes = new Set();
    this.classList = {
      add: (x) => this.classes.add(x),
      remove: (x) => this.classes.delete(x),
      toggle: (x, on) => (on !== undefined ? (on ? this.classes.add(x) : this.classes.delete(x)) : (this.classes.has(x) ? (this.classes.delete(x), false) : (this.classes.add(x), true))),
      contains: (x) => this.classes.has(x)
    };
    this.textContent = '';
  }
  set className(val) {
    this._className = String(val || '');
    this._className.split(/\s+/).filter(Boolean).forEach((c) => this.classes.add(c));
  }
  get className() { return this._className || Array.from(this.classes).join(' '); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text !== undefined ? this.text : ''; }
  set innerHTML(value) { this._html = String(value || ''); if (!value) this.children = []; }
  get innerHTML() { return this._html !== undefined ? this._html : ''; }
  appendChild(value) { this.children = this.children || []; this.children.push(value); }
  addEventListener(event, fn) { this.listeners[event] = fn; }
  showModal() { this.open = true; this.classes.delete('hidden'); }
  close() { this.open = false; this.classes.add('hidden'); }
  focus() { this.focused = true; }
  click() { if (typeof this.listeners.click === 'function') this.listeners.click({ target: this }); }
  querySelector(sel) { return null; }
  querySelectorAll(sel) { return []; }
}
let checks = 0;
function check(name, fn) { const r = fn(); if (r && r.then) return r.then(() => { checks++; }); checks++; return r; }
const nodes = new Map();
const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
$('muteNoted').checked = false;
const ctx = vm.createContext({ $, document: { createElement: () => new Element() },
  td: value => { const el = new Element(); el.textContent = typeof value === 'string' ? value : ''; return el; },
  chanChip: String, labelChip: String, filterIndex: String, goTab() {}, showAuthor() {},
  splitChan: (c) => { const s = String(c || ''); const i = s.indexOf('/'); return i > 0 ? { site: s.slice(0, i), name: s.slice(i + 1) } : { site: s ? 'twitch' : '', name: s }; } });
vm.runInContext(section(board, 'const FILTER_INDEX_HINT', '\nfunction fillChanSelect') + '\n' +
  section(board, 'let logCache = []', '\nfunction downloadJsonl'), ctx);
const rows = Array.from({ length: 1305 }, (_, i) => ({ id: 'csg_' + i, ts: 1000 + i,
  author: 'viewer' + i, channel: 'twitch/example', text: 'message ' + i, label: 'pending' }));
ctx.fixture = rows;
vm.runInContext('logCache = fixture; logTotal = 2000; renderLog()', ctx);
check('première page bornée et total exact', () => {
  assert.equal($('logRows').children.length, 100);
  assert.equal($('logPage').textContent, '1–100 sur 1305');
  assert.equal($('logNewer').disabled, true);
  assert.equal($('logRows').children[0].children[2].textContent, 'viewer1304');
  assert.match($('logMeta').textContent, /2000 vus au total/);
});
for (let i = 0; i < 13; i++) $('logOlder').listeners.click();
check('messages au-delà de l’ancienne limite accessibles', () => {
  assert.equal($('logRows').children.length, 5);
  assert.equal($('logPage').textContent, '1301–1305 sur 1305');
  assert.equal($('logOlder').disabled, true);
  assert.equal($('logAutoRefresh').checked, false);
});
vm.runInContext('logCache = [...fixture, {author:"newcomer", text:"nouveau"}]; logTotal = 2001; renderLog()', ctx);
check('lecture ancienne stable pendant l’arrivée de messages', () => {
  assert.equal($('logPage').textContent, '1301–1305 sur 1305');
  assert.match($('logMeta').textContent, /actualisation en pause/);
});
$('logSearch').value = 'message 4'; $('logSearch').listeners.input();
check('filtre sur toute la fenêtre et retour à la première page', () => {
  assert.equal($('logPage').textContent, '1–100 sur 111');
  assert.match($('logMeta').textContent, /111 correspondent/);
});
$('logSearch').value = 'introuvable'; $('logSearch').listeners.input();
check('absence de correspondance distinguée du journal vide', () => {
  assert.match($('logEmpty').textContent, /filtres/);
  assert.equal($('logNewer').disabled, true); assert.equal($('logOlder').disabled, true);
});
$('logSearch').value = '';
vm.runInContext('setLogAutoRefresh(true); renderLog()', ctx);
check('reprise sur les captures les plus récentes', () => {
  assert.equal($('logAutoRefresh').checked, true);
  assert.equal($('logRows').children[0].children[2].textContent, 'newcomer');
  assert.equal($('logPage').textContent, '1–100 sur 1306');
});
vm.runInContext('logCache = []; renderLog()', ctx);
check('journal vide expliqué', () => assert.match($('logEmpty').textContent, /Aucun message capturé/));

const local = [], oauth = [], queries = [], pages = [], painted = [];
const pc = vm.createContext({ window: {}, chrome: {
  storage: { local: { get: (_, cb) => local.push(cb) } },
  runtime: { sendMessage: (_, cb) => oauth.push(cb) },
  tabs: { query: (_, cb) => queries.push(cb), sendMessage: (id, _, cb) => pages.push(cb) }
}, paintAll: (...args) => painted.push(args), paintXaiOAuth() {} });
vm.runInContext(section(popup, "let lastWhy = ''", '\n// Sans filtre'), pc);
function startRefresh(audit = {}) {
  pc.refreshLive(); local.shift()({ csg_audit: audit, csg_crash: [] });
  oauth.shift()({ has: true }); queries.shift()([{ id: 1 }]);
}
startRefresh(); pages.shift()({ why: 'pas de chat', channel: 'twitch/old' });
startRefresh(); pages.shift()(null);
check('diagnostic d’un onglet précédent effacé sans réponse', () => {
  assert.equal(painted.at(-1)[3], ''); assert.equal(painted.at(-1)[4], null);
});
startRefresh({ version: 'old' });
startRefresh({ version: 'new' });
pages.pop()({ why: 'ok', channel: 'kick/new' });
const count = painted.length;
pages.shift()({ why: 'ancien défaut', channel: 'twitch/old' });
check('réponse tardive incapable de rétablir un ancien état', () => {
  assert.equal(painted.length, count);
  assert.equal(painted.at(-1)[4].channel, 'kick/new');
});

const ac = vm.createContext({ $ });
vm.runInContext(section(popup, 'let lastAudit = null', '\nfunction loadSettings'), ac);
vm.runInContext('ambienceError = "délai dépassé"; paintAmbienceStatus()', ac);
check('erreur visible si ambiance active', () => assert.match($('ambienceStatus').textContent, /Dernière erreur/));
$('enabled').checked = false; ac.paintAmbienceStatus();
check('filtre coupé prioritaire sur une ancienne erreur', () => assert.match($('ambienceStatus').textContent, /filtre désactivé/));
$('enabled').checked = true; $('ambiencePause').checked = false; ac.paintAmbienceStatus();
check('ambiance coupée prioritaire sur une ancienne erreur', () => assert.equal($('ambienceStatus').textContent, 'Désactivée.'));
$('ambiencePause').checked = true;
vm.runInContext('ambienceError = ""; paintAmbienceStatus()', ac);
check('rétablissement efface la cause passée', () => assert.match($('ambienceStatus').textContent, /^Active/));
const steps = [];
const hc = vm.createContext({ $, Date, liveUi: {mode:'off'}, fmt: String,
  setStep: (...args) => steps.push(args), shortChan: String, shortModel: () => 'Grok' });
vm.runInContext(section(popup, 'function isRateLimited', '\nfunction paintLed') + '\n' +
  section(popup, 'function paintChain', '\nconst FALLBACK_LANES'), hc);
$('enabled').checked = false;
hc.paintStatus({judge:false}, false, null, 'ok');
hc.paintChain({}, false, 'ok', {channel:'twitch/old'});
check('capture coupée signalée même avant la réponse de l’onglet', () => {
  assert.match($('status').textContent, /Capture désactivée/);
  assert.equal(steps[0][2], 'filtre coupé');
});
$('enabled').checked = true;
hc.paintStatus({judge:false}, false, null, '');
check('connexion manquante sans annoncer une capture active inconnue', () => {
  assert.match($('status').textContent, /^Connecte SuperGrok/);
});
hc.paintStatus({judge:false, waiting:15}, true, null, '');
check('captures passées distinguées du chat actuellement capté', () => {
  assert.match($('status').textContent, /^Captures conservées/);
});

const csvSection = section(board, 'function escapeCsv', '\nfunction formatLogCsvRows') + '\n' +
  section(board, 'function formatLogCsvRows', "\n$('exportFt').addEventListener");
vm.runInContext(csvSection, ctx);
check('échappement CSV protège les séparateurs, guillemets et retours à la ligne', () => {
  assert.equal(ctx.escapeCsv('simple'), 'simple');
  assert.equal(ctx.escapeCsv('avec, virgule'), '"avec, virgule"');
  assert.equal(ctx.escapeCsv('avec "guillemets"'), '"avec ""guillemets"""');
  assert.equal(ctx.escapeCsv('deux\nlignes'), '"deux\nlignes"');
  assert.equal(ctx.escapeCsv(null), '');
});
check('formatage CSV du journal génère les en-têtes et les valeurs alignées', () => {
  const sample = [{ ts: 1728480000000, channel: 'twitch/test', author: 'alice', text: 'coucou', label: 'keep', source: 'ia', score: 0.12 }];
  const formatted = ctx.formatLogCsvRows(sample);
  assert.equal(formatted.headers[0], 'Date_Heure');
  assert.equal(formatted.headers[3], 'Auteur');
  assert.equal(formatted.headers[4], 'Message');
  assert.equal(formatted.data[0][2], 'twitch/test');
  assert.equal(formatted.data[0][3], 'alice');
  assert.equal(formatted.data[0][4], 'coucou');
  assert.equal(formatted.data[0][5], 'keep');
});
check('double-clic sur le message disponible pour la copie', () => {
  vm.runInContext('logCache = fixture; renderLog()', ctx);
  const cell = $('logRows').children[0].children[3];
  assert.equal(typeof cell.listeners.dblclick, 'function');
});
check('filtre temporel et réinitialisation des filtres du journal', () => {
  const now = Date.now();
  const timeRows = [
    { id: 't1', ts: now - 5 * 60 * 1000, author: 'recent', channel: 'twitch/a', text: 'tout frais', label: 'keep' },
    { id: 't2', ts: now - 45 * 60 * 1000, author: 'mid', channel: 'kick/b', text: 'moyen', label: 'keep' },
    { id: 't3', ts: now - 2 * 3600 * 1000, author: 'old', channel: 'twitch/a', text: 'ancien', label: 'keep' }
  ];
  ctx.fixtureTime = timeRows;
  vm.runInContext('logCache = fixtureTime; renderLog()', ctx);
  assert.equal($('logRows').children.length, 3);
  $('logTime').value = '15m';
  vm.runInContext('renderLog()', ctx);
  assert.equal($('logRows').children.length, 1);
  assert.equal($('logRows').children[0].children[2].textContent, 'recent');
  $('logTime').value = '1h';
  vm.runInContext('renderLog()', ctx);
  assert.equal($('logRows').children.length, 2);

  // Filtrage plateforme Kick
  $('logTime').value = '';
  $('logPlatform').value = 'kick';
  vm.runInContext('renderLog()', ctx);
  assert.equal($('logRows').children.length, 1);
  assert.equal($('logRows').children[0].children[2].textContent, 'mid');

  // Filtrage plateforme Twitch
  $('logPlatform').value = 'twitch';
  vm.runInContext('renderLog()', ctx);
  assert.equal($('logRows').children.length, 2);

  $('logReset').listeners.click();
  assert.equal($('logTime').value, '');
  assert.equal($('logPlatform').value, '');
  assert.equal($('logSearch').value, '');
  assert.equal($('logRows').children.length, 3);
});

check('journal de bord (tab-log) : badge note modérateur et recherche par mot-clé de note', () => {
  ctx.authorNotesCache = {
    mid: { text: 'troll récidiviste', ts: 1000 }
  };
  $('logSearch').value = '';
  vm.runInContext('renderLog()', ctx);
  // La ligne de mid (index 1) a un badge 📝
  const midCell = $('logRows').children[1].children[2];
  assert.equal(midCell.textContent, 'mid');
  const badge = midCell.children && midCell.children.find((c) => c.textContent === '📝');
  assert.ok(badge);
  assert.equal(badge.title, 'Note : troll récidiviste');

  // Recherche dans le journal par texte de note
  $('logSearch').value = 'récidiviste';
  vm.runInContext('renderLog()', ctx);
  assert.equal($('logRows').children.length, 1);
  assert.equal($('logRows').children[0].children[2].textContent, 'mid');

  $('logSearch').value = '';
  ctx.authorNotesCache = {};
  vm.runInContext('renderLog()', ctx);
});

const wordsSection = section(popup, 'function updateExtraWordsCount', '\nlet extraT = null');
vm.runInContext(wordsSection, ac);
check('compteur de mots bannis réactif et accord singulier/pluriel', () => {
  ac.updateExtraWordsCount('');
  assert.equal($('extraWordsCount').textContent, '0 mot');
  ac.updateExtraWordsCount('chokeur');
  assert.equal($('extraWordsCount').textContent, '1 mot');
  ac.updateExtraWordsCount('chokeur, tilting, flame');
  assert.equal($('extraWordsCount').textContent, '3 mots');
  ac.updateExtraWordsCount('chokeur; tilting');
  assert.equal($('extraWordsCount').textContent, '2 mots');
  ac.updateExtraWordsCount('gg, ok, chokeur');
  assert.equal($('extraWordsCount').textContent, '1 mot · 2 trop courts');
});

const popupSettingsSection = section(popup, 'function loadSettings() {', '\nfunction patchSettings(');
const popupSetCtx = vm.createContext({
  $,
  document: { activeElement: null },
  chrome: {
    storage: {
      sync: {
        get: (defaults, cb) => cb({ csg_settings: { enabled: true, soundAlert: true, streamerMode: true } })
      },
      local: {
        get: (defaults, cb) => cb({ csg_muted: { troll1: { at: 100 }, troll2: { at: 200 } }, csg_ambience_error: '' })
      }
    }
  },
  paintAmbienceStatus: () => {},
  updateExtraWordsCount: () => {},
  updatePopupReportsBadge: () => {},
  syncDim: () => {},
  paintBaitStatus: () => {},
  refreshLive: () => {}
});
vm.runInContext(popupSettingsSection, popupSetCtx);
check('popup loadSettings charge le toggle sonore et le compteur de mutés', () => {
  popupSetCtx.loadSettings();
  assert.equal($('soundAlert').checked, true);
  assert.equal($('streamerMode').checked, true);
  assert.equal($('quickMuteCount').textContent, '2 pseudos mutés');
});

let copyCtx;
check('popup copyMutesBtn copie la liste des pseudos mutés', async () => {
  let copiedText = '';
  copyCtx = vm.createContext({
    $,
    chrome: {
      runtime: {
        sendMessage: (msg, cb) => { if (cb) cb({ ok: true }); }
      },
      storage: {
        local: {
          get: (defaults, cb) => cb({ csg_muted: { alice: {}, bob: {} }, csg_whitelist: { vip1: {}, vip2: {} } })
        }
      }
    },
    navigator: {
      clipboard: {
        writeText: async (t) => { copiedText = t; }
      }
    },
    setTimeout: (fn) => fn()
  });
  const copySection = section(popup, "if ($('copyMutesBtn')) {", '\nlet baitStatusCache');
  vm.runInContext(copySection, copyCtx);
  assert.equal(typeof $('copyMutesBtn').listeners.click, 'function');
  await $('copyMutesBtn').listeners.click();
  assert.equal(copiedText, 'alice\nbob');
});

check('popup copyWhitelistBtn copie la liste des pseudos whitelistés', async () => {
  let copiedWl = '';
  copyCtx.navigator.clipboard.writeText = async (t) => { copiedWl = t; };
  assert.equal(typeof $('copyWhitelistBtn').listeners.click, 'function');
  await $('copyWhitelistBtn').listeners.click();
  assert.equal(copiedWl, 'vip1\nvip2');
});

check('mute manuel direct depuis le popup', () => {
  let sentMute = null;
  copyCtx.chrome.runtime = {
    sendMessage: (msg, cb) => {
      sentMute = msg;
      cb({ ok: true });
    }
  };
  $('quickMuteInput').value = 'troll_direct';
  $('quickMuteBtn').listeners.click();
  assert.equal(sentMute.type, 'CSG_LOCAL_MUTE');
  assert.equal(sentMute.author, 'troll_direct');
  assert.equal(sentMute.perm, true);
  assert.equal($('quickMuteInput').value, '');
  assert.match($('quickMuteFeedback').textContent, /✓ troll_direct muté/);
});

check('whitelist directe depuis le popup', () => {
  let sentWl = null;
  copyCtx.chrome.runtime = {
    sendMessage: (msg, cb) => {
      sentWl = msg;
      cb({ ok: true });
    }
  };
  $('quickMuteInput').value = 'friendly_mod';
  $('quickWhitelistBtn').listeners.click();
  assert.equal(sentWl.type, 'CSG_WHITELIST');
  assert.equal(sentWl.names.join(','), 'friendly_mod');
  assert.equal(sentWl.on, true);
  assert.equal($('quickMuteInput').value, '');
  assert.match($('quickMuteFeedback').textContent, /✓ friendly_mod ajouté à la whitelist/);

  // Retrait de la whitelist si déjà présent (toggle)
  $('quickMuteInput').value = 'vip1';
  $('quickWhitelistBtn').listeners.click();
  assert.equal(sentWl.type, 'CSG_WHITELIST');
  assert.equal(sentWl.names.join(','), 'vip1');
  assert.equal(sentWl.on, false);
  assert.match($('quickMuteFeedback').textContent, /✓ vip1 retiré de la whitelist/);
});

check('aperçu dynamique du profil lors de la frappe dans le popup', () => {
  copyCtx.chrome.storage.local.get = (defaults, cb) => cb({
    csg_muted: { alice: {} },
    csg_whitelist: { vip1: {} },
    csg_author_notes: { alice: { text: 'troll récidiviste' } },
    csg_reports: { 'r1': { author: 'badguy', done: false } }
  });

  // Auteur muté avec note
  $('quickMuteInput').value = 'alice';
  $('quickMuteInput').listeners.input();
  assert.match($('quickMuteFeedback').textContent, /@alice · MUTÉ · 📝 troll récidiviste/);
  assert.equal($('quickMuteFeedback').classes.has('hidden'), false);
  assert.equal($('quickWhitelistBtn').textContent, 'Protéger');

  // Auteur whitelisté
  $('quickMuteInput').value = 'vip1';
  $('quickMuteInput').listeners.input();
  assert.match($('quickMuteFeedback').textContent, /@vip1 · WHITELISTÉ/);
  assert.equal($('quickWhitelistBtn').textContent, 'Déprotéger');

  // Auteur avec signalement actif
  $('quickMuteInput').value = 'badguy';
  $('quickMuteInput').listeners.input();
  assert.match($('quickMuteFeedback').textContent, /@badguy · non sanctionné · ⚠ signalement actif/);

  // Effacement de la saisie
  $('quickMuteInput').value = '';
  $('quickMuteInput').listeners.input();
  assert.equal($('quickMuteFeedback').textContent, '');
  assert.equal($('quickMuteFeedback').classes.has('hidden'), true);
  assert.equal($('quickWhitelistBtn').textContent, 'Protéger');
});

check('démute direct depuis le popup', () => {
  let sentUnmute = null;
  copyCtx.chrome.runtime = {
    sendMessage: (msg, cb) => {
      sentUnmute = msg;
      cb({ ok: true });
    }
  };
  // Utilisateur présent dans csg_muted (alice)
  $('quickMuteInput').value = 'alice';
  $('quickUnmuteBtn').listeners.click();
  assert.equal(sentUnmute.type, 'CSG_MUTE_REMOVE');
  assert.equal(sentUnmute.key, 'alice');
  assert.equal($('quickMuteInput').value, '');
  assert.equal($('quickMuteFeedback').textContent, '✓ alice démuté');

  // Utilisateur non muté
  $('quickMuteInput').value = 'unknown_user';
  $('quickUnmuteBtn').listeners.click();
  assert.equal(sentUnmute.key, 'unknown_user');
  assert.equal($('quickMuteFeedback').textContent, 'ℹ unknown_user n’était pas muté');
});

check('bouton dossier dans le popup ouvre board.html#author avec le pseudo', () => {
  let createdUrl = null;
  copyCtx.chrome.tabs = {
    create: (opts) => { createdUrl = opts.url; }
  };
  copyCtx.chrome.runtime.getURL = (u) => 'chrome-extension://csg/' + u;

  // Clic sans pseudo
  $('quickMuteInput').value = '';
  $('quickAuthorBtn').listeners.click();
  assert.equal(createdUrl, null);
  assert.match($('quickMuteFeedback').textContent, /Indique un pseudo/);

  // Clic avec pseudo
  $('quickMuteInput').value = 'troll_target';
  $('quickAuthorBtn').listeners.click();
  assert.equal(createdUrl, 'chrome-extension://csg/board.html#author?author=troll_target');
});

const extraSection = section(board, 'function extraChanLine', '\nfunction noneLine');
const extraCtx = vm.createContext({
  accord(n, one, many) { return n + ' ' + (Number(n) === 1 ? one : many); }
});
vm.runInContext(extraSection, extraCtx);
check('surplus de chats : un seul reste au singulier', () => {
  assert.equal(extraCtx.extraChanLine(1, 1), '+ 1 autre chat · 1 muté');
  assert.equal(extraCtx.extraChanLine(3, 4), '+ 3 autres chats · 4 mutés');
});

const chatsSection = section(board, 'function renderChats', "\nif ($('chatSearch'))");
const cc = vm.createContext({
  $,
  logCache: [
    { channel: 'twitch/streamer_a', label: 'mute', author: 'a1', ts: 100 },
    { channel: 'twitch/streamer_a', label: 'keep', author: 'a2', ts: 101 },
    { channel: 'kick/streamer_b', label: 'mute', author: 'a3', ts: 102 },
    { channel: 'oldchan', label: 'keep', author: 'bob', ts: 103 }
  ],
  rowLabel: (r) => r.label,
  chanChip: String,
  ago: () => '1 min',
  document: {
    createElement: () => new Element(),
    createTextNode: (t) => ({ text: String(t) })
  },
  goTab() {},
  refilterLog() {},
  rememberChan(sel, chan) { if (sel) sel.value = String(chan || ''); },
  repCache: {}
});
vm.runInContext(section(board, 'function splitChan', '\nfunction chanChip'), cc);
vm.runInContext(chatsSection, cc);
check('recherche et compteur de chats dans l’onglet par chat', () => {
  cc.renderChats();
  assert.equal($('chatCards').children.length, 3);
  assert.equal($('chatCount').textContent, '3 chats');
  $('chatSearch').value = 'kick';
  cc.renderChats();
  assert.equal($('chatCards').children.length, 1);
  assert.equal($('chatCount').textContent, '1 / 3 chats');
  $('chatSearch').value = 'twitch';
  cc.renderChats();
  assert.equal($('chatCards').children.length, 2);
  $('chatSearch').value = 'introuvable';
  cc.renderChats();
  assert.equal($('chatCards').children.length, 1);
  assert.match($('chatCards').children[0].textContent, /Aucun chat/);
});

check('cartes de chat : bouton Signalements avec badge et redirection vers tab-report', () => {
  let navigatedTab = null;
  let reportsRendered = false;
  cc.goTab = (tab) => { navigatedTab = tab; };
  cc.renderReports = () => { reportsRendered = true; };
  cc.repCache = {
    'rep1': { channel: 'twitch/streamer_a', done: false }
  };
  $('chatSearch').value = '';
  cc.renderChats();
  const card = $('chatCards').children[0];
  const actions = card.children[card.children.length - 1];
  const btnRep = (actions.children || []).find((c) => c.textContent && c.textContent.startsWith('Signalements'));
  assert.ok(btnRep, 'bouton Signalements présent sur la carte de chat');
  assert.equal(btnRep.textContent, 'Signalements (1)');
  assert.equal(btnRep.style.color, 'var(--warn)');

  btnRep.listeners.click();
  assert.equal($('repChan').value, 'twitch/streamer_a');
  assert.equal(navigatedTab, 'report');
  assert.equal(reportsRendered, true);
});

check('rememberChan ajoute un chat absent du menu pour que le filtre tienne', () => {
  const opts = [{ value: '' }];
  const sel = {
    options: opts,
    _value: '',
    appendChild(o) { opts.push(o); },
    set value(v) { this._value = opts.some((o) => o.value === v) ? v : ''; },
    get value() { return this._value; }
  };
  const fnCtx = vm.createContext({
    document: { createElement: () => ({ value: '', textContent: '' }) },
    chanLabel: (c) => 'Kick · ' + String(c).split('/')[1]
  });
  vm.runInContext(section(board, 'function rememberChan', '\nfunction fillChanSelect'), fnCtx);
  sel.value = 'kick/solochat';
  assert.equal(sel.value, '', 'un select ignore une valeur hors liste');
  fnCtx.rememberChan(sel, 'kick/solochat');
  assert.equal(sel.value, 'kick/solochat');
  assert.equal(opts.filter((o) => o.value === 'kick/solochat').length, 1);
});

const hlSection = section(board, 'function highlightText', '\nfunction renderLog');
const hc2 = vm.createContext({
  document: {
    createElement: () => new Element(),
    createTextNode: (t) => ({ text: String(t) })
  }
});
vm.runInContext(hlSection, hc2);
check('surbrillance textuelle découpe et marque les correspondances', () => {
  const container = new Element();
  hc2.highlightText(container, 'bonjour le chat', 'chat');
  assert.equal(container.children.length, 2);
  assert.equal(container.children[0].text, 'bonjour le ');
  assert.equal(container.children[1].textContent, 'chat');
  assert.equal(container.children[1].className, 'hl');
});

check('alt-clic sur l’auteur dans le journal filtre la recherche', () => {
  vm.runInContext('logCache = fixture; renderLog()', ctx);
  const authorCell = $('logRows').children[0].children[2];
  assert.equal(typeof authorCell.listeners.click, 'function');
  authorCell.listeners.click({ altKey: true });
  assert.equal($('logSearch').value, 'viewer1304');
  $('logReset').listeners.click();
  assert.equal($('logSearch').value, '');
});

const soundSection = section(board, 'function renderSoundPill', '\nif ($(\'exportMutes\'))');
const pillEl = new Element();
const pillSpan = new Element();
pillEl.querySelector = () => pillSpan;
nodes.set('soundPill', pillEl);
const sc = vm.createContext({
  $,
  localStorage: { getItem: () => '1', setItem: () => {} },
  playNotificationChime() {}
});
vm.runInContext('let soundAlertOn = true;\n' + soundSection, sc);
check('pastille sonore reflète l’état actif / inactif', () => {
  sc.renderSoundPill();
  assert.equal(pillSpan.textContent, 'Son actif');
  vm.runInContext('soundAlertOn = false; renderSoundPill()', sc);
  assert.equal(pillSpan.textContent, 'Son coupé');
});

const chimeSection = section(board, 'let audioCtx = null;', '\nlet soundAlertOn = false;');
const playedOscs = [];
class MockParam {
  constructor() { this.ramps = []; }
  setValueAtTime(val, t) { this.ramps.push({ type: 'set', val, t }); }
  exponentialRampToValueAtTime(val, t) { this.ramps.push({ type: 'ramp', val, t }); }
}
class MockOsc {
  constructor() { this.type = 'sine'; this.frequency = new MockParam(); }
  connect() {}
  start(t) { this.startedAt = t; }
  stop(t) { this.stoppedAt = t; }
}
class MockGain {
  constructor() { this.gain = new MockParam(); }
  connect() {}
}
class MockAudioContext {
  constructor() { this.currentTime = 12; this.state = 'running'; this.destination = {}; }
  createOscillator() { const o = new MockOsc(); playedOscs.push(o); return o; }
  createGain() { return new MockGain(); }
  resume() {}
}
const chimeCtx = vm.createContext({
  window: { AudioContext: MockAudioContext }
});
vm.runInContext(chimeSection, chimeCtx);

check('alerte sonore standard et urgente avec tonalité différenciée', () => {
  chimeCtx.playNotificationChime(false);
  assert.equal(playedOscs.length, 1);
  assert.equal(playedOscs[0].type, 'sine');
  assert.equal(playedOscs[0].frequency.ramps[0].val, 587.33);

  chimeCtx.playNotificationChime(true);
  assert.equal(playedOscs.length, 2);
  assert.equal(playedOscs[1].type, 'triangle');
  assert.equal(playedOscs[1].frequency.ramps[0].val, 440);
  assert.equal(playedOscs[1].frequency.ramps[1].val, 880);
  assert.equal(playedOscs[1].frequency.ramps[2].val, 1320);
});

const repListenerSection = section(board, '  if (changes.csg_reports) {', '\n  if (changes.csg_author_notes) {');
let chimeUrgentCalls = 0;
let reportsLoaded = 0;
const repCtx = vm.createContext({
  soundAlertOn: true,
  playNotificationChime: (urgent) => { if (urgent) chimeUrgentCalls++; },
  loadReportsSoon: () => { reportsLoaded++; }
});

check('arrivée d un signalement actif déclenche le carillon urgent si son actif', () => {
  repCtx.changes = {
    csg_reports: {
      oldValue: { 'r1': { id: 'r1', done: true } },
      newValue: { 'r1': { id: 'r1', done: true }, 'r2': { id: 'r2', done: false } }
    }
  };
  vm.runInContext(repListenerSection, repCtx);
  assert.equal(chimeUrgentCalls, 1);
  assert.equal(reportsLoaded, 1);

  // Pas d'alerte sonore si le son est désactivé
  repCtx.soundAlertOn = false;
  repCtx.changes = {
    csg_reports: {
      oldValue: {},
      newValue: { 'r3': { id: 'r3', done: false } }
    }
  };
  vm.runInContext(repListenerSection, repCtx);
  assert.equal(chimeUrgentCalls, 1);
  assert.equal(reportsLoaded, 2);
});

check('clic sur la puce chat dans le journal filtre la sélection', () => {
  const chipEl = new Element();
  const chanContext = vm.createContext({
    $,
    document: { createElement: () => new Element() },
    td: value => { const el = new Element(); el.textContent = typeof value === 'string' ? value : ''; return el; },
    chanChip: () => chipEl,
    labelChip: String,
    filterIndex: String,
    goTab() {},
    showAuthor() {},
    refilterLog: () => {}
  });
  vm.runInContext(section(board, 'const FILTER_INDEX_HINT', '\nfunction fillChanSelect') + '\n' +
    section(board, 'let logCache = []', '\nfunction downloadJsonl'), chanContext);
  chanContext.fixture = [{ id: '1', ts: 1000, author: 'bob', channel: 'twitch/testchan', text: 'bonjour' }];
  vm.runInContext('logCache = fixture; renderLog()', chanContext);
  assert.equal(typeof chipEl.listeners.click, 'function');
  chipEl.listeners.click({ stopPropagation() {} });
  assert.equal($('logChan').value, 'twitch/testchan');
});

(async () => {
  const authorSection = section(board, 'let authorCurrentMsgs = []', "\n$('authorLookup').addEventListener");
  const sentList = [];
  let authReply = { ok: true, msgs: [{ text: 'coucou', ts: 100, channel: 'twitch/a' }], muted: false, whitelisted: false };
  const authContext = vm.createContext({
    $,
    document: {
      createElement: () => new Element(),
      createTextNode: (t) => { const el = new Element(); el.textContent = t; return el; }
    },
    chanChip: () => new Element(),
    labelChip: () => new Element(),
    rowLabel: (m) => (m && (m.label || m.verdict)) || 'pending',
    accord: (n, s, p) => n + ' ' + (n > 1 ? p : s),
    filterIndex: (s) => String(s),
    fillChanSelect: () => {},
    loadMutes: () => {},
    setTimeout: (fn) => fn(),
    send: async (msg) => { sentList.push(msg); return authReply; }
  });
  vm.runInContext(authorSection, authContext);

  await check('dossier auteur standard : bouton muter visible et whitelist disponible', async () => {
    await authContext.showAuthor('troll');
    assert.equal($('authorMute').classes.has('hidden'), false);
    assert.equal($('authorUnmute').classes.has('hidden'), true);
    assert.equal($('authorWhitelist').textContent, 'Whitelister');
    assert.match($('authorMeta').textContent, /suivi/);
    await $('authorMute').onclick();
    const muteCall = sentList.find((m) => m.type === 'CSG_LOCAL_MUTE');
    assert.ok(muteCall);
    assert.equal(muteCall.author, 'troll');
    assert.equal(muteCall.reason, 'manuel');
  });

  await check('dossier auteur muté : bouton démuter disponible', async () => {
    authReply = { ok: true, msgs: [], muted: true, whitelisted: false };
    await authContext.showAuthor('troll');
    assert.equal($('authorMute').classes.has('hidden'), true);
    assert.equal($('authorUnmute').classes.has('hidden'), false);
    assert.match($('authorMeta').textContent, /MUTÉ/);
    await $('authorUnmute').onclick();
    const unmuteCall = sentList.find((m) => m.type === 'CSG_MUTE_REMOVE');
    assert.ok(unmuteCall);
    assert.equal(unmuteCall.key, 'troll');
  });

  await check('dossier auteur whitelisté : protégé contre le mute', async () => {
    authReply = { ok: true, msgs: [], muted: false, whitelisted: true };
    await authContext.showAuthor('ami');
    assert.equal($('authorMute').classes.has('hidden'), true);
    assert.equal($('authorUnmute').classes.has('hidden'), true);
    assert.equal($('authorWhitelist').textContent, 'Retirer de la whitelist');
    assert.match($('authorMeta').textContent, /WHITELISTÉ/);
    await $('authorWhitelist').onclick();
    const wlCall = sentList.find((m) => m.type === 'CSG_WHITELIST');
    assert.ok(wlCall);
    assert.equal(wlCall.names[0], 'ami');
    assert.equal(wlCall.on, false);
  });

  await check('dossier auteur sans nom ou vide réinitialise l affichage', async () => {
    await authContext.showAuthor('');
    assert.equal($('authorMeta').textContent, '');
    assert.equal($('authorMsgs').textContent, '');
    assert.equal($('authorMute').classes.has('hidden'), true);
    assert.equal($('authorUnmute').classes.has('hidden'), true);
    assert.equal($('authorWhitelist').classes.has('hidden'), true);
  });

  await check('dossier auteur décompte les messages rejetés et affiche le verdict', async () => {
    authReply = {
      ok: true,
      msgs: [
        { text: 'bienvenue', ts: 100, channel: 'twitch/a', label: 'keep' },
        { text: 'insulte', ts: 200, channel: 'twitch/a', label: 'mute' }
      ],
      muted: false,
      whitelisted: false
    };
    await authContext.showAuthor('testuser');
    assert.match($('authorMeta').textContent, /1 rejet/);
    assert.equal($('authorMsgs').children.length, 2);
    assert.equal($('authorReportBtn').classes.has('hidden'), false);
    assert.equal($('authorReportBtn').textContent, '+ Signaler');
    await $('authorReportBtn').onclick();
    const repCall = sentList.find((m) => m.type === 'CSG_REPORT_ADD');
    assert.ok(repCall);
    assert.equal(repCall.author, 'testuser');
    assert.equal(repCall.channel, 'twitch/a');
  });

  await check('dossier auteur avec signalement actif affiche l alerte et le bouton vers tab-report', async () => {
    let goneTab = null;
    let reportsLoaded = false;
    authContext.goTab = (t) => { goneTab = t; };
    authContext.renderReports = () => { reportsLoaded = true; };
    authContext.repCache = {
      'bad_guy:twitch/a': { author: 'bad_guy', channel: 'twitch/a', done: false }
    };
    authReply = { ok: true, msgs: [], muted: false, whitelisted: false };
    await authContext.showAuthor('bad_guy');
    assert.match($('authorMeta').textContent, /SIGNALEMENT EN COURS/);
    assert.equal($('authorReportBtn').classes.has('hidden'), false);
    assert.equal($('authorReportBtn').textContent, 'Dossier signalement');
    $('authorReportBtn').onclick();
    assert.equal($('repSearch').value, 'bad_guy');
    assert.equal(goneTab, 'report');
    assert.equal(reportsLoaded, true);
  });

  await check('dossier auteur suggère les suspects récents (signalés, mutés, rejets)', async () => {
    authContext.repCache = {
      'bad_guy:twitch/a': { author: 'bad_guy', channel: 'twitch/a', done: false }
    };
    authContext.mutedCache = {
      troll_mute: { perm: true, at: Date.now() - 1000 }
    };
    authContext.logCache = [
      { author: 'spammer_log', label: 'mute', verdict: 'mute' }
    ];
    authContext.renderRecentAuthors();
    const chips = $('authorRecentChips').children || [];
    assert.equal(chips.length, 3);
    assert.equal(chips[0].children[0].textContent, '@bad_guy');
    assert.equal(chips[0].children[1].textContent, 'signalé');
    assert.equal(chips[1].children[0].textContent, '@troll_mute');
    assert.equal(chips[1].children[1].textContent, 'perma');
    assert.equal(chips[2].children[0].textContent, '@spammer_log');
    assert.equal(chips[2].children[1].textContent, 'rejet');
    assert.equal($('authorRecentEmpty').classes.has('hidden'), true);

    // Clic sur une pastille de suspect charge le dossier
    let queriedAuthor = null;
    const origShowAuthor = authContext.showAuthor;
    authContext.showAuthor = (name) => { queriedAuthor = name; };
    chips[0].listeners.click();
    assert.equal($('authorQuery').value, 'bad_guy');
    assert.equal(queriedAuthor, 'bad_guy');
    authContext.showAuthor = origShowAuthor;
  });

  await check('notes de modération et liens Twitch/Kick dans le dossier auteur', async () => {
    authReply = { ok: true, msgs: [{ text: 'salut', ts: 100, channel: 'twitch/teststreamer' }], muted: false, whitelisted: false };
    await authContext.showAuthor('troll_noted');

    // Vérification des liens profil
    assert.equal($('authorProfileTwitch').classes.has('hidden'), false);
    assert.equal($('authorProfileTwitch').href, 'https://twitch.tv/troll_noted');
    assert.equal($('authorProfileKick').classes.has('hidden'), false);
    assert.equal($('authorProfileKick').href, 'https://kick.com/troll_noted');

    // Vérification de la boîte de note
    assert.equal($('authorNoteBox').classes.has('hidden'), false);
    assert.equal($('authorNoteDelete').classes.has('hidden'), true);

    // Enregistrement d'une note
    $('authorQuery').value = 'troll_noted';
    $('authorNoteInput').value = 'Averti pour spam majuscules';
    await $('authorNoteSave').listeners.click();

    // Note stockée dans le cache
    const cachedNote = vm.runInContext('authorNotesCache["troll_noted"]', authContext);
    assert.ok(cachedNote);
    assert.equal(cachedNote.text, 'Averti pour spam majuscules');

    // Message envoyé au background
    const noteMsg = sentList.find((m) => m.type === 'CSG_AUTHOR_NOTE_SET' && m.author === 'troll_noted');
    assert.ok(noteMsg);
    assert.equal(noteMsg.note, 'Averti pour spam majuscules');

    // Bouton de suppression devenu visible
    assert.equal($('authorNoteDelete').classes.has('hidden'), false);

    // Badge sur pastille récente si suspect
    authContext.repCache = { 'troll_noted:twitch/a': { author: 'troll_noted', channel: 'twitch/a', done: false } };
    authContext.renderRecentAuthors();
    const suspectChips = $('authorRecentChips').children || [];
    assert.equal(suspectChips[0].children[2].textContent, '📝');

    // Suppression de la note
    await $('authorNoteDelete').listeners.click();
    assert.equal(vm.runInContext('authorNotesCache["troll_noted"]', authContext), undefined);
    assert.equal($('authorNoteDelete').classes.has('hidden'), true);
    assert.equal($('authorNoteInput').value, '');
  });

  const bgSrc = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  check('messages à double origine autorisés depuis page interne et chat', () => {
    assert.ok(/const DUAL_ORIGIN_MSG\s*=\s*\{/.test(bgSrc), 'DUAL_ORIGIN_MSG défini');
    assert.ok(/CSG_MUTE_REMOVE:\s*1/.test(bgSrc), 'CSG_MUTE_REMOVE supporté');
    assert.ok(/CSG_LOCAL_MUTE:\s*1/.test(bgSrc), 'CSG_LOCAL_MUTE supporté');
    assert.ok(/CSG_WHITELIST:\s*1/.test(bgSrc), 'CSG_WHITELIST supporté');
    assert.ok(/CSG_OPEN_BOARD:\s*1/.test(bgSrc), 'CSG_OPEN_BOARD supporté');
    const bgContext = vm.createContext({
      checkAllowed: (type, sender) => {
        const chatOk = !!(sender && sender.tab && /^https?:\/\/([a-z0-9-]+\.)*(twitch\.tv|kick\.com)\//i.test(sender.tab.url));
        const extOk = String((sender && sender.url) || '').indexOf('chrome-extension://') === 0;
        const dual = { CSG_MUTE_REMOVE: 1, CSG_LOCAL_MUTE: 1, CSG_WHITELIST: 1 };
        const chat = { CSG_CAPTURE: 1, CSG_MUTE_REMOVE: 1, CSG_LOCAL_MUTE: 1, CSG_WHITELIST: 1 };
        if (dual[type] ? (!chatOk && !extOk) : (chat[type] ? !chatOk : !extOk)) return false;
        return true;
      }
    });
    const extSender = { url: 'chrome-extension://test-id/board.html' };
    const chatSender = { tab: { url: 'https://www.twitch.tv/streamer' } };
    const rogueSender = { url: 'https://evil.com/page' };
    assert.equal(bgContext.checkAllowed('CSG_MUTE_REMOVE', extSender), true);
    assert.equal(bgContext.checkAllowed('CSG_LOCAL_MUTE', extSender), true);
    assert.equal(bgContext.checkAllowed('CSG_WHITELIST', extSender), true);
    assert.equal(bgContext.checkAllowed('CSG_MUTE_REMOVE', chatSender), true);
    assert.equal(bgContext.checkAllowed('CSG_CAPTURE', chatSender), true);
    assert.equal(bgContext.checkAllowed('CSG_CAPTURE', extSender), false);
    assert.equal(bgContext.checkAllowed('CSG_FT_DUMP', chatSender), false);
    assert.equal(bgContext.checkAllowed('CSG_LOCAL_MUTE', rogueSender), false);
  });

  check('clic sur la puce chat dans les mutés déclenche refilterMutes', () => {
    const chipEl = new Element();
    let refiltered = 0;
    const mutesContext = vm.createContext({
      $,
      document: {
        createElement: () => new Element(),
        createTextNode: (val) => { const el = new Element(); el.textContent = val; return el; }
      },
      td: (value) => { const el = new Element(); el.textContent = typeof value === 'string' ? value : ''; return el; },
      chanChip: () => chipEl,
      muteChannels: () => ['twitch/testchan'],
      muteKind: () => 'ia',
      KIND_BY_ID: { ia: { label: 'modèle IA', color: '#3987e5' } },
      FILTER_INDEX_HINT: '',
      filterIndex: () => '90',
      ago: () => '1m',
      accord: (n, s, p) => n + ' ' + (n > 1 ? p : s),
      MUTE_PAGE: 30,
      muteShown: 30,
      refilterMutes: () => { refiltered++; },
      renderMuteDash: () => {},
      renderMutes: () => {},
      mutedCache: { troll: { at: 1000, channel: 'twitch/testchan', pct: 90 } }
    });
    $('mutePerm').checked = false;
    $('muteSearch').value = '';
    $('muteChan').value = '';
    $('muteKind').value = '';
    vm.runInContext(section(board, 'function renderMutes() {', '\nfunction refilterMutes() {'), mutesContext);
    mutesContext.renderMutes();
    assert.equal(typeof chipEl.listeners.click, 'function');
    chipEl.listeners.click({ stopPropagation() {} });
    assert.equal($('muteChan').value, 'twitch/testchan');
    assert.equal(refiltered, 1);
  });

  await check('modal mute manuel : ouverture et fermeture', async () => {
    const modalContext = vm.createContext({
      $,
      document: { createElement: () => new Element() },
      loadMutes: () => {},
      send: async () => ({ ok: true, applied: true })
    });
    vm.runInContext(section(board, 'function openMuteModal', "\n$('clearMutes').addEventListener('click'"), modalContext);

    $('muteChan').innerHTML = '<option value="">tous</option><option value="twitch/test">twitch/test</option>';
    $('muteChan').value = 'twitch/test';
    modalContext.openMuteModal('', 'twitch/test');
    assert.equal($('muteModalAuthor').value, '');
    assert.equal($('muteModalChan').value, 'twitch/test');
    assert.equal($('muteModalPerm').checked, true);
    assert.equal($('muteModal').open, true);

    modalContext.closeMuteModal();
    assert.equal($('muteModal').open, false);
  });

  await check('modal mute manuel : validation pseudo vide refuse', async () => {
    const modalContext = vm.createContext({
      $,
      document: { createElement: () => new Element() },
      loadMutes: () => {},
      send: async () => ({ ok: true, applied: true })
    });
    vm.runInContext(section(board, 'function openMuteModal', "\n$('clearMutes').addEventListener('click'"), modalContext);

    $('muteModalAuthor').value = '   ';
    await $('muteModalForm').listeners.submit({ preventDefault() {} });
    assert.match($('muteModalErr').textContent, /saisir un pseudo valide/);
    assert.equal($('muteModalErr').classes.has('hidden'), false);
  });

  await check('modal mute manuel : envoi avec canal, perm et motif', async () => {
    const sent = [];
    let reloaded = 0;
    const modalContext = vm.createContext({
      $,
      document: { createElement: () => new Element() },
      loadMutes: () => { reloaded++; },
      send: async (msg) => { sent.push(msg); return { ok: true, applied: true }; }
    });
    vm.runInContext(section(board, 'function openMuteModal', "\n$('clearMutes').addEventListener('click'"), modalContext);

    modalContext.openMuteModal('Spammeur_99', 'kick/salon');
    $('muteModalAuthor').value = '  @Spammeur_99  ';
    $('muteModalReason').value = 'harcelement';
    $('muteModalPerm').checked = true;

    await $('muteModalForm').listeners.submit({ preventDefault() {} });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'CSG_LOCAL_MUTE');
    assert.equal(sent[0].author, 'spammeur_99');
    assert.equal(sent[0].channel, 'kick/salon');
    assert.equal(sent[0].reason, 'harcelement');
    assert.equal(sent[0].perm, true);
    assert.equal($('muteModal').open, false);
    assert.equal(reloaded, 1);
  });

  await check('modal mute manuel : pré-remplissage de note, clic sur preset et enregistrement combiné', async () => {
    const sent = [];
    let reloaded = 0;
    const spamBtn = new Element();
    spamBtn.dataset = { reason: 'spam' };
    spamBtn.classList.add('preset-btn');
    $('muteModalPresets').querySelectorAll = (sel) => sel === '.preset-btn' ? [spamBtn] : [];

    const modalContext = vm.createContext({
      $,
      document: { createElement: () => new Element() },
      loadMutes: () => { reloaded++; },
      authorNotesCache: {
        spammeur_99: { text: 'mémo existant', ts: 1000 }
      },
      send: async (msg) => { sent.push(msg); return { ok: true, applied: true }; }
    });
    vm.runInContext(section(board, 'function openMuteModal', "\n$('clearMutes').addEventListener('click'"), modalContext);

    // Ouverture pré-remplit la note existante
    modalContext.openMuteModal('Spammeur_99', 'kick/salon');
    assert.equal($('muteModalAuthor').value, 'Spammeur_99');
    assert.equal($('muteModalNote').value, 'mémo existant');

    // Clic sur le preset "spam"
    $('muteModalPresets').listeners.click({ target: spamBtn });
    assert.equal($('muteModalReason').value, 'spam');
    assert.equal(spamBtn.classList.contains('on'), true);

    // Mise à jour de la note et validation
    $('muteModalNote').value = 'nouveau mémo spam';
    await $('muteModalForm').listeners.submit({ preventDefault() {} });

    assert.equal(sent.length, 2);
    assert.equal(sent[0].type, 'CSG_LOCAL_MUTE');
    assert.equal(sent[0].author, 'spammeur_99');
    assert.equal(sent[0].reason, 'spam');

    assert.equal(sent[1].type, 'CSG_AUTHOR_NOTE_SET');
    assert.equal(sent[1].author, 'spammeur_99');
    assert.equal(sent[1].text, 'nouveau mémo spam');

    assert.equal($('muteModal').open, false);
    assert.equal(reloaded, 1);
  });

  await check('modal mute manuel : rejet affiche message d erreur', async () => {
    const modalContext = vm.createContext({
      $,
      document: { createElement: () => new Element() },
      loadMutes: () => {},
      send: async () => ({ ok: true, applied: false })
    });
    vm.runInContext(section(board, 'function openMuteModal', "\n$('clearMutes').addEventListener('click'"), modalContext);

    $('muteModalAuthor').value = 'streamer_protect';
    modalContext.openMuteModal('streamer_protect');
    await $('muteModalForm').listeners.submit({ preventDefault() {} });
    assert.match($('muteModalErr').textContent, /Impossible de muter/);
    assert.equal($('muteModalErr').classes.has('hidden'), false);
  });

  check('clic sur la puce chat d un message auteur filtre le journal', () => {
    let goneTab = '';
    let refiltered = false;
    const authorChip = new Element();
    const testCtx = vm.createContext({
      $,
      document: { createElement: () => new Element() },
      chanChip: () => authorChip,
      goTab: (tab) => { goneTab = tab; },
      refilterLog: () => { refiltered = true; }
    });
    const chipHandler = (channel) => {
      const chip = testCtx.chanChip(channel);
      if (chip && chip.addEventListener && channel) {
        chip.addEventListener('click', (ev) => {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          if ($('logChan')) $('logChan').value = channel;
          testCtx.goTab('log');
          testCtx.refilterLog();
        });
      }
      return chip;
    };
    const chip = chipHandler('twitch/streamer');
    assert.equal(typeof chip.listeners.click, 'function');
    chip.listeners.click({ stopPropagation() {} });
    assert.equal($('logChan').value, 'twitch/streamer');
    assert.equal(goneTab, 'log');
    assert.equal(refiltered, true);
  });

  check('shouldPardonMute protège les mutes manuels et permanents', () => {
    const pardonCtx = vm.createContext({
      nickKey: (s) => String(s || '').toLowerCase().trim(),
      muteRowStillHolds: () => false
    });
    vm.runInContext(section(bgSrc, 'function shouldPardonMute(', '\nlet pardonDone = false;'), pardonCtx);
    const manualRec = { strikes: 'manuel', channel: 'twitch/test', pct: 100 };
    assert.equal(pardonCtx.shouldPardonMute('troll', manualRec, new Map()), false, 'mute manuel conservé');
    const permRec = { perm: true, channel: 'kick/test', pct: 90 };
    assert.equal(pardonCtx.shouldPardonMute('spammer', permRec, new Map()), false, 'mute permanent conservé');
    const aiRec = { strikes: 'llm', channel: 'twitch/test', pct: 95 };
    assert.equal(pardonCtx.shouldPardonMute('innocent', aiRec, new Map()), true, 'mute IA sans preuve pardonné');
  });

  check('addMute supporte callback de confirmation écriture', () => {
    let writeCalled = false;
    const addMuteCtx = vm.createContext({
      nickKey: (s) => String(s || '').toLowerCase().trim(),
      isSelf: (k) => k === 'self_bot',
      isWhitelisted: (k) => k === 'whitelist_user',
      authorHistory: new Map(),
      siteOf: () => 'twitch',
      mutedOn: () => null,
      mutedUsers: {},
      notifyMute: () => {},
      mergeWriteMutes: (mutator, done) => { writeCalled = true; mutator(addMuteCtx.mutedUsers); if (done) done(true); },
      AUDIT: { MUTE_MAX: 100 }
    });
    vm.runInContext(section(bgSrc, 'function addMute(', '\nfunction removeMute('), addMuteCtx);
    let rejected = false;
    addMuteCtx.addMute('self_bot', 1, 'manuel', {}, (ok) => { rejected = !ok; });
    assert.equal(rejected, true, 'refus self synchrone');
    let confirmed = false;
    addMuteCtx.addMute('bad_user', 1, 'manuel', { perm: true }, (ok) => { confirmed = ok; });
    assert.equal(confirmed, true, 'succès confirmé');
    assert.equal(writeCalled, true, 'mergeWriteMutes déclenché');
  });

  check('statistiques instantanées du journal affichent le décompte et pourcentage de rejets', () => {
    $('logReset').listeners.click();
    ctx.fixture = [
      { id: '1', ts: 1000, author: 'a1', text: 'coucou', label: 'keep' },
      { id: '2', ts: 1001, author: 'a2', text: 'salut', label: 'keep' },
      { id: '3', ts: 1002, author: 'a3', text: 'troll', label: 'mute' }
    ];
    vm.runInContext('logCache = fixture; logTotal = 3; renderLog()', ctx);
    assert.match($('logStats').textContent, /1 rejeté \(33%\) · 2 acceptés/);
  });

  check('journal : une file seulement en attente ne s’affiche pas comme 0 % de rejets', () => {
    ctx.fixture = [
      { id: 'p1', ts: 1000, author: 'loopcheck', text: 'bonjour', label: 'pending', source: 'one_click' },
      { id: 'p2', ts: 1001, author: 'autre', text: 'illisible', label: 'skip', source: 'llm_skip' }
    ];
    vm.runInContext('logCache = fixture; logTotal = 2; renderLog()', ctx);
    const stats = $('logStats').textContent;
    assert.match(stats, /1 en attente/);
    assert.match(stats, /1 ignoré/);
    assert.doesNotMatch(stats, /0 %|0%/);
    assert.doesNotMatch(stats, /rejeté/);
  });

  check('bouton revenir au direct visible lors du feuilletage et réinitialise la page', () => {
    const liveContext = vm.createContext({
      $,
      document: { createElement: () => new Element() },
      td: (v) => { const el = new Element(); el.textContent = typeof v === 'string' ? v : ''; return el; },
      chanChip: String, labelChip: String, filterIndex: String, goTab() {}, showAuthor() {}
    });
    vm.runInContext(section(board, 'const FILTER_INDEX_HINT', '\nfunction fillChanSelect') + '\n' +
      section(board, 'let logCache = []', '\nfunction downloadJsonl'), liveContext);
    $('logReset').listeners.click();
    liveContext.fixture = Array.from({ length: 150 }, (_, i) => ({ id: 'm' + i, ts: 1000 + i, author: 'u' + i, text: 't' + i, label: 'keep' }));
    let logReloaded = false;
    liveContext.loadLog = () => { logReloaded = true; };
    vm.runInContext('logCache = fixture; logTotal = 150; renderLog()', liveContext);
    assert.ok($('logJumpLive').classes.has('hidden'), 'masqué sur page 0');
    $('logOlder').listeners.click();
    assert.equal($('logJumpLive').classes.has('hidden'), false, 'visible sur page > 0');
    $('logJumpLive').listeners.click();
    assert.equal(vm.runInContext('logPage', liveContext), 0, 'page remise à 0');
    assert.ok($('logJumpLive').classes.has('hidden'), 're-masqué après saut');
    assert.equal(logReloaded, true, 'rechargement déclenché');
  });

  check('boutons de filtres rapides synchronisent les menus et re-filtrent le journal', () => {
    const presetBtn = new Element();
    presetBtn.dataset = { preset: 'mute' };
    const docQueryContext = vm.createContext({
      $,
      document: {
        createElement: () => new Element(),
        querySelectorAll: (sel) => sel === '.preset-btn' ? [presetBtn] : []
      },
      td: value => { const el = new Element(); el.textContent = typeof value === 'string' ? value : ''; return el; },
      chanChip: String, labelChip: String, filterIndex: String, goTab() {}, showAuthor() {}
    });
    vm.runInContext(section(board, 'const FILTER_INDEX_HINT', '\nfunction fillChanSelect') + '\n' +
      section(board, 'let logCache = []', '\nfunction downloadJsonl'), docQueryContext);

    assert.equal(typeof presetBtn.listeners.click, 'function');
    presetBtn.listeners.click();
    assert.equal($('logLabel').value, 'mute');
    assert.ok(presetBtn.classes.has('on'));

    $('logReset').listeners.click();
    assert.equal($('logLabel').value, '');
    assert.ok(!presetBtn.classes.has('on'));
  });

  await check('tri des mutés par date, indice ou pseudo alphabétique', async () => {
    let sentWl = null;
    const mutesContext = vm.createContext({
      $,
      document: {
        createElement: () => new Element(),
        createTextNode: (val) => { const el = new Element(); el.textContent = val; return el; }
      },
      td: (value) => { const el = new Element(); el.textContent = typeof value === 'string' ? value : ''; return el; },
      chanChip: () => new Element(),
      muteChannels: () => ['twitch/test'],
      muteKind: () => 'ia',
      KIND_BY_ID: { ia: { label: 'modèle IA', color: '#3987e5' } },
      FILTER_INDEX_HINT: '',
      filterIndex: () => '90',
      ago: () => '1m',
      accord: (n, s, p) => n + ' ' + (n > 1 ? p : s),
      send: async (msg) => { sentWl = msg; return { ok: true }; },
      loadMutes: () => {},
      MUTE_PAGE: 30,
      muteShown: 30,
      refilterMutes: () => {},
      renderMuteDash: () => {},
      renderMutes: () => {},
      mutedCache: {
        charlie: { at: 1000, pct: 50 },
        alice: { at: 3000, pct: 95 },
        bob: { at: 2000, pct: 70 }
      }
    });
    $('mutePerm').checked = false;
    $('muteSearch').value = '';
    $('muteChan').value = '';
    $('muteKind').value = '';
    vm.runInContext(section(board, 'function renderMutes() {', '\nfunction refilterMutes() {'), mutesContext);

    $('muteSort').value = 'date';
    mutesContext.renderMutes();
    assert.equal($('muteRows').children[0].children[0].textContent, 'alice');
    assert.equal($('muteRows').children[1].children[0].textContent, 'bob');
    assert.equal($('muteRows').children[2].children[0].textContent, 'charlie');

    $('muteSort').value = 'score';
    mutesContext.renderMutes();
    assert.equal($('muteRows').children[0].children[0].textContent, 'alice');
    assert.equal($('muteRows').children[1].children[0].textContent, 'bob');
    assert.equal($('muteRows').children[2].children[0].textContent, 'charlie');

    $('muteSort').value = 'name';
    mutesContext.renderMutes();
    assert.equal($('muteRows').children[0].children[0].textContent, 'alice');
    assert.equal($('muteRows').children[1].children[0].textContent, 'bob');
    assert.equal($('muteRows').children[2].children[0].textContent, 'charlie');

    // Recherche par mot-clé de note dans la table des mutés
    mutesContext.authorNotesCache = { bob: { text: 'alt de trollman', ts: 2000 } };
    mutesContext.renderMutes();
    // Le badge 📝 est présent sur la ligne de bob (index 1)
    const bobWho = $('muteRows').children[1].children[0];
    assert.equal(bobWho.children[0].textContent, '📝');
    assert.equal(bobWho.children[0].title, 'Note : alt de trollman');

    // Filtrer par mot-clé de la note
    $('muteSearch').value = 'trollman';
    mutesContext.renderMutes();
    assert.equal($('muteRows').children.length, 1);
    assert.equal($('muteRows').children[0].children[0].children[0].textContent, '📝');
    // Filtrer par case à cocher "avec note"
    $('muteSearch').value = '';
    $('muteNoted').checked = true;
    mutesContext.renderMutes();
    assert.equal($('muteRows').children.length, 1);
    assert.equal($('muteRows').children[0].children[0].textContent, 'bob');
    $('muteNoted').checked = false;
    mutesContext.renderMutes();

    // Bouton Protéger sur la ligne d'un muté
    const aliceAct = $('muteRows').children[0].children[5];
    const wlBtn = aliceAct.children[2];
    assert.ok(wlBtn);
    assert.equal(wlBtn.textContent, 'Protéger');
    assert.equal(typeof wlBtn.listeners.click, 'function');
    await wlBtn.listeners.click();
    assert.equal(sentWl.type, 'CSG_WHITELIST');
    assert.equal(sentWl.names.join(','), 'alice');
    assert.equal(sentWl.on, true);

    // Bouton Note sur la ligne d'un muté
    let sentNoteMsg = null;
    mutesContext.send = async (msg) => { sentNoteMsg = msg; return { ok: true }; };
    mutesContext.prompt = () => 'spammeur kick';
    const aliceNoteBtn = aliceAct.children[3];
    assert.ok(aliceNoteBtn);
    assert.equal(aliceNoteBtn.textContent, '+ Note');
    await aliceNoteBtn.listeners.click();
    assert.ok(sentNoteMsg);
    assert.equal(sentNoteMsg.type, 'CSG_AUTHOR_NOTE_SET');
    assert.equal(sentNoteMsg.author, 'alice');
    assert.equal(sentNoteMsg.text, 'spammeur kick');

    // Bob a déjà une note : le bouton affiche '📝 Note'
    const bobAct = $('muteRows').children[1].children[5];
    const bobNoteBtn = bobAct.children[3];
    assert.ok(bobNoteBtn);
    assert.equal(bobNoteBtn.textContent, '📝 Note');
  });

  await check('muteModal bouton Protéger pour basculer en Whitelist', async () => {
    let sentMsg = null;
    const modalCtx = vm.createContext({
      $,
      send: async (msg) => { sentMsg = msg; return { ok: true }; },
      closeMuteModal: () => { $('muteModal').open = false; },
      loadMutes: () => {}
    });
    const modalSection = section(board, "if ($('muteModalWhitelist')) {", '\n$(\'clearMutes\')');
    vm.runInContext(modalSection, modalCtx);
    $('muteModal').open = true;
    $('muteModalAuthor').value = 'troll_turned_vip';
    assert.equal(typeof $('muteModalWhitelist').listeners.click, 'function');
    await $('muteModalWhitelist').listeners.click();
    assert.equal(sentMsg.type, 'CSG_WHITELIST');
    assert.equal(sentMsg.names.join(','), 'troll_turned_vip');
    assert.equal(sentMsg.on, true);
    assert.equal($('muteModal').open, false);
  });

  check('panneau d\'aide contextuelle et raccourcis', () => {
    const helpContext = vm.createContext({
      $,
      document: {
        createElement: () => new Element()
      }
    });
    vm.runInContext(section(board, 'function openHelpModal() {', '\nif ($(\'addMuteBtn\')) {'), helpContext);
    const helpModal = $('helpModal');
    helpModal.classes.add('hidden');
    helpModal.open = false;

    // open via openHelpModal / helpPill
    $('helpPill').listeners.click();
    assert.equal(helpModal.open, true);
    assert.ok(!helpModal.classes.has('hidden'));

    // close via helpModalClose
    $('helpModalClose').listeners.click();
    assert.equal(helpModal.open, false);
    assert.ok(helpModal.classes.has('hidden'));

    // open and close via helpModalOk
    $('helpPill').listeners.click();
    assert.equal(helpModal.open, true);
    $('helpModalOk').listeners.click();
    assert.equal(helpModal.open, false);
  });

  check('filtrage et recherche dans le dossier auteur', () => {
    const authorContext = vm.createContext({
      $,
      document: {
        createElement: () => new Element(),
        createTextNode: (val) => { const el = new Element(); el.textContent = val; return el; }
      },
      chanChip: (ch) => { const el = new Element(); el.textContent = ch; return el; },
      labelChip: (lbl) => { const el = new Element(); el.textContent = lbl; return el; },
      rowLabel: (m) => m.label || (m.mute ? 'mute' : 'keep'),
      accord: (n, s, p) => n + ' ' + (n > 1 ? p : s),
      highlightText: (el, txt) => { el.textContent = txt; },
      authorCurrentMsgs: []
    });
    vm.runInContext(section(board, 'function renderAuthorMsgs() {', '\nif ($(\'authorMsgFilter\'))'), authorContext);

    authorContext.authorCurrentMsgs = [
      { ts: 1000, channel: 'twitch/main', text: 'bonjour tout le monde', label: 'keep' },
      { ts: 2000, channel: 'twitch/main', text: 'insulte grossiere et spam', label: 'mute' },
      { ts: 3000, channel: 'kick/alt', text: 'spam pub discord', label: 'mute' },
      { ts: 4000, channel: 'twitch/main', text: 'bonjour streamer', label: 'keep' }
    ];

    $('authorMsgFilter').value = '';
    $('authorMsgVerdict').value = '';
    authorContext.renderAuthorMsgs();

    assert.equal($('authorMsgs').children.length, 4);
    assert.equal($('authorMsgCount').textContent, '4 messages');
    assert.ok(!$('authorFilterBar').classes.has('hidden'));

    // Filter by keyword
    $('authorMsgFilter').value = 'bonjour';
    authorContext.renderAuthorMsgs();
    assert.equal($('authorMsgs').children.length, 2);
    assert.match($('authorMsgCount').textContent, /2 \/ 4 affichés/);

    // Filter by verdict mute
    $('authorMsgFilter').value = '';
    $('authorMsgVerdict').value = 'mute';
    authorContext.renderAuthorMsgs();
    assert.equal($('authorMsgs').children.length, 2);
    assert.match($('authorMsgCount').textContent, /2 \/ 4 affichés/);

    // Combined filter with 0 match
    $('authorMsgFilter').value = 'introuvable';
    authorContext.renderAuthorMsgs();
    assert.equal($('authorMsgs').children.length, 1);
    assert.match($('authorMsgs').children[0].textContent, /Aucun message ne correspond aux filtres/);

    // Filter by channel
    $('authorMsgFilter').value = '';
    $('authorMsgVerdict').value = '';
    $('authorMsgChan').value = 'kick/alt';
    authorContext.renderAuthorMsgs();
    assert.equal($('authorMsgs').children.length, 1);
    assert.match($('authorMsgCount').textContent, /1 \/ 4 affiché/);
    $('authorMsgChan').value = '';
  });

  check('authorExportCsv exporte les messages de l’auteur en CSV', () => {
    let exportedHeaders = null, exportedData = null, exportedFilename = '';
    const exportCtx = vm.createContext({
      $,
      alert: () => {},
      authorCurrentMsgs: [
        { ts: 1720000000000, channel: 'twitch/stream', text: 'spam message', label: 'mute', source: 'ia', score: 0.9 }
      ],
      rowLabel: (m) => m.label,
      filterIndex: (s) => String(s),
      formatLogCsvRows: (rows) => ({
        headers: ['Date_Heure', 'Horodatage_ms', 'Chat', 'Auteur', 'Message', 'Verdict'],
        data: rows.map(r => ['', r.ts, r.channel, 'bad_guy', r.text, r.label])
      }),
      downloadCsv: (h, d, fn) => {
        exportedHeaders = h;
        exportedData = d;
        exportedFilename = fn;
      }
    });
    $('authorQuery').value = 'bad_guy';
    $('authorMsgFilter').value = '';
    $('authorMsgVerdict').value = '';
    $('authorMsgChan').value = '';
    const exportSection = section(board, "if ($('authorExportCsv')) {", '\nif ($(\'authorCopyName\')) {');
    vm.runInContext(exportSection, exportCtx);
    assert.equal(typeof $('authorExportCsv').listeners.click, 'function');
    $('authorExportCsv').listeners.click();
    assert.equal(exportedFilename, 'csg-auteur-bad_guy');
    assert.equal(exportedData.length, 1);
    assert.equal(exportedData[0][4], 'spam message');
  });

  check('copie rapide des pseudos mutés selon filtres', () => {
    let clipboard = '';
    const muteContext = vm.createContext({
      $,
      alert: () => {},
      setTimeout: () => {},
      document: { createElement: () => new Element() },
      muteChannels: (r) => (r && r.chan ? [r.chan] : []),
      muteKind: (r) => (r && r.kind) || 'autre',
      mutedCache: {
        troll1: { chan: 'twitch/main', kind: 'ia', perm: false, strikes: 'insultes répétées', at: Date.now() - 10 * 60 * 1000 },
        spammer: { chan: 'kick/live', kind: 'local', perm: true, strikes: 'lien malveillant', at: Date.now() - 3 * 3600 * 1000 },
        troll2: { chan: 'twitch/main', kind: 'ia', perm: true, strikes: 'menaces graves', at: Date.now() - 48 * 3600 * 1000 }
      },
      navigator: {
        clipboard: {
          writeText: (t) => { clipboard = t; return Promise.resolve(); }
        }
      },
      splitChan: (chan) => {
        const parts = String(chan || '').split('/');
        return parts.length > 1 ? { site: parts[0], name: parts.slice(1).join('/') } : { site: chan ? 'twitch' : '', name: chan };
      }
    });
    vm.runInContext(section(board, 'function getFilteredMuteAuthors() {', '\nfunction openMuteModal('), muteContext);

    $('muteSearch').value = '';
    $('mutePlatform').value = '';
    $('muteChan').value = '';
    $('muteKind').value = '';
    $('mutePerm').checked = false;
    $('muteTime').value = '';

    // Tous les mutés
    const all = muteContext.getFilteredMuteAuthors();
    assert.equal(all.join(','), 'troll1,spammer,troll2');

    // Filtre période (1h, 24h, 7d)
    $('muteTime').value = '1h';
    const lastHour = muteContext.getFilteredMuteAuthors();
    assert.equal(lastHour.join(','), 'troll1');

    $('muteTime').value = '24h';
    const lastDay = muteContext.getFilteredMuteAuthors();
    assert.equal(lastDay.join(','), 'troll1,spammer');

    $('muteTime').value = '7d';
    const lastWeek = muteContext.getFilteredMuteAuthors();
    assert.equal(lastWeek.join(','), 'troll1,spammer,troll2');
    $('muteTime').value = '';

    // Filtre plateforme kick
    $('mutePlatform').value = 'kick';
    const kickOnly = muteContext.getFilteredMuteAuthors();
    assert.equal(kickOnly.join(','), 'spammer');

    // Filtre plateforme twitch
    $('mutePlatform').value = 'twitch';
    const twitchOnly = muteContext.getFilteredMuteAuthors();
    assert.equal(twitchOnly.join(','), 'troll1,troll2');
    $('mutePlatform').value = '';

    // Recherche par motif / strikes
    $('muteSearch').value = 'malveillant';
    const searched = muteContext.getFilteredMuteAuthors();
    assert.equal(searched.join(','), 'spammer');
    $('muteSearch').value = '';

    // Filtre permanent
    $('mutePerm').checked = true;
    const perms = muteContext.getFilteredMuteAuthors();
    assert.equal(perms.join(','), 'spammer,troll2');

    // Filtre canal twitch
    $('mutePerm').checked = false;
    $('muteChan').value = 'twitch/main';
    const twitch = muteContext.getFilteredMuteAuthors();
    assert.equal(twitch.join(','), 'troll1,troll2');

    // Clic sur copyMuteNames
    $('copyMuteNames').listeners.click();
    assert.equal(clipboard, 'troll1\ntroll2');
  });

  check('filtrage des chaînes par plateforme dans par chat', () => {
    const chatContext = vm.createContext({
      $,
      document: {
        createElement: () => new Element(),
        createTextNode: (val) => { const el = new Element(); el.textContent = val; return el; }
      },
      splitChan: (chan) => {
        const parts = String(chan || '').split('/');
        return parts.length > 1 ? { site: parts[0], name: parts.slice(1).join('/') } : { site: '', name: chan };
      },
      chanChip: (chan) => { const el = new Element(); el.textContent = chan; return el; },
      rowLabel: (m) => m.label || (m.mute ? 'mute' : 'keep'),
      ago: () => '1m',
      goTab: () => {},
      openMuteModal: () => {},
      refilterLog: () => {},
      rememberChan(sel, chan) { if (sel) sel.value = String(chan || ''); },
      showAuthor: () => {},
      logCache: [
        { channel: 'twitch/streamer1', author: 'u1', text: 'hi', label: 'keep', ts: 1000 },
        { channel: 'kick/streamer2', author: 'u2', text: 'yo', label: 'keep', ts: 2000 },
        { channel: 'twitch/streamer3', author: 'u3', text: 'hello', label: 'mute', ts: 3000 }
      ]
    });
    vm.runInContext(section(board, 'function renderChats() {', '\nif ($(\'chatSearch\'))'), chatContext);

    $('chatSearch').value = '';
    $('chatPlatform').value = '';
    $('chatSort').value = 'total';
    chatContext.renderChats();
    assert.equal($('chatCards').children.length, 3);
    assert.equal($('chatCount').textContent, '3 chats');

    // Filtre plateforme Kick
    $('chatPlatform').value = 'kick';
    chatContext.renderChats();
    assert.equal($('chatCards').children.length, 1);
    assert.match($('chatCount').textContent, /1 \/ 3 chats/);

    // Filtre plateforme Twitch
    $('chatPlatform').value = 'twitch';
    chatContext.renderChats();
    assert.equal($('chatCards').children.length, 2);
    assert.match($('chatCount').textContent, /2 \/ 3 chats/);

    // Tri alphabétique (name)
    $('chatPlatform').value = '';
    $('chatSort').value = 'name';
    chatContext.renderChats();
    assert.equal($('chatCards').children[0].children[0].children[0].textContent, 'kick/streamer2');
    assert.equal($('chatCards').children[1].children[0].children[0].textContent, 'twitch/streamer1');
    assert.equal($('chatCards').children[2].children[0].children[0].textContent, 'twitch/streamer3');

    // Tri par taux de rejet (rate)
    $('chatSort').value = 'rate';
    chatContext.renderChats();
    assert.equal($('chatCards').children[0].children[0].children[0].textContent, 'twitch/streamer3');

    // Bouton Voir mutés sur la première carte
    let goneTab = null;
    let refilteredMutes = false;
    chatContext.goTab = (t) => { goneTab = t; };
    chatContext.refilterMutes = () => { refilteredMutes = true; };
    const actions = $('chatCards').children[0].children[4];
    const btnMutes = actions.children[1];
    assert.equal(btnMutes.textContent, 'Voir mutés');
    btnMutes.listeners.click();
    assert.equal($('muteChan').value, 'twitch/streamer3');
    assert.equal(goneTab, 'mutes');
    assert.equal(refilteredMutes, true);
  });

  check('filtre chatMinRate, badge signalement et lien Live dans tab-chats', () => {
    let goneTab = null;
    const chatContext = vm.createContext({
      $,
      document: {
        createElement: () => new Element(),
        createTextNode: (val) => { const el = new Element(); el.textContent = val; return el; }
      },
      splitChan: (chan) => {
        const parts = String(chan || '').split('/');
        return parts.length > 1 ? { site: parts[0], name: parts.slice(1).join('/') } : { site: '', name: chan };
      },
      chanChip: (chan) => { const el = new Element(); el.textContent = chan; return el; },
      rowLabel: (m) => m.label || (m.mute ? 'mute' : 'keep'),
      ago: () => '1m',
      goTab: (t) => { goneTab = t; },
      openMuteModal: () => {},
      refilterLog: () => {},
      rememberChan(sel, chan) { if (sel) sel.value = String(chan || ''); },
      showAuthor: () => {},
      renderReports: () => {},
      repCache: {
        'twitch/streamer3:u3': { channel: 'twitch/streamer3', author: 'u3', done: 0 }
      },
      logCache: [
        { channel: 'twitch/streamer1', author: 'u1', text: 'hi', label: 'keep', ts: 1000 },
        { channel: 'kick/streamer2', author: 'u2', text: 'yo', label: 'keep', ts: 2000 },
        { channel: 'twitch/streamer3', author: 'u3', text: 'hello', label: 'mute', ts: 3000 }
      ]
    });
    vm.runInContext(section(board, 'function renderChats() {', '\nif ($(\'chatSearch\'))'), chatContext);

    // Initial : tous les taux
    $('chatSearch').value = '';
    $('chatPlatform').value = '';
    $('chatMinRate').value = '0';
    $('chatSort').value = 'rate';
    chatContext.renderChats();
    assert.equal($('chatCards').children.length, 3);

    // Filtre min rate >= 20% -> seul streamer3 (100%) doit être conservé
    $('chatMinRate').value = '20';
    chatContext.renderChats();
    assert.equal($('chatCards').children.length, 1);
    assert.match($('chatCount').textContent, /1 \/ 3 chats/);

    const card = $('chatCards').children[0];
    const header = card.children[0];
    assert.equal(header.children[0].textContent, 'twitch/streamer3');
    // Vérification du badge signalement actif
    assert.equal(header.children[3].textContent, '1 signalement');

    // Vérification des actions : btnRep et btnLive
    const actions = card.children[4];
    const btnRep = actions.children[3];
    assert.equal(btnRep.textContent, 'Signalements (1)');
    btnRep.listeners.click();
    assert.equal($('repChan').value, 'twitch/streamer3');
    assert.equal(goneTab, 'report');

    const btnLive = actions.children[4];
    assert.equal(btnLive.textContent, 'Live ↗');
    assert.equal(btnLive.href, 'https://twitch.tv/streamer3');
    assert.equal(btnLive.target, '_blank');

    // Vérification du lien Live Kick sur streamer2
    $('chatMinRate').value = '0';
    $('chatPlatform').value = 'kick';
    chatContext.renderChats();
    assert.equal($('chatCards').children.length, 1);
    const kickLive = $('chatCards').children[0].children[4].children[4];
    assert.equal(kickLive.textContent, 'Live ↗');
    assert.equal(kickLive.href, 'https://kick.com/streamer2');
    assert.equal(kickLive.target, '_blank');
  });

  await check('copyAllChanNames et export CSV d’un chat individuel', async () => {
    let copiedChans = '';
    let exportedHeaders = null, exportedData = null, exportedFilename = '';
    const chatExportCtx = vm.createContext({
      $,
      navigator: {
        clipboard: {
          writeText: async (t) => { copiedChans = t; }
        }
      },
      setTimeout: (fn) => fn(),
      alert: () => {},
      chanChip: (c) => { const el = new Element(); el.textContent = c; return el; },
      splitChan: (c) => ({ site: c.split('/')[0] || 'twitch', name: c.split('/')[1] || c }),
      rowLabel: (r) => r.label,
      ago: () => '2 min',
      openMuteModal: () => {},
      send: async () => ({
        ok: true,
        log: [
          { channel: 'twitch/streamer1', author: 'u1', text: 'hi', label: 'keep', ts: 1000 },
          { channel: 'kick/streamer2', author: 'u2', text: 'yo', label: 'keep', ts: 2000 }
        ]
      }),
      formatLogCsvRows: (rows) => ({
        headers: ['Date_Heure', 'Horodatage_ms', 'Chat', 'Auteur', 'Message', 'Verdict'],
        data: rows.map(r => ['', r.ts, r.channel, r.author, r.text, r.label])
      }),
      downloadCsv: (h, d, fn) => {
        exportedHeaders = h;
        exportedData = d;
        exportedFilename = fn;
      },
      document: {
        createElement: () => new Element(),
        createTextNode: (t) => ({ text: String(t) })
      },
      logCache: [
        { channel: 'twitch/streamer1', author: 'u1', text: 'hi', label: 'keep', ts: 1000 },
        { channel: 'kick/streamer2', author: 'u2', text: 'yo', label: 'keep', ts: 2000 }
      ]
    });
    const chatFullSection = section(board, 'let lastRenderedChans = [];', '\n// ---------------------------------------------------------------- auteur');
    vm.runInContext(chatFullSection, chatExportCtx);

    $('chatSearch').value = '';
    $('chatPlatform').value = '';
    $('chatSort').value = 'total';
    chatExportCtx.renderChats();

    // Test copyAllChanNames
    assert.equal(typeof $('copyAllChanNames').listeners.click, 'function');
    await $('copyAllChanNames').listeners.click();
    assert.equal(copiedChans, 'twitch/streamer1\nkick/streamer2');

    // Test card CSV export (first card is twitch/streamer1)
    const cardActions = $('chatCards').children[0].children[4];
    const exportBtn = cardActions.children.find(c => c && c.textContent === 'Exporter CSV');
    assert.ok(exportBtn);
    assert.equal(exportBtn.textContent, 'Exporter CSV');
    assert.equal(typeof exportBtn.listeners.click, 'function');
    await exportBtn.listeners.click();
    assert.equal(exportedFilename, 'csg-chat-twitch_streamer1');
    assert.equal(exportedData.length, 1);
    assert.equal(exportedData[0][2], 'twitch/streamer1');
  });

  await check('copie rapide du pseudo auteur dans le dossier', async () => {
    let clipboard = '';
    const authorCopyContext = vm.createContext({
      $,
      alert: () => {},
      setTimeout: () => {},
      navigator: {
        clipboard: {
          writeText: async (t) => { clipboard = t; }
        }
      }
    });
    vm.runInContext(section(board, 'if ($(\'authorCopyName\')) {', '\n// ------------------------------------------------------------ audit complet'), authorCopyContext);

    $('authorQuery').value = 'stream_sniper';
    await $('authorCopyName').listeners.click();
    assert.equal(clipboard, 'stream_sniper');
    assert.equal($('authorCopyName').textContent, 'Copié ✓');
  });

  await check('gestionnaire de whitelist et auteurs protégés', async () => {
    let sentMsg = null;
    let storageWl = { mod1: { at: 1000 }, vip_friend: { at: 2000 } };
    const wlContext = vm.createContext({
      $,
      document: { createElement: () => new Element() },
      send: async (msg) => {
        sentMsg = msg;
        if (msg.type === 'CSG_WHITELIST' && msg.on === false) {
          for (const n of msg.names) delete storageWl[n];
        }
        return { ok: true };
      },
      chrome: {
        storage: {
          local: {
            get: (_, cb) => cb({ csg_whitelist: storageWl })
          }
        }
      }
    });
    vm.runInContext(section(board, 'let whitelistCache = {};', '\n// ------------------------------------------------------------ mots bannis'), wlContext);

    const wlModal = $('whitelistModal');
    wlModal.classes.add('hidden');
    wlModal.open = false;

    // open modal
    $('whitelistBtn').listeners.click();
    await wlContext.loadWhitelist();
    assert.equal(wlModal.open, true);
    assert.ok(!wlModal.classes.has('hidden'));

    // chips rendered
    assert.equal($('whitelistChips').children.length, 2);
    assert.equal($('whitelistCount').textContent, '2 auteurs protégés');

    // filter search
    $('whitelistSearch').value = 'vip';
    wlContext.renderWhitelist();
    assert.equal($('whitelistChips').children.length, 1);
    assert.equal($('whitelistChips').children[0].children[0].textContent, 'vip_friend');

    // add new authors
    $('whitelistAddInput').value = 'streamer_bro, trusted_mod';
    await $('whitelistAddBtn').listeners.click();
    assert.equal(sentMsg.type, 'CSG_WHITELIST');
    assert.equal(sentMsg.names.join(','), 'streamer_bro,trusted_mod');
    assert.equal(sentMsg.on, true);

    // copie de la whitelist
    let copiedWl = '';
    wlContext.navigator = {
      clipboard: {
        writeText: async (t) => { copiedWl = t; }
      }
    };
    wlContext.confirm = () => true;

    $('whitelistSearch').value = 'vip';
    await $('whitelistCopyBtn').listeners.click();
    assert.equal(copiedWl, 'vip_friend');

    $('whitelistSearch').value = '';
    await $('whitelistCopyBtn').listeners.click();
    assert.match(copiedWl, /mod1/);
    assert.match(copiedWl, /vip_friend/);

    // vidage complet de la whitelist
    await $('whitelistClearBtn').listeners.click();
    assert.equal(sentMsg.type, 'CSG_WHITELIST');
    assert.equal(sentMsg.on, false);
    assert.equal($('whitelistChips').children.length, 0);

    // close modal
    $('whitelistModalClose').listeners.click();
    assert.equal(wlModal.open, false);
  });

  check('gestionnaire des mots bannis au clic', () => {
    let savedSettings = null;
    const wordsContext = vm.createContext({
      $,
      document: { createElement: () => new Element() },
      chrome: {
        storage: {
          sync: {
            get: (_, cb) => cb({ csg_settings: { extraWords: 'troll, noob' } }),
            set: (data) => { savedSettings = data; }
          }
        }
      }
    });
    vm.runInContext(section(board, 'function updateWordsCount(val) {', '\nif ($(\'addMuteBtn\')) {'), wordsContext);

    const wordsModal = $('wordsModal');
    wordsModal.classes.add('hidden');
    wordsModal.open = false;

    // count check
    wordsContext.updateWordsCount('choke, gg, badword');
    assert.equal($('wordsCount').textContent, '2 mots valides · 1 trop court');

    // open modal
    $('wordsBtn').listeners.click();
    assert.equal(wordsModal.open, true);

    // save words
    $('wordsInput').value = 'raid, spoil, hack';
    $('wordsModalSave').listeners.click();
    assert.equal(savedSettings && savedSettings.csg_settings && savedSettings.csg_settings.extraWords, 'raid, spoil, hack');
  });

  check('clic droit sur pseudo dans le journal pour muter', () => {
    let mutedAuthor = '', mutedChan = '';
    const who = new Element();
    const r = { author: 'troll_live', channel: 'twitch/main' };
    who.addEventListener('contextmenu', (e) => {
      if (e && e.preventDefault) e.preventDefault();
      mutedAuthor = r.author || '';
      mutedChan = r.channel || '';
    });
    who.listeners.contextmenu({ preventDefault: () => {}, stopPropagation: () => {} });
    assert.equal(mutedAuthor, 'troll_live');
    assert.equal(mutedChan, 'twitch/main');
  });

  let repCtx;
  check('tab-report : filtrage par chat et recherche', () => {
    const repSection = section(board, 'let repCache = {};', '\nasync function auditReport(');
    repCtx = vm.createContext({
      $,
      send: () => Promise.resolve({ ok: true, reports: {} }),
      chrome: { storage: { local: { get: (d, cb) => cb({}) } } },
      fillChanSelect: () => {},
      renderReports: () => {},
      splitChan: (chan) => {
        const parts = String(chan || '').split('/');
        return parts.length > 1 ? { site: parts[0], name: parts.slice(1).join('/') } : { site: chan ? 'twitch' : '', name: chan };
      }
    });
    vm.runInContext(repSection, repCtx);
    repCtx.fixture = {
      'alice:twitch/stream1': { author: 'alice', channel: 'twitch/stream1', done: false, lastAt: 100 },
      'bob:kick/stream2': { author: 'bob', channel: 'kick/stream2', done: false, lastAt: 200 },
      'charlie:twitch/stream1': { author: 'charlie', channel: 'twitch/stream1', done: true, lastAt: 300 }
    };
    vm.runInContext('repCache = fixture;', repCtx);
    $('repSearch').value = '';
    $('repPlatform').value = '';
    $('repDone').checked = false;
    $('repChan').value = '';

    // Without channel filter: alice and bob (charlie is done and repDone is false)
    let keys = repCtx.visibleReportKeys();
    assert.equal(keys.join(','), 'bob:kick/stream2,alice:twitch/stream1');

    // With platform filter: kick
    $('repPlatform').value = 'kick';
    keys = repCtx.visibleReportKeys();
    assert.equal(keys.join(','), 'bob:kick/stream2');

    // With platform filter: twitch
    $('repPlatform').value = 'twitch';
    keys = repCtx.visibleReportKeys();
    assert.equal(keys.join(','), 'alice:twitch/stream1');
    $('repPlatform').value = '';

    // With channel filter: twitch/stream1 only
    $('repChan').value = 'twitch/stream1';
    keys = repCtx.visibleReportKeys();
    assert.equal(keys.join(','), 'alice:twitch/stream1');

    // With repDone checked
    $('repDone').checked = true;
    keys = repCtx.visibleReportKeys();
    assert.equal(keys.join(','), 'alice:twitch/stream1,charlie:twitch/stream1');

    // Recherche par mot-clé dans les preuves textuelles (msgs)
    repCtx.fixture['alice:twitch/stream1'].msgs = [{ text: 'menace de raid et doxxing' }];
    repCtx.fixture['bob:kick/stream2'].msgs = [{ text: 'insulte simple' }];
    $('repSearch').value = 'doxx';
    $('repChan').value = '';
    $('repDone').checked = false;
    keys = repCtx.visibleReportKeys();
    assert.equal(keys.join(','), 'alice:twitch/stream1');
    $('repSearch').value = '';
  });

  check('tab-report : filtrage par statut de verdict IA (repVerdict)', () => {
    repCtx.fixture = {
      'confirmed:twitch/stream1': { author: 'troll1', channel: 'twitch/stream1', done: false, lastAt: 300, audit: { report: true } },
      'fp:twitch/stream1': { author: 'viewer2', channel: 'twitch/stream1', done: false, lastAt: 200, audit: { report: false } },
      'none:twitch/stream1': { author: 'viewer3', channel: 'twitch/stream1', done: false, lastAt: 100 }
    };
    vm.runInContext('repCache = fixture;', repCtx);
    $('repSearch').value = '';
    $('repDone').checked = false;
    $('repChan').value = '';

    // Filtrer 'report' (confirmés)
    $('repVerdict').value = 'report';
    let keys = repCtx.visibleReportKeys();
    assert.equal(keys.join(','), 'confirmed:twitch/stream1');

    // Filtrer 'fp' (faux positifs)
    $('repVerdict').value = 'fp';
    keys = repCtx.visibleReportKeys();
    assert.equal(keys.join(','), 'fp:twitch/stream1');

    // Filtrer 'none' (non audités)
    $('repVerdict').value = 'none';
    keys = repCtx.visibleReportKeys();
    assert.equal(keys.join(','), 'none:twitch/stream1');

    // Reset verdict
    $('repVerdict').value = '';
    keys = repCtx.visibleReportKeys();
    assert.equal(keys.join(','), 'confirmed:twitch/stream1,fp:twitch/stream1,none:twitch/stream1');
  });

  let repCtx2;
  await check('tab-report : repCopyNames copie les pseudos uniques visibles', async () => {
    let copiedText = '';
    let resetTimer = null;
    const repActionsSection = section(board, "if ($('repCopyNames')) {", '\n// ---------------------------------------------------------------- journal');
    repCtx2 = vm.createContext({
      $,
      navigator: {
        clipboard: {
          writeText: async (t) => { copiedText = t; }
        }
      },
      visibleReportKeys: () => ['alice:twitch/stream1', 'bob:kick/stream2'],
      repCache: {
        'alice:twitch/stream1': { author: 'alice' },
        'bob:kick/stream2': { author: 'bob' }
      },
      setTimeout: (fn) => { resetTimer = fn; },
      downloadJsonl: () => {},
      send: () => {},
      confirm: () => false,
      loadReports: () => {},
      dossierText: () => ''
    });
    vm.runInContext(repActionsSection, repCtx2);
    assert.equal(typeof $('repCopyNames').listeners.click, 'function');
    await $('repCopyNames').listeners.click();
    assert.equal(copiedText, 'alice\nbob');
    assert.equal($('repCopyNames').textContent, '✓ 2 copiés');
    if (resetTimer) resetTimer();
    assert.equal($('repCopyNames').textContent, 'Copier pseudos');
  });

  check('tab-report : repExportCsv exporte les dossiers visibles en CSV structuré', () => {
    let exportedHeaders = null;
    let exportedData = null;
    let exportedPrefix = null;
    repCtx2.downloadCsv = (headers, data, prefix) => {
      exportedHeaders = headers;
      exportedData = data;
      exportedPrefix = prefix;
    };
    repCtx2.splitSite = (c) => 'Twitch · stream1';
    repCtx2.repCache = {
      'alice:twitch/stream1': {
        author: 'alice',
        channel: 'twitch/stream1',
        done: false,
        lastAt: 1000,
        firstAt: 500,
        ext: 1,
        audit: { report: true },
        msgs: [{ ts: 500, text: 'menace grave', score: 85 }]
      }
    };
    repCtx2.visibleReportKeys = () => ['alice:twitch/stream1'];
    assert.equal(typeof $('repExportCsv').listeners.click, 'function');
    $('repExportCsv').listeners.click();
    assert.equal(exportedPrefix, 'csg-signalements');
    assert.equal(exportedHeaders.join(','), 'Date_Dernier_Message,Date_Premier_Message,Pseudo,Chat,Plateforme,Statut,Verdict_IA,Motif,Nb_Preuves,Messages_Preuves');
    assert.equal(exportedData.length, 1);
    const row = exportedData[0];
    assert.equal(row[2], 'alice');
    assert.equal(row[3], 'twitch/stream1');
    assert.equal(row[4], 'Twitch · stream1');
    assert.equal(row[5], 'À examiner');
    assert.equal(row[6], 'À signaler');
    assert.equal(row[7], 'Attaque grave détectée');
    assert.equal(row[8], 1);
    assert.match(row[9], /menace grave/);
    assert.match(row[9], /indice 85/);
  });

  check('tab-report : renderReports met à jour le badge cReportsTab dans la barre des onglets', () => {
    const repRenderSection = section(board, 'function renderReports() {', "\n$('repSearch').addEventListener('input', renderReports);");
    const repRenderCtx = vm.createContext({
      $,
      document: { createElement: () => new Element() },
      repCache: {
        'alice:twitch/stream1': { author: 'alice', channel: 'twitch/stream1', done: false, msgs: [{ text: 'grave' }] },
        'bob:kick/stream2': { author: 'bob', channel: 'kick/stream2', done: false, msgs: [{ text: 'insulte' }] },
        'charlie:twitch/stream1': { author: 'charlie', channel: 'twitch/stream1', done: true, msgs: [] }
      },
      splitSite: () => 'Twitch · stream1',
      ago: () => '1 m',
      chanChip: () => new Element(),
      filterIndex: (s) => String(s),
      FILTER_INDEX_HINT: 'hint',
      fillReportAudit: () => {},
      goTab: () => {},
      showAuthor: () => {},
      auditReport: () => {},
      repAuditing: new Set(),
      repAuditErr: {},
      visibleReportKeys: () => ['alice:twitch/stream1', 'bob:kick/stream2'],
      repBarBusy: false,
      splitChan: (chan) => {
        const parts = String(chan || '').split('/');
        return parts.length > 1 ? { site: parts[0], name: parts.slice(1).join('/') } : { site: chan ? 'twitch' : '', name: chan };
      }
    });
    $('repSearch').value = '';
    $('repDone').checked = false;
    $('repChan').value = '';
    vm.runInContext(repRenderSection, repRenderCtx);
    repRenderCtx.renderReports();

    // 2 non faits -> cReportsTab affiche 2, warn actif, hidden retiré
    assert.equal($('cReportsTab').textContent, '2');
    assert.equal($('cReportsTab').classList.contains('warn'), true);
    assert.equal($('cReportsTab').classList.contains('hidden'), false);

    // Tous faits -> cReportsTab affiche 0, warn retiré, hidden activé
    repRenderCtx.repCache['alice:twitch/stream1'].done = true;
    repRenderCtx.repCache['bob:kick/stream2'].done = true;
    repRenderCtx.renderReports();
    assert.equal($('cReportsTab').textContent, '0');
    assert.equal($('cReportsTab').classList.contains('warn'), false);
    assert.equal($('cReportsTab').classList.contains('hidden'), true);
  });

  check('tab-report : actions de modération rapide (Muter direct, Sanctionné, Twitch/Kick)', () => {
    const repRenderSection = section(board, 'function renderReports() {', "\n$('repSearch').addEventListener('input', renderReports);");
    let goneTab = null;
    let mutedTarget = null;
    let inspectedAuthor = null;
    const repActionCtx = vm.createContext({
      $,
      document: { createElement: () => new Element() },
      repCache: {
        'alice:twitch/stream1': { author: 'alice', channel: 'twitch/stream1', done: false, msgs: [{ text: 'grave' }] },
        'bob:kick/stream2': { author: 'bob', channel: 'kick/stream2', done: false, msgs: [{ text: 'insulte' }] }
      },
      mutedCache: {
        alice: { perm: true }
      },
      splitSite: () => 'Twitch · stream1',
      ago: () => '1 m',
      chanChip: () => new Element(),
      filterIndex: (s) => String(s),
      FILTER_INDEX_HINT: 'hint',
      fillReportAudit: () => {},
      goTab: (tab) => { goneTab = tab; },
      showAuthor: (a) => { inspectedAuthor = a; },
      refilterMutes: () => {},
      openMuteModal: (author, chan) => { mutedTarget = { author, chan }; },
      auditReport: () => {},
      repAuditing: new Set(),
      repAuditErr: {},
      visibleReportKeys: () => ['alice:twitch/stream1', 'bob:kick/stream2'],
      repBarBusy: false,
      splitChan: (chan) => {
        const parts = String(chan || '').split('/');
        return parts.length > 1 ? { site: parts[0], name: parts.slice(1).join('/') } : { site: chan ? 'twitch' : '', name: chan };
      }
    });

    $('repSearch').value = '';
    $('repDone').checked = false;
    $('repChan').value = '';
    vm.runInContext(repRenderSection, repActionCtx);
    repActionCtx.renderReports();

    const cards = $('repCards').children || [];
    assert.equal(cards.length, 2);

    // Carte Alice (Twitch, déjà mutée)
    const aliceCard = cards[0];
    const aliceActs = aliceCard.children[1];
    // Bouton signalement Twitch
    assert.equal(aliceActs.children[2].textContent, 'Signaler à Twitch');
    // Bouton Muter -> Sanctionné (car dans mutedCache)
    const aliceMuteBtn = aliceActs.children[3];
    assert.equal(aliceMuteBtn.textContent, 'Sanctionné');
    aliceMuteBtn.listeners.click();
    assert.equal($('muteSearch').value, 'alice');
    assert.equal(goneTab, 'mutes');

    // Bouton Dossier sur la carte Alice
    const aliceDossierBtn = aliceActs.children[6];
    assert.ok(aliceDossierBtn);
    assert.equal(aliceDossierBtn.textContent, 'Dossier');
    assert.equal(aliceDossierBtn.classList.contains('rep-dossier-btn'), true);
    aliceDossierBtn.listeners.click();
    assert.equal($('authorQuery').value, 'alice');
    assert.equal(goneTab, 'author');
    assert.equal(inspectedAuthor, 'alice');

    // Carte Bob (Kick, non muté)
    const bobCard = cards[1];
    const bobActs = bobCard.children[1];
    // Bouton signalement Kick
    assert.equal(bobActs.children[2].textContent, 'Signaler à Kick');
    // Bouton Muter actif
    const bobMuteBtn = bobActs.children[3];
    assert.equal(bobMuteBtn.textContent, 'Muter');
    bobMuteBtn.listeners.click();
    assert.deepEqual(mutedTarget, { author: 'bob', chan: 'kick/stream2' });
  });

  await check('tab-report : bouton + Ajouter permet de créer un dossier de signalement manuel', async () => {
    let sentMsg = null;
    let reloaded = false;
    let rendered = false;
    const addCtx = vm.createContext({
      $,
      prompt: () => 'target_chatter',
      alert: () => {},
      send: async (msg) => { sentMsg = msg; return { ok: true, n: 3 }; },
      loadReports: async () => { reloaded = true; },
      renderReports: () => { rendered = true; }
    });
    const addSection = section(board, "if ($('repAddManual')) {", "\n// ---------------------------------------------------------------- journal");
    vm.runInContext(addSection, addCtx);
    await $('repAddManual').listeners.click();
    assert.ok(sentMsg);
    assert.equal(sentMsg.type, 'CSG_REPORT_ADD');
    assert.equal(sentMsg.author, 'target_chatter');
    assert.equal(reloaded, true);
    assert.equal(rendered, true);
    assert.equal($('repSearch').value, 'target_chatter');
  });

  await check('tab-report : Tout marquer fait valide tous les dossiers visibles non faits', async () => {
    let sentMessages = [];
    let reportsReloaded = false;
    const repDoneCtx = vm.createContext({
      $,
      confirm: () => true,
      alert: () => {},
      send: async (msg) => { sentMessages.push(msg); return { ok: true }; },
      loadReports: () => { reportsReloaded = true; },
      visibleReportKeys: () => ['alice:twitch/stream1', 'bob:kick/stream2'],
      repCache: {
        'alice:twitch/stream1': { author: 'alice', channel: 'twitch/stream1', done: false },
        'bob:kick/stream2': { author: 'bob', channel: 'kick/stream2', done: false },
        'charlie:twitch/stream1': { author: 'charlie', channel: 'twitch/stream1', done: true }
      }
    });
    const markDoneSection = section(board, "if ($('repMarkAllDone')) {", "\nif ($('repExportCsv')) {");
    vm.runInContext(markDoneSection, repDoneCtx);
    await $('repMarkAllDone').listeners.click();
    assert.equal(sentMessages.length, 2);
    assert.equal(sentMessages[0].type, 'CSG_REPORT_DONE');
    assert.equal(sentMessages[0].key, 'alice:twitch/stream1');
    assert.equal(sentMessages[0].done, 1);
    assert.equal(sentMessages[1].key, 'bob:kick/stream2');
    assert.equal(sentMessages[1].done, 1);
    assert.equal(reportsReloaded, true);
  });

  check('onglets et raccourcis : touche 5 et clic onglet activent les signalements', () => {
    let goneTab = null;
    let loadedReports = false;
    const tabList = [
      new Element(), new Element(), new Element(), new Element(), new Element()
    ];
    tabList[0].dataset = { tab: 'mutes' };
    tabList[1].dataset = { tab: 'log' };
    tabList[2].dataset = { tab: 'chats' };
    tabList[3].dataset = { tab: 'author' };
    tabList[4].dataset = { tab: 'report' };

    const panes = [
      new Element(), new Element(), new Element(), new Element(), new Element()
    ];
    panes[0].id = 'tab-mutes';
    panes[1].id = 'tab-log';
    panes[2].id = 'tab-chats';
    panes[3].id = 'tab-author';
    panes[4].id = 'tab-report';

    const tabSection = section(board, '// ---------------------------------------------------------------- onglets\n', '\n// ---------------------------------------------------------------- mutés');
    const tabCtx = vm.createContext({
      $,
      document: {
        querySelectorAll: (sel) => {
          if (sel === '.tab') return tabList;
          if (sel === '.pane') return panes;
          return [];
        },
        querySelector: (sel) => {
          const m = sel.match(/data-tab="([^"]+)"/);
          if (m) return tabList.find((t) => t.dataset.tab === m[1]) || null;
          return null;
        }
      },
      loadLog: () => {},
      loadReports: () => { loadedReports = true; },
      pollBulk: () => {}
    });
    vm.runInContext(tabSection, tabCtx);

    // Clic sur l'onglet 4 (report)
    tabList[4].listeners.click();
    assert.equal(loadedReports, true);
    assert.equal(panes[4].classList.contains('on'), true);
    assert.equal(tabList[4].classList.contains('on'), true);

    // Raccourci touche 5
    const keySection = section(board, "if (e.key === '1') {", "\n  } else if (e.key === 'ArrowLeft') {") + '\n  }';
    const keyCtx = vm.createContext({
      goTab: (tab) => { goneTab = tab; },
      e: { key: '5' }
    });
    vm.runInContext(keySection, keyCtx);
    assert.equal(goneTab, 'report');
  });

  check('routage direct par hash et paramètres URL (applyInitialRoute et replaceState)', () => {
    let goneTab = null;
    let shownAuthor = null;
    let refilteredLog = false;
    let refilteredMutes = false;
    let loadedReports = false;

    const routeSection = section(board, 'function applyInitialRoute() {', '\nloadMutes();');
    const routeCtx = vm.createContext({
      $,
      location: { hash: '#report', search: '' },
      URLSearchParams,
      goTab: (t) => { goneTab = t; },
      showAuthor: (a) => { shownAuthor = a; },
      refilterLog: () => { refilteredLog = true; },
      refilterMutes: () => { refilteredMutes = true; },
      renderReports: () => { loadedReports = true; }
    });
    vm.runInContext(routeSection, routeCtx);

    // 1. Hash #report
    routeCtx.applyInitialRoute();
    assert.equal(goneTab, 'report');

    // 2. Hash #log avec query ?q=troll
    routeCtx.location.hash = '#log';
    routeCtx.location.search = '?q=troll';
    routeCtx.applyInitialRoute();
    assert.equal(goneTab, 'log');
    assert.equal($('logSearch').value, 'troll');
    assert.equal(refilteredLog, true);

    // 3. Paramètre ?author=bad_user
    routeCtx.location.hash = '';
    routeCtx.location.search = '?author=bad_user';
    routeCtx.applyInitialRoute();
    assert.equal(goneTab, 'author');
    assert.equal($('authorQuery').value, 'bad_user');
    assert.equal(shownAuthor, 'bad_user');

    // 4. Hash combiné avec query (#author?author=stream_troll)
    routeCtx.location.hash = '#author?author=stream_troll';
    routeCtx.location.search = '';
    routeCtx.applyInitialRoute();
    assert.equal(goneTab, 'author');
    assert.equal($('authorQuery').value, 'stream_troll');
    assert.equal(shownAuthor, 'stream_troll');

    // 5. Hash log avec filtre verdict (#log?verdict=mute)
    routeCtx.location.hash = '#log?verdict=mute';
    routeCtx.location.search = '';
    routeCtx.applyInitialRoute();
    assert.equal(goneTab, 'log');
    assert.equal($('logLabel').value, 'mute');
  });

  check('popup raccourcis tableau et badge de signalements (board-jump & popupRepBadge)', () => {
    let openedUrl = null;
    const jumpBtnReport = new Element();
    jumpBtnReport.dataset = { tab: 'report' };
    const jumpBtnLog = new Element();
    jumpBtnLog.dataset = { tab: 'log' };

    let reportsInStorage = {
      'case1:twitch/a': { author: 'case1', channel: 'twitch/a', done: false },
      'case2:kick/b': { author: 'case2', channel: 'kick/b', done: true }
    };

    const popupJumpCtx = vm.createContext({
      $,
      document: {
        querySelectorAll: (sel) => sel === '.board-jump' ? [jumpBtnReport, jumpBtnLog] : []
      },
      chrome: {
        runtime: {
          getURL: (path) => 'chrome-extension://id/' + path
        },
        tabs: {
          create: (opts) => { openedUrl = opts.url; }
        },
        storage: {
          local: {
            get: (keys, cb) => cb({ csg_reports: reportsInStorage })
          }
        }
      }
    });

    const popupJumpSection = section(popup, "if (typeof document.querySelectorAll === 'function') {", "\nif ($('quickMuteCount')) {");
    vm.runInContext(popupJumpSection, popupJumpCtx);

    // Clic sur raccourci Report
    jumpBtnReport.listeners.click({ stopPropagation: () => {} });
    assert.equal(openedUrl, 'chrome-extension://id/board.html#report');

    // Clic sur raccourci Log
    jumpBtnLog.listeners.click({ stopPropagation: () => {} });
    assert.equal(openedUrl, 'chrome-extension://id/board.html#log');

    // Test du badge
    const badgeSection = section(popup, 'function updatePopupReportsBadge() {', '\nfunction loadSettings() {');
    vm.runInContext(badgeSection, popupJumpCtx);
    popupJumpCtx.updatePopupReportsBadge();

    // 1 cas non fait -> badge affiche 1, warn actif, hidden retiré
    assert.equal($('popupRepBadge').textContent, '1');
    assert.equal($('popupRepBadge').classList.contains('warn'), true);
    assert.equal($('popupRepBadge').classList.contains('hidden'), false);

    // Tous faits -> badge masqué
    reportsInStorage['case1:twitch/a'].done = true;
    popupJumpCtx.updatePopupReportsBadge();
    assert.equal($('popupRepBadge').textContent, '0');
    assert.equal($('popupRepBadge').classList.contains('warn'), false);
    assert.equal($('popupRepBadge').classList.contains('hidden'), true);

    // Raccourcis tuiles statistiques (total et bad)
    const totalStat = new Element();
    const badStat = new Element();
    popupJumpCtx.document.querySelector = (sel) => {
      if (sel === '.stat.total') return totalStat;
      if (sel === '.stat.bad') return badStat;
      return null;
    };
    const tallySection = section(popup, 'function setupTallyShortcuts() {', "$('analyzeCaptured').addEventListener");
    vm.runInContext(tallySection, popupJumpCtx);

    totalStat.listeners.click();
    assert.equal(openedUrl, 'chrome-extension://id/board.html#log');

    badStat.listeners.click();
    assert.equal(openedUrl, 'chrome-extension://id/board.html#log?verdict=mute');
  });

  check('carte viewer chat (content.js) : bouton Dossier ouvre le tableau de bord', () => {
    const cardSection = section(content, 'function onBoardClick(e) {', 'function ensureCardObserver() {');
    let sentMsg = null;
    const cardSlot = new Element();
    cardSlot.querySelector = () => null;
    const cardNode = {
      querySelector: (sel) => sel === '.csg-wl-slot' ? cardSlot : null,
      appendChild: () => {}
    };
    const contentCtx = vm.createContext({
      ctxDead: () => false,
      CSG_VER: 'test',
      document: {
        querySelector: () => cardNode,
        createElement: () => new Element()
      },
      findViewerCards: () => [cardNode],
      cardNames: () => ['suspect_viewer'],
      isWhitelisted: () => false,
      isSelfName: () => false,
      mutedHere: () => false,
      handedHere: () => false,
      placeWl: () => {},
      stopCardEvent: () => {},
      onWlClick: () => {},
      onMuteClick: () => {},
      onHandClick: () => {},
      sendBg: (msg) => { sentMsg = msg; }
    });
    vm.runInContext(cardSection, contentCtx);
    contentCtx.paintViewerCards();

    // 4 boutons dans slot : whitelist, mute, hand, board
    const boardBtn = cardSlot.children.find((c) => c.classes && c.classes.has('csg-board-btn'));
    assert.ok(boardBtn, 'bouton csg-board-btn présent');
    assert.equal(boardBtn.textContent, 'Dossier');
    assert.equal(boardBtn.dataset.csgAuthor, 'suspect_viewer');

    // Clic sur le bouton Dossier
    boardBtn.listeners.click({ preventDefault: () => {}, stopPropagation: () => {}, currentTarget: boardBtn });
    assert.ok(sentMsg);
    assert.equal(sentMsg.type, 'CSG_OPEN_BOARD');
    assert.equal(sentMsg.tab, 'author');
    assert.equal(sentMsg.author, 'suspect_viewer');
  });

  check('carte viewer chat (content.js) : badges dynamiques signalement et note modérateur', () => {
    const cardSection = section(content, 'function onBoardClick(e) {', 'function ensureCardObserver() {');
    const cardSlot = new Element();
    const cardNode = {
      querySelector: (sel) => sel === '.csg-wl-slot' ? cardSlot : null,
      appendChild: () => {}
    };
    const contentCtx = vm.createContext({
      ctxDead: () => false,
      CSG_VER: 'test',
      document: {
        querySelector: () => cardNode,
        createElement: () => new Element()
      },
      findViewerCards: () => [cardNode],
      cardNames: () => ['warned_viewer'],
      isWhitelisted: () => false,
      isSelfName: () => false,
      mutedHere: () => false,
      handedHere: () => false,
      placeWl: () => {},
      stopCardEvent: () => {},
      onWlClick: () => {},
      onMuteClick: () => {},
      onHandClick: () => {},
      sendBg: () => {},
      activeReports: { 'rep_1': { author: 'warned_viewer', done: false } },
      authorNotes: {}
    });
    vm.runInContext(cardSection, contentCtx);
    contentCtx.paintViewerCards();

    let boardBtn = cardSlot.children.find((c) => c.classes && c.classes.has('csg-board-btn'));
    assert.ok(boardBtn);
    assert.equal(boardBtn.textContent, 'Dossier ⚠');
    assert.equal(boardBtn.classList.contains('warn'), true);
    assert.match(boardBtn.title, /Signalement actif/);

    // Cas note modérateur sans signalement actif
    const noteCardSlot = new Element();
    noteCardSlot.querySelector = () => null;
    const noteCardNode = {
      querySelector: (sel) => sel === '.csg-wl-slot' ? noteCardSlot : null,
      appendChild: () => {}
    };
    contentCtx.findViewerCards = () => [noteCardNode];
    contentCtx.cardNames = () => ['noted_viewer'];
    contentCtx.activeReports = {};
    contentCtx.authorNotes = { 'noted_viewer': { text: 'spammeur discord' } };
    contentCtx.paintViewerCards();

    boardBtn = noteCardSlot.children.find((c) => c.classes && c.classes.has('csg-board-btn'));
    assert.ok(boardBtn);
    assert.equal(boardBtn.textContent, 'Dossier 📝');
    assert.equal(boardBtn.classList.contains('noted'), true);
    assert.equal(boardBtn.classList.contains('warn'), false);
    assert.match(boardBtn.title, /spammeur discord/);
  });

  check('tab-mutes : exportMutesJson exporte la liste filtrée au format JSON structuré', () => {
    let exportedJsonData = null;
    let exportedPrefix = null;
    const mutesJsonSection = section(board, "if ($('exportMutesJson')) {", "\nfunction getFilteredMuteAuthors");
    const mutesJsonCtx = vm.createContext({
      $,
      alert: () => {},
      mutedCache: {
        'toxic_user': { at: 1700000000000, strikes: 'insulte', perm: true, pct: 92, channel: 'twitch/test' }
      },
      getFilteredMuteAuthors: () => ['toxic_user'],
      muteChannels: () => ['twitch/test'],
      muteKind: () => 'ia',
      KIND_BY_ID: { ia: { label: 'Modèle IA' } },
      authorNotesCache: { 'toxic_user': { text: 'averti par modérateur' } },
      downloadJson: (data, prefix) => {
        exportedJsonData = data;
        exportedPrefix = prefix;
      }
    });
    vm.runInContext(mutesJsonSection, mutesJsonCtx);
    assert.equal(typeof $('exportMutesJson').listeners.click, 'function');
    $('exportMutesJson').listeners.click();

    assert.equal(exportedPrefix, 'csg-mutes');
    assert.ok(Array.isArray(exportedJsonData));
    assert.equal(exportedJsonData.length, 1);
    assert.equal(exportedJsonData[0].author, 'toxic_user');
    assert.equal(exportedJsonData[0].reason, 'insulte');
    assert.equal(exportedJsonData[0].kind, 'Modèle IA');
    assert.equal(exportedJsonData[0].permanent, true);
    assert.equal(exportedJsonData[0].pct, 92);
    assert.equal(exportedJsonData[0].note, 'averti par modérateur');
  });

  check('tab-report : repExportJson exporte les signalements visibles en JSON structuré', () => {
    let exportedJsonData = null;
    let exportedPrefix = null;
    const repJsonSection = section(board, "if ($('repExportJson')) {", "\n$('repClear').addEventListener");
    const repJsonCtx = vm.createContext({
      $,
      alert: () => {},
      visibleReportKeys: () => ['troll:kick/live'],
      repCache: {
        'troll:kick/live': {
          author: 'troll',
          channel: 'kick/live',
          done: false,
          firstAt: 1000,
          lastAt: 2000,
          ext: 1,
          audit: { report: true },
          msgs: [{ ts: 1500, text: 'doxx menace', score: 99 }]
        }
      },
      splitSite: () => 'Kick · live',
      downloadJson: (data, prefix) => {
        exportedJsonData = data;
        exportedPrefix = prefix;
      }
    });
    vm.runInContext(repJsonSection, repJsonCtx);
    assert.equal(typeof $('repExportJson').listeners.click, 'function');
    $('repExportJson').listeners.click();

    assert.equal(exportedPrefix, 'csg-signalements');
    assert.ok(Array.isArray(exportedJsonData));
    assert.equal(exportedJsonData.length, 1);
    assert.equal(exportedJsonData[0].author, 'troll');
    assert.equal(exportedJsonData[0].channel, 'kick/live');
    assert.equal(exportedJsonData[0].platform, 'Kick · live');
    assert.equal(exportedJsonData[0].done, false);
    assert.equal(exportedJsonData[0].messages.length, 1);
    assert.equal(exportedJsonData[0].messages[0].text, 'doxx menace');
  });

  await check('tab-author : authorCopySummary copie la fiche de modération prête pour Discord', async () => {
    let copiedText = '';
    const authorSummarySection = section(board, "if ($('authorCopySummary')) {", "\nif ($('authorExportJson')) {");
    $('authorQuery').value = 'harceleur';
    const authorSummaryCtx = vm.createContext({
      $,
      alert: () => {},
      whitelistCache: {},
      mutedCache: { 'harceleur': { strikes: 'harcèlement répété', perm: true } },
      authorNotesCache: { 'harceleur': { text: 'averti vocalement en raid' } },
      repCache: { 'rep_1': { author: 'harceleur', done: false } },
      authorCurrentMsgs: [
        { ts: Date.now() - 60000, channel: 'twitch/main', t: 'message ok 1', label: 'keep' },
        { ts: Date.now() - 30000, channel: 'twitch/main', t: 'insulte grave', label: 'mute' }
      ],
      rowLabel: (m) => m.label,
      navigator: {
        clipboard: {
          writeText: async (t) => { copiedText = t; }
        }
      }
    });
    vm.runInContext(authorSummarySection, authorSummaryCtx);
    assert.equal(typeof $('authorCopySummary').listeners.click, 'function');
    await $('authorCopySummary').listeners.click();

    assert.match(copiedText, /FICHE MODÉRATEUR REFCHAT — @harceleur/);
    assert.match(copiedText, /MUTÉ \(harcèlement répété\)/);
    assert.match(copiedText, /twitch\/main/);
    assert.match(copiedText, /averti vocalement en raid/);
    assert.match(copiedText, /DOSSIER EN COURS DE TRAITEMENT/);
    assert.match(copiedText, /2 messages/);
    assert.match(copiedText, /1 rejet/);
    assert.match(copiedText, /insulte grave/);
    assert.equal($('authorCopySummary').textContent, 'Fiche copiée ✓');
  });

  check('tab-author : authorExportJson télécharge le dossier auteur complet en JSON', () => {
    let exportedJsonData = null;
    let exportedPrefix = null;
    const authorExportSection = section(board, "if ($('authorExportJson')) {", "\nif ($('authorCopyName')) {");
    $('authorQuery').value = 'harceleur';
    const authorExportCtx = vm.createContext({
      $,
      alert: () => {},
      whitelistCache: {},
      mutedCache: { 'harceleur': { strikes: 'harcèlement répété', perm: true, at: 12345 } },
      authorNotesCache: { 'harceleur': { text: 'averti vocalement en raid', ts: 12000 } },
      repCache: { 'rep_1': { author: 'harceleur', channel: 'twitch/main', done: false, ext: 1, msgs: [{ text: 'insulte grave' }] } },
      authorCurrentMsgs: [
        { ts: 12340, channel: 'twitch/main', t: 'message ok 1', label: 'keep', source: 'ia' },
        { ts: 12345, channel: 'twitch/main', t: 'insulte grave', label: 'mute', source: 'local' }
      ],
      rowLabel: (m) => m.label,
      downloadJson: (data, prefix) => {
        exportedJsonData = data;
        exportedPrefix = prefix;
      }
    });
    vm.runInContext(authorExportSection, authorExportCtx);
    assert.equal(typeof $('authorExportJson').listeners.click, 'function');
    $('authorExportJson').listeners.click();

    assert.equal(exportedPrefix, 'refchat-author-harceleur');
    assert.equal(exportedJsonData.author, 'harceleur');
    assert.equal(exportedJsonData.status.muted, true);
    assert.equal(exportedJsonData.status.strikes, 'harcèlement répété');
    assert.equal(exportedJsonData.note.text, 'averti vocalement en raid');
    assert.equal(exportedJsonData.report.channel, 'twitch/main');
    assert.equal(exportedJsonData.report.done, false);
    assert.equal(exportedJsonData.stats.totalMessages, 2);
    assert.equal(exportedJsonData.stats.rejectedCount, 1);
    assert.equal(exportedJsonData.stats.rejectionRate, '50%');
    assert.equal(exportedJsonData.messages.length, 2);
  });

  await check('wordsModal : actions rapides copier, exporter et effacer', async () => {
    let copiedWords = '';
    let savedBlobData = null;
    let savedBlobFilename = null;
    const wordsActionsSection = section(board, "if ($('wordsCopyBtn')) {", "\nconst wordsModalEl");
    $('wordsInput').value = 'insulte, haine, spam';
    const wordsActionsCtx = vm.createContext({
      $,
      alert: () => {},
      confirm: () => true,
      updateWordsCount: () => {},
      saveBlob: (blob, filename) => {
        savedBlobData = blob;
        savedBlobFilename = filename;
      },
      Blob: class MockBlob {
        constructor(parts, opts) { this.parts = parts; this.opts = opts; }
      },
      navigator: {
        clipboard: {
          writeText: async (t) => { copiedWords = t; }
        }
      }
    });
    vm.runInContext(wordsActionsSection, wordsActionsCtx);

    // Test Copier
    assert.equal(typeof $('wordsCopyBtn').listeners.click, 'function');
    await $('wordsCopyBtn').listeners.click();
    assert.equal(copiedWords, 'insulte, haine, spam');
    assert.equal($('wordsCopyBtn').textContent, 'Copié ✓');

    // Test Exporter
    assert.equal(typeof $('wordsExportTxt').listeners.click, 'function');
    $('wordsExportTxt').listeners.click();
    assert.match(savedBlobFilename, /^refchat-mots-bannis-/);
    assert.equal(savedBlobData.parts[0], 'insulte, haine, spam\n');

    // Test Effacer
    assert.equal(typeof $('wordsClearBtn').listeners.click, 'function');
    $('wordsClearBtn').listeners.click();
    assert.equal($('wordsInput').value, '');
  });

  check('raccourcis clavier : s (son), m (mute), w (whitelist), b (mots bannis), r (rafraîchir)', () => {
    let soundClicked = false;
    let mutedOpened = false;
    let wlOpened = false;
    let wordsOpened = false;
    let refreshed = false;

    $('soundPill').listeners.click = () => { soundClicked = true; };

    const shortcutsSection = section(board, "  const keyLower = String(e.key || '').toLowerCase();", "\n  if (e.key === '1') {");
    const shortcutsCtx = vm.createContext({
      $,
      openMuteModal: () => { mutedOpened = true; },
      openWhitelistModal: () => { wlOpened = true; },
      openWordsModal: () => { wordsOpened = true; },
      loadLog: () => { refreshed = true; },
      document: { querySelector: () => ({ id: 'tab-log' }) }
    });

    // Test S
    shortcutsCtx.e = { key: 's', preventDefault() {} };
    vm.runInContext('(() => {\n' + shortcutsSection + '\n})()', shortcutsCtx);
    assert.equal(soundClicked, true);

    // Test M
    shortcutsCtx.e = { key: 'm', preventDefault() {} };
    vm.runInContext('(() => {\n' + shortcutsSection + '\n})()', shortcutsCtx);
    assert.equal(mutedOpened, true);

    // Test W
    shortcutsCtx.e = { key: 'w', preventDefault() {} };
    vm.runInContext('(() => {\n' + shortcutsSection + '\n})()', shortcutsCtx);
    assert.equal(wlOpened, true);

    // Test B
    shortcutsCtx.e = { key: 'b', preventDefault() {} };
    vm.runInContext('(() => {\n' + shortcutsSection + '\n})()', shortcutsCtx);
    assert.equal(wordsOpened, true);

    // Test R
    shortcutsCtx.e = { key: 'r', preventDefault() {} };
    vm.runInContext('(() => {\n' + shortcutsSection + '\n})()', shortcutsCtx);
    assert.equal(refreshed, true);

    // Test C
    let backupOpened = false;
    shortcutsCtx.openBackupModal = () => { backupOpened = true; };
    shortcutsCtx.e = { key: 'c', preventDefault() {} };
    vm.runInContext('(() => {\n' + shortcutsSection + '\n})()', shortcutsCtx);
    assert.equal(backupOpened, true);

    // Test H
    let auditOpened = false;
    shortcutsCtx.openAuditModal = () => { auditOpened = true; };
    shortcutsCtx.e = { key: 'h', preventDefault() {} };
    vm.runInContext('(() => {\n' + shortcutsSection + '\n})()', shortcutsCtx);
    assert.equal(auditOpened, true);

    // Test P
    let streamerToggled = false;
    shortcutsCtx.toggleStreamerMode = () => { streamerToggled = true; };
    shortcutsCtx.e = { key: 'p', preventDefault() {} };
    vm.runInContext('(() => {\n' + shortcutsSection + '\n})()', shortcutsCtx);
    assert.equal(streamerToggled, true);

    // Test L
    let sessionOpened = false;
    shortcutsCtx.openSessionModal = () => { sessionOpened = true; };
    shortcutsCtx.e = { key: 'l', preventDefault() {} };
    vm.runInContext('(() => {\n' + shortcutsSection + '\n})()', shortcutsCtx);
    assert.equal(sessionOpened, true);

    // Test O
    let presetOpened = false;
    shortcutsCtx.openPresetModal = () => { presetOpened = true; };
    shortcutsCtx.e = { key: 'o', preventDefault() {} };
    vm.runInContext('(() => {\n' + shortcutsSection + '\n})()', shortcutsCtx);
    assert.equal(presetOpened, true);

    // Test U
    let moodOpened = false;
    shortcutsCtx.openMoodModal = () => { moodOpened = true; };
    shortcutsCtx.e = { key: 'u', preventDefault() {} };
    vm.runInContext('(() => {\n' + shortcutsSection + '\n})()', shortcutsCtx);
    assert.equal(moodOpened, true);

    // Test K
    let macrosOpened = false;
    shortcutsCtx.openMacrosModal = () => { macrosOpened = true; };
    shortcutsCtx.e = { key: 'k', preventDefault() {} };
    vm.runInContext('(() => {\n' + shortcutsSection + '\n})()', shortcutsCtx);
    assert.equal(macrosOpened, true);

    // Test X
    let regexOpened = false;
    shortcutsCtx.openRegexModal = () => { regexOpened = true; };
    shortcutsCtx.e = { key: 'x', preventDefault() {} };
    vm.runInContext('(() => {\n' + shortcutsSection + '\n})()', shortcutsCtx);
    assert.equal(regexOpened, true);
  });

  await check('sauvegarde & restauration : getFullBackupPayload et applyBackupData (merge & replace)', async () => {
    let savedSync = null;
    let savedLocal = null;
    let renderedWhitelist = false;
    let renderedMutes = false;
    let mutesReloaded = false;

    const backupSection = section(board, "let pendingBackupData = null;", "\n// ---------------------------------------------------------------- raccourcis clavier");
    const backupCtx = vm.createContext({
      $,
      alert: () => {},
      confirm: () => true,
      downloadJson: () => {},
      renderWhitelist: () => { renderedWhitelist = true; },
      renderMutes: () => { renderedMutes = true; },
      loadMutes: () => { mutesReloaded = true; },
      whitelistCache: { 'vip_user': 1 },
      authorNotesCache: { 'troll_user': { text: 'note' } },
      mutedCache: { 'spammer': { at: 100, strikes: 'spam' } },
      chrome: {
        runtime: { getManifest: () => ({ version: '3.35.44' }) },
        storage: {
          sync: {
            get: (defs, cb) => cb({ csg_settings: { extraWords: 'spoil, hack', mode: 'block' } }),
            set: (val, cb) => { savedSync = val; if (cb) cb(); }
          },
          local: {
            set: (val, cb) => {
              savedLocal = Object.assign(savedLocal || {}, val);
              if (cb) cb();
            }
          }
        }
      }
    });
    vm.runInContext(backupSection, backupCtx);

    // Test 1: getFullBackupPayload
    const payload = await backupCtx.getFullBackupPayload();
    assert.equal(payload.refchatBackup, true);
    assert.equal(payload.version, '3.35.44');
    assert.equal(payload.whitelist.vip_user, 1);
    assert.equal(payload.authorNotes.troll_user.text, 'note');
    assert.equal(payload.muted.spammer.strikes, 'spam');
    assert.equal(payload.settings.extraWords, 'spoil, hack');

    // Test 2: openBackupModal & updateBackupExportSummary
    backupCtx.openBackupModal();
    assert.equal($('backupModal').open, true);
    await backupCtx.updateBackupExportSummary();
    assert.match($('backupExportSummary').textContent, /1 auteur protégé/);
    assert.match($('backupExportSummary').textContent, /1 note/);
    assert.match($('backupExportSummary').textContent, /2 mots bannis/);
    assert.match($('backupExportSummary').textContent, /1 auteur muté/);

    // Test 3: applyBackupData en mode Fusion (replaceMode = false)
    const externalData = {
      settings: { extraWords: 'raid, doxx' },
      whitelist: { 'mod_user': 1 },
      authorNotes: { 'raider': { text: 'alt de raid' } },
      muted: { 'harceleur': { strikes: 'haine', perm: true } }
    };
    await backupCtx.applyBackupData(externalData, false);

    assert.equal(backupCtx.whitelistCache.vip_user, 1);
    assert.equal(backupCtx.whitelistCache.mod_user, 1);
    assert.equal(backupCtx.authorNotesCache.troll_user.text, 'note');
    assert.equal(backupCtx.authorNotesCache.raider.text, 'alt de raid');
    assert.equal(backupCtx.mutedCache.spammer.strikes, 'spam');
    assert.equal(backupCtx.mutedCache.harceleur.strikes, 'haine');
    assert.equal($('backupStatus').textContent.includes('fusionnée avec succès'), true);

    // Test 4: applyBackupData en mode Remplacement (replaceMode = true)
    const freshData = {
      settings: { extraWords: 'seul_mot' },
      whitelist: { 'seul_vip': 1 },
      authorNotes: { 'seul_note': { text: 'unique' } },
      muted: { 'seul_mute': { strikes: 'test' } }
    };
    await backupCtx.applyBackupData(freshData, true);

    assert.equal(backupCtx.whitelistCache.vip_user, undefined);
    assert.equal(backupCtx.whitelistCache.seul_vip, 1);
    assert.equal(backupCtx.authorNotesCache.troll_user, undefined);
    assert.equal(backupCtx.authorNotesCache.seul_note.text, 'unique');
    assert.equal(backupCtx.mutedCache.spammer, undefined);
    assert.equal(backupCtx.mutedCache.seul_mute.strikes, 'test');
    assert.equal($('backupStatus').textContent.includes('remplacée avec succès'), true);
  });

  await check('journal d audit : recordAuditAction, filtres, rendu, export Markdown, CSV, JSON et purge', async () => {
    let savedAuditStorage = null;
    let copiedText = '';
    let downloadedJsonData = null;
    let downloadedJsonPrefix = null;
    let savedBlobData = null;
    let savedBlobFilename = null;
    let authorNavigated = null;

    const auditSection = section(board, "let auditLogCache = [];", "\n// --- fin journal audit ---");
    const auditCtx = vm.createContext({
      $,
      alert: () => {},
      confirm: () => true,
      setTimeout: () => {},
      downloadJson: (data, prefix) => {
        downloadedJsonData = data;
        downloadedJsonPrefix = prefix;
      },
      saveBlob: (blob, filename) => {
        savedBlobData = blob;
        savedBlobFilename = filename;
      },
      Blob: class MockBlob {
        constructor(parts, opts) { this.parts = parts; this.opts = opts; }
      },
      goTab: (tab) => {},
      showAuthor: (author) => { authorNavigated = author; },
      navigator: {
        clipboard: {
          writeText: async (t) => { copiedText = t; }
        }
      },
      document: {
        createElement: (tag) => new Element()
      },
      chrome: {
        storage: {
          local: {
            get: (defs, cb) => cb({ csg_audit_log: [] }),
            set: (val, cb) => {
              savedAuditStorage = val;
              if (cb) cb();
            }
          }
        }
      }
    });

    vm.runInContext(auditSection, auditCtx);

    // 1. Initialisation et recordAuditAction
    assert.equal(typeof auditCtx.recordAuditAction, 'function');
    const a1 = auditCtx.recordAuditAction({
      type: 'mute',
      target: 'spammer123',
      detail: 'spam emotes (perm)',
      channel: 'twitch/main'
    });
    assert.equal(a1.type, 'mute');
    assert.equal(a1.target, 'spammer123');
    assert.equal(auditCtx.getAuditLog().length, 1);
    assert.equal(savedAuditStorage.csg_audit_log.length, 1);
    assert.equal($('auditPillCount').textContent, '1');

    // Ajout d'autres actions variées
    auditCtx.recordAuditAction({
      type: 'whitelist',
      target: 'ami_vip',
      detail: 'protégé contre mute',
      channel: ''
    });
    auditCtx.recordAuditAction({
      type: 'note',
      target: 'suspect',
      detail: 'alt potentiel de banni',
      channel: ''
    });
    auditCtx.recordAuditAction({
      type: 'report',
      target: 'harceleur',
      detail: 'dossier validé et sanctionné',
      channel: 'kick/streamer'
    });
    auditCtx.recordAuditAction({
      type: 'config',
      target: 'sauvegarde',
      detail: 'restauration complète',
      channel: ''
    });

    assert.equal(auditCtx.getAuditLog().length, 5);
    assert.equal($('auditPillCount').textContent, '5');

    // 2. Ouverture / fermeture du modal
    auditCtx.openAuditModal();
    assert.equal($('auditModal').open, true);
    assert.equal($('auditCount').textContent, '5 actions');
    assert.equal($('auditList').children.length, 5);

    // 3. Filtre par recherche textuelle (recherche 'spammer')
    $('auditSearch').value = 'spammer';
    auditCtx.renderAuditLog();
    assert.equal($('auditCount').textContent, '1 sur 5 actions');
    assert.equal($('auditList').children.length, 1);
    $('auditSearch').value = '';

    // 4. Filtre par type d'action (mute)
    $('auditTypeFilter').value = 'mute';
    auditCtx.renderAuditLog();
    assert.equal($('auditCount').textContent, '1 sur 5 actions');
    assert.equal($('auditList').children.length, 1);

    // Filtre type (whitelist)
    $('auditTypeFilter').value = 'whitelist';
    auditCtx.renderAuditLog();
    assert.equal($('auditCount').textContent, '1 sur 5 actions');
    $('auditTypeFilter').value = 'all';
    auditCtx.renderAuditLog();

    // 5. Clic sur le pseudo cible navigue vers le dossier auteur
    const firstRow = $('auditList').children[0];
    const targetEl = firstRow.children.find((c) => c.className && c.className.includes('audit-target'));
    assert.ok(targetEl);
    assert.equal(typeof targetEl.listeners.click, 'function');
    targetEl.listeners.click();
    assert.equal(authorNavigated, 'sauvegarde');

    // 6. Export Markdown pour Discord via auditCopyBtn
    assert.equal(typeof $('auditCopyBtn').listeners.click, 'function');
    await $('auditCopyBtn').listeners.click();
    assert.match(copiedText, /JOURNAL D'AUDIT MODÉRATION REFCHAT/);
    assert.match(copiedText, /🔴 Mute/);
    assert.match(copiedText, /🛡️ Whitelist/);
    assert.match(copiedText, /📝 Note/);
    assert.match(copiedText, /✅ Signalement/);
    assert.match(copiedText, /@spammer123/);
    assert.equal($('auditCopyBtn').textContent, 'Rapport copié ✓');

    // 7. Export JSON via auditExportJson
    assert.equal(typeof $('auditExportJson').listeners.click, 'function');
    $('auditExportJson').listeners.click();
    assert.match(downloadedJsonPrefix, /^refchat-audit-/);
    assert.equal(downloadedJsonData.length, 5);
    assert.equal(downloadedJsonData[4].target, 'spammer123');

    // 8. Export CSV via auditExportCsv
    assert.equal(typeof $('auditExportCsv').listeners.click, 'function');
    $('auditExportCsv').listeners.click();
    assert.match(savedBlobFilename, /^refchat-audit-.*\.csv$/);
    assert.match(savedBlobData.parts[0], /"id","timestamp","date","heure","type","cible","canal","detail"/);
    assert.match(savedBlobData.parts[0], /"spammer123"/);

    // 9. Purge du journal d'audit via auditClearBtn
    assert.equal(typeof $('auditClearBtn').listeners.click, 'function');
    $('auditClearBtn').listeners.click();
    assert.equal(auditCtx.getAuditLog().length, 0);
    assert.equal(savedAuditStorage.csg_audit_log.length, 0);
    assert.equal($('auditPillCount').textContent, '0');
    assert.equal($('auditEmpty').classes.has('hidden'), false);

    auditCtx.closeAuditModal();
    assert.equal($('auditModal').open, false);
  });

  await check('mode streamer : renderPrivacyPill, setStreamerMode, toggle, persistance et floutage', async () => {
    let savedLocal = null;
    let savedSync = null;
    let recordedAction = null;
    const bodyEl = new Element();
    const privSpan = new Element();
    const privPill = $('privacyPill');
    privPill.querySelector = (sel) => (sel === 'span' ? privSpan : null);

    const streamerSection = section(board, "let streamerModeOn = false;", "\n// --- fin mode streamer ---");
    const streamerCtx = vm.createContext({
      $,
      document: {
        body: bodyEl,
        createElement: (tag) => new Element()
      },
      recordAuditAction: (action) => { recordedAction = action; },
      chrome: {
        storage: {
          local: {
            get: (defs, cb) => cb({ csg_streamer_mode: true }),
            set: (val, cb) => {
              savedLocal = Object.assign(savedLocal || {}, val);
              if (cb) cb();
            }
          },
          sync: {
            get: (defs, cb) => cb({ csg_settings: { streamerMode: true } }),
            set: (val, cb) => {
              savedSync = Object.assign(savedSync || {}, val);
              if (cb) cb();
            }
          }
        }
      }
    });

    vm.runInContext(streamerSection, streamerCtx);

    // 1. Initialisation par défaut (inactif)
    assert.equal(typeof streamerCtx.setStreamerMode, 'function');
    assert.equal(typeof streamerCtx.toggleStreamerMode, 'function');
    streamerCtx.setStreamerMode(false);
    assert.equal(bodyEl.classes.has('streamer-mode'), false);
    assert.equal(privPill.classes.has('ok'), false);
    assert.match(privSpan.textContent, /^Mode Streamer$/);
    assert.equal(recordedAction.type, 'config');
    assert.equal(recordedAction.target, 'mode_streamer');
    assert.match(recordedAction.detail, /désactivé/);

    // 2. Activation du mode streamer
    streamerCtx.setStreamerMode(true);
    assert.equal(bodyEl.classes.has('streamer-mode'), true);
    assert.equal(privPill.classes.has('ok'), true);
    assert.match(privSpan.textContent, /^Mode Streamer actif$/);
    assert.equal(savedLocal.csg_streamer_mode, true);
    assert.equal(savedSync.csg_settings.streamerMode, true);
    assert.match(recordedAction.detail, /activé/);

    // 3. Bascule via toggleStreamerMode
    streamerCtx.toggleStreamerMode();
    assert.equal(bodyEl.classes.has('streamer-mode'), false);
    assert.equal(privPill.classes.has('ok'), false);
    assert.match(privSpan.textContent, /^Mode Streamer$/);

    // 4. Chargement depuis storage via loadStreamerMode
    streamerCtx.loadStreamerMode();
    assert.equal(bodyEl.classes.has('streamer-mode'), true);
    assert.equal(privPill.classes.has('ok'), true);

    // 5. Clic sur la pastille privacyPill
    assert.equal(typeof privPill.listeners.click, 'function');
    privPill.listeners.click();
    assert.equal(bodyEl.classes.has('streamer-mode'), false);
  });

  await check('bilan de session live : computeSessionStats, renderSessionModal, copy, export, reset', async () => {
    const pillSpan = new Element();
    const pillEl = $('sessionPill');
    pillEl.querySelector = (sel) => (sel === 'span' ? pillSpan : null);

    let copiedText = '';
    let downloadedJson = null;
    let savedStorage = {};
    let recordedAudit = null;
    let navigatedTab = null;
    let inspectedAuthor = null;

    const sessionSection = section(board, "let sessionStartTs = Date.now();", "\n// --- fin bilan session live ---");
    const sessionCtx = vm.createContext({
      $,
      document: {
        createElement: () => new Element()
      },
      navigator: {
        clipboard: {
          writeText: async (t) => { copiedText = t; }
        }
      },
      confirm: () => true,
      setTimeout: () => {},
      downloadJson: (data, filename) => { downloadedJson = { data, filename }; },
      recordAuditAction: (act) => { recordedAudit = act; },
      goTab: (tab) => { navigatedTab = tab; },
      showAuthor: (auth) => { inspectedAuthor = auth; },
      chrome: {
        storage: {
          local: {
            get: (defs, cb) => cb(savedStorage),
            set: (vals, cb) => { Object.assign(savedStorage, vals); if (cb) cb(); }
          }
        }
      },
      rowLabel: (m) => m.label || (m.codexVerdict === 'mute' ? 'mute' : 'keep'),
      logCache: [],
      mutedCache: {}
    });

    vm.runInContext(sessionSection, sessionCtx);

    // 1. Durée et rendu de la pastille sessionPill
    const now = Date.now();
    vm.runInContext('sessionStartTs = ' + (now - (2 * 3600 * 1000 + 15 * 60 * 1000)), sessionCtx); // 2h 15 min
    sessionCtx.renderSessionPill();
    assert.match(pillSpan.innerHTML, /Session <b>2h15<\/b>/);
    assert.match(pillEl.title, /2 h 15 min/);

    // 2. Calcul des statistiques de session
    const start = vm.runInContext('sessionStartTs', sessionCtx);
    sessionCtx.logCache = [
      { id: '1', ts: start - 5000, channel: 'twitch/old', author: 'ancient', label: 'mute' }, // hors session
      { id: '2', ts: start + 1000, channel: 'twitch/stream1', author: 'good_user', label: 'keep' },
      { id: '3', ts: start + 2000, channel: 'twitch/stream1', author: 'bad_user', label: 'mute', codexReason: 'insulte' },
      { id: '4', ts: start + 3000, channel: 'kick/stream2', author: 'bad_user', label: 'mute', codexReason: 'spam' },
      { id: '5', ts: start + 4000, channel: 'kick/stream2', author: 'nice_user', label: 'keep' }
    ];
    sessionCtx.mutedCache = {
      'old_mute': { at: start - 10000 },
      'mute1': { at: start + 1500 },
      'mute2': { at: start + 2500 }
    };

    const stats = sessionCtx.computeSessionStats();
    assert.equal(stats.totalMessages, 4);
    assert.equal(stats.rejectedCount, 2);
    assert.equal(stats.rejectionRate, '50.0%');
    assert.equal(stats.mutesCount, 2);
    assert.equal(stats.channels.length, 2);
    assert.equal(stats.topReoffenders.length, 1);
    assert.equal(stats.topReoffenders[0].author, 'bad_user');
    assert.equal(stats.topReoffenders[0].count, 2);

    // 3. Rendu du modal sessionModal et navigation auteur
    sessionCtx.openSessionModal();
    assert.equal($('sessionModal').open, true);
    assert.equal($('sessionTotalMsgs').textContent, '4');
    assert.equal($('sessionRejections').textContent, '2 (50.0%)');
    assert.equal($('sessionMutesCount').textContent, '2');
    assert.equal($('sessionChanList').children.length, 2);
    assert.equal($('sessionReoffendersList').children.length, 1);

    // Clic sur le nom d'un récidiviste dans la liste
    const reoffRow = $('sessionReoffendersList').children[0];
    const reoffLink = reoffRow.children.find((c) => c.textContent === '@bad_user');
    assert.ok(reoffLink);
    assert.equal(typeof reoffLink.listeners.click, 'function');
    reoffLink.listeners.click();
    assert.equal(navigatedTab, 'author');
    assert.equal(inspectedAuthor, 'bad_user');
    assert.equal($('sessionModal').open, false);

    // 4. Copie du bilan au format Markdown Discord via sessionCopyBtn
    sessionCtx.openSessionModal();
    assert.equal(typeof $('sessionCopyBtn').listeners.click, 'function');
    await $('sessionCopyBtn').listeners.click();
    assert.match(copiedText, /BILAN DE SESSION REFCHAT/);
    assert.match(copiedText, /\*\*Messages analysés\*\* : 4/);
    assert.match(copiedText, /\*\*Taux d'infraction\*\* : 50\.0% \(2 rejets\)/);
    assert.match(copiedText, /\*\*Sanctions appliquées\*\* : 2 mutes/);
    assert.match(copiedText, /@bad_user : 2 rejets/);
    assert.equal($('sessionCopyBtn').textContent, 'Bilan copié ✓');

    // 5. Export JSON via sessionExportJson
    assert.equal(typeof $('sessionExportJson').listeners.click, 'function');
    $('sessionExportJson').listeners.click();
    assert.ok(downloadedJson);
    assert.equal(downloadedJson.data.totalMessages, 4);
    assert.match(downloadedJson.filename, /^refchat-session-/);

    // 6. Réinitialisation de session via sessionResetBtn
    assert.equal(typeof $('sessionResetBtn').listeners.click, 'function');
    $('sessionResetBtn').listeners.click();
    assert.ok(savedStorage.csg_session_start > 0);
    assert.ok(recordedAudit);
    assert.equal(recordedAudit.type, 'config');
    assert.equal(recordedAudit.target, 'session');
    assert.match(recordedAudit.detail, /nouvelle session live démarrée/);

    // 7. Fermeture du modal
    sessionCtx.closeSessionModal();
    assert.equal($('sessionModal').open, false);
  });

  await check('profils de modération live : getPresetConfig, renderPresetPill, applyPreset, customisation', async () => {
    const pillSpan = new Element();
    const pillEl = $('presetPill');
    pillEl.querySelector = (sel) => (sel === 'span' ? pillSpan : null);

    let recordedAudit = null;
    let savedSync = null;
    let savedLocal = null;
    let streamerModeSet = null;

    const presetSection = section(board, "// ------------------------------------------------------------ profils de modération live", "\n// --- fin profils de modération live ---");
    const presetCtx = vm.createContext({
      $,
      document: {
        createElement: () => new Element()
      },
      setTimeout: () => {},
      recordAuditAction: (act) => { recordedAudit = act; },
      setStreamerMode: (on) => { streamerModeSet = on; },
      chrome: {
        storage: {
          sync: {
            get: (defs, cb) => cb({ csg_settings: {} }),
            set: (vals, cb) => { savedSync = vals; if (cb) cb(); }
          },
          local: {
            get: (defs, cb) => cb({ csg_active_preset: 'standard', csg_custom_presets: {} }),
            set: (vals, cb) => { savedLocal = Object.assign(savedLocal || {}, vals); if (cb) cb(); }
          }
        }
      }
    });

    vm.runInContext(presetSection, presetCtx);

    // 1. Rendu initial du profil par défaut (standard)
    presetCtx.renderPresetPill();
    assert.match(pillSpan.innerHTML, /Profil <b>⚖️ Standard<\/b>/);
    assert.match(pillEl.title, /Profil de modération actif : Standard/);

    // 2. Rendu de la modale avec 4 cartes
    presetCtx.openPresetModal();
    assert.equal($('presetModal').open, true);
    assert.equal($('presetCardsList').children.length, 4);

    // 3. Application du profil Compétitif
    await presetCtx.applyPreset('competitive');
    assert.match(pillSpan.innerHTML, /Profil <b>⚔️ Compétitif<\/b>/);
    assert.equal(savedLocal.csg_active_preset, 'competitive');
    assert.equal(savedLocal.csg_sound_alert, true);
    assert.equal(savedSync.csg_settings.soundAlert, true);
    assert.equal(savedSync.csg_settings.ambiencePause, true);
    assert.match(savedSync.csg_settings.extraWords, /backseat.*spoil.*choke/);
    assert.equal(recordedAudit.type, 'config');
    assert.equal(recordedAudit.target, 'preset');
    assert.match(recordedAudit.detail, /Compétitif/);

    // 4. Application du profil Bouclier Raid (active le mode streamer)
    await presetCtx.applyPreset('raid');
    assert.match(pillSpan.innerHTML, /Profil <b>🛡️ Bouclier Raid<\/b>/);
    assert.equal(savedLocal.csg_active_preset, 'raid');
    assert.equal(savedLocal.csg_streamer_mode, true);
    assert.equal(streamerModeSet, true);
    assert.match(savedSync.csg_settings.extraWords, /discord\.gg.*promo.*raid/);

    // 5. Personnalisation du profil sélectionné
    $('presetCustomWords').value = 'troll_spécifique, spammer';
    $('presetSoundToggle').checked = false;
    presetCtx.saveCustomPresetConfig();
    assert.ok(savedLocal.csg_custom_presets.raid);
    assert.equal(savedLocal.csg_custom_presets.raid.extraWords, 'troll_spécifique, spammer');
    assert.equal(savedLocal.csg_custom_presets.raid.soundAlert, false);

    // 6. Fermeture de la modale
    presetCtx.closePresetModal();
    assert.equal($('presetModal').open, false);
  });

  await check('baromètre d\'ambiance : computeChatAtmosphere, renderMoodPill, renderMoodModal, actions', async () => {
    const pillSpan = new Element();
    const pillEl = $('moodPill');
    pillEl.querySelector = (sel) => (sel === 'span' ? pillSpan : null);

    let copiedText = '';
    let appliedPreset = null;

    const moodSection = section(board, "// ------------------------------------------------------------ baromètre d'ambiance et humeur", "\n// --- fin baromètre d'ambiance et humeur ---");
    const moodCtx = vm.createContext({
      $,
      document: {
        createElement: () => new Element()
      },
      setTimeout: () => {},
      navigator: {
        clipboard: {
          writeText: async (t) => { copiedText = t; }
        }
      },
      applyPreset: (p) => { appliedPreset = p; },
      rowLabel: (m) => m.label || (m.codexVerdict === 'mute' ? 'mute' : 'keep'),
      logCache: []
    });

    vm.runInContext(moodSection, moodCtx);

    // 1. Ambiance par défaut sans message
    const emptyAtmos = moodCtx.computeChatAtmosphere();
    assert.equal(emptyAtmos.score, 100);
    assert.equal(emptyAtmos.state, 'Sereine & Stable');
    assert.equal(emptyAtmos.spike, false);
    moodCtx.renderMoodPill();
    assert.match(pillSpan.innerHTML, /Ambiance <b>🟢 100%<\/b>/);

    // 2. Échantillon avec messages positifs (Hype)
    moodCtx.logCache = [
      { text: 'GG pour la game !', label: 'keep' },
      { text: 'Trop fort PogChamp', label: 'keep' },
      { text: 'Merci pour le stream ❤️', label: 'keep' },
      { text: 'Super clip masterclass', label: 'keep' },
      { text: 'Salut tout le monde', label: 'keep' }
    ];
    const hypeAtmos = moodCtx.computeChatAtmosphere();
    assert.ok(hypeAtmos.posCount >= 4);
    assert.equal(hypeAtmos.negCount, 0);
    assert.equal(hypeAtmos.state, 'Excellente & Hype');
    assert.equal(hypeAtmos.icon, '🟢');
    assert.match(hypeAtmos.recommendation, /Excellente énergie/);

    // 3. Échantillon avec vague de toxicité et détection de pic
    moodCtx.logCache = [
      { text: 'gros chokeur de merde', label: 'mute', codexVerdict: 'mute' },
      { text: 'nul à chier uninstall', label: 'mute', codexVerdict: 'mute' },
      { text: 'dégage sale bot', label: 'mute', codexVerdict: 'mute' },
      { text: 'noob cancer rageux', label: 'mute', codexVerdict: 'mute' },
      { text: 'quoi ?', label: 'keep' }
    ];
    const toxicAtmos = moodCtx.computeChatAtmosphere();
    assert.ok(toxicAtmos.negCount >= 4);
    assert.ok(toxicAtmos.score < 50);
    assert.equal(toxicAtmos.spike, true);
    assert.match(toxicAtmos.recommendation, /Tension élevée ou raid/);

    // 4. Rendu de la modale
    moodCtx.openMoodModal();
    assert.equal($('moodModal').open, true);
    assert.equal($('moodSpikeStatus').textContent, '⚡ Pic détecté');
    assert.equal($('moodSampleCount').textContent, '5 msgs');

    // 5. Copie du rapport d'ambiance Markdown
    assert.equal(typeof $('moodCopyReportBtn').listeners.click, 'function');
    await $('moodCopyReportBtn').listeners.click();
    assert.match(copiedText, /BAROMÈTRE D'AMBIANCE REFCHAT/);
    assert.match(copiedText, /Bienveillance & Hype/);
    assert.match(copiedText, /Tension & Rejets/);
    assert.match(copiedText, /Pic de tension activement détecté/);
    assert.equal($('moodCopyReportBtn').textContent, 'Diagnostic copié ✓');

    // 6. Action rapide : activation du Bouclier Raid
    assert.equal(typeof $('moodApplyRaidBtn').listeners.click, 'function');
    $('moodApplyRaidBtn').listeners.click();
    assert.equal(appliedPreset, 'raid');

    // Action rapide : activation Compétitif
    $('moodApplyCompBtn').listeners.click();
    assert.equal(appliedPreset, 'competitive');

    // 7. Fermeture de la modale
    moodCtx.closeMoodModal();
    assert.equal($('moodModal').open, false);
  });

  await check('macros de modération : getAllModMacros, interpolate, render, copy, mute with reason, custom', async () => {
    let copiedText = '';
    let openedMute = null;
    let savedSync = null;
    let recordedAudit = null;

    const macrosSection = section(board, "// ------------------------------------------------------------ modèles de sanctions & macros modérateur", "\n// --- fin modèles de sanctions & macros modérateur ---");
    const macrosCtx = vm.createContext({
      $,
      document: {
        createElement: () => new Element()
      },
      setTimeout: () => {},
      navigator: {
        clipboard: {
          writeText: async (t) => { copiedText = t; }
        }
      },
      recordAuditAction: (act) => { recordedAudit = act; },
      openMuteModal: (author, chan, reason) => { openedMute = { author, chan, reason }; },
      chrome: {
        storage: {
          sync: {
            get: (defs, cb) => cb({ csg_mod_macros: [] }),
            set: (vals, cb) => { savedSync = vals; if (cb) cb(); }
          }
        }
      }
    });

    vm.runInContext(macrosSection, macrosCtx);

    // 1. Liste par défaut et interpolation
    const macros = macrosCtx.getAllModMacros();
    assert.equal(macros.length, 5);
    assert.equal(macros[0].category, 'respect');
    assert.match(macros[0].text, /\{author\}/);

    const interpolated = macrosCtx.interpolateMacroText(macros[0].text, 'toxic_viewer');
    assert.match(interpolated, /^@toxic_viewer Merci de respecter/);

    // 2. Rendu de la modale macrosModal
    macrosCtx.openMacrosModal();
    assert.equal($('macrosModal').open, true);
    assert.equal($('macrosList').children.length, 5);
    assert.equal($('macrosCount').textContent, '5 macros');

    // 3. Filtrage par recherche
    $('macrosSearch').value = 'backseat';
    macrosCtx.renderMacrosModal();
    assert.equal($('macrosList').children.length, 1);
    assert.equal($('macrosCount').textContent, '1 macro');
    $('macrosSearch').value = '';

    // Filtrage par catégorie
    $('macrosCategoryFilter').value = 'spam';
    macrosCtx.renderMacrosModal();
    assert.equal($('macrosList').children.length, 1);
    $('macrosCategoryFilter').value = 'all';
    macrosCtx.renderMacrosModal();

    // 4. Copie du message pour le chat
    const firstCard = $('macrosList').children[0];
    const cardActions = firstCard.children.find((c) => c.children && c.children.length >= 2);
    const copyBtn = cardActions ? cardActions.children[0] : null;
    assert.ok(copyBtn);
    await copyBtn.listeners.click();
    assert.match(copiedText, /Merci de respecter/);
    assert.equal(copyBtn.textContent, 'Copié ✓');
    assert.ok(recordedAudit);
    assert.match(recordedAudit.detail, /macro copiée/);

    // 5. Muter avec ce motif prérempli
    const muteBtn = cardActions ? cardActions.children[1] : null;
    assert.ok(muteBtn);
    muteBtn.listeners.click();
    assert.ok(openedMute);
    assert.equal(openedMute.reason, 'Insultes / Manque de respect');
    assert.equal($('macrosModal').open, false);

    // 6. Ajout d'une macro personnalisée
    const okAdded = macrosCtx.addCustomModMacro('Troll Raid', 'troll de raid', '{author} Raid non toléré', 'custom');
    assert.equal(okAdded, true);
    assert.ok(savedSync);
    assert.equal(savedSync.csg_mod_macros.length, 1);
    assert.equal(savedSync.csg_mod_macros[0].title, 'Troll Raid');
    assert.equal(macrosCtx.getAllModMacros().length, 6);

    // Suppression de la macro personnalisée
    const customId = savedSync.csg_mod_macros[0].id;
    macrosCtx.deleteCustomModMacro(customId);
    assert.equal(macrosCtx.getAllModMacros().length, 5);

    // 7. Fermeture de la modale
    macrosCtx.closeMacrosModal();
    assert.equal($('macrosModal').open, false);
  });

  await check('moteur de règles regex & testeur en direct : compilation, match, modale, testeur interactif et ajout de règle', async () => {
    let savedSync = null;
    let recordedAudit = null;

    const regexSection = section(board, 'const DEFAULT_REGEX_RULES = [', '\n// --- fin règles regex & filtres avancés ---');
    const regexCtx = vm.createContext({
      $,
      document: {
        createElement: (tag) => new Element(tag)
      },
      alert: () => {},
      setTimeout: (fn) => fn(),
      recordAuditAction: (action) => { recordedAudit = action; },
      chrome: {
        storage: {
          sync: {
            get: (keys, cb) => cb({ csg_regex_rules: [] }),
            set: (obj, cb) => { savedSync = obj; if (cb) cb(); }
          }
        }
      }
    });

    // 1. Initialisation du module
    vm.runInContext(regexSection, regexCtx);
    assert.equal(typeof regexCtx.compileRegexPattern, 'function');
    assert.equal(typeof regexCtx.matchCustomRegex, 'function');
    assert.equal(typeof regexCtx.openRegexModal, 'function');
    assert.equal(typeof regexCtx.runRegexTester, 'function');

    // 2. Compilation de motifs regex
    const r1 = regexCtx.compileRegexPattern('test[0-9]+', 'i');
    assert.ok(r1 && typeof r1.test === 'function');
    assert.equal(r1.test('test42'), true);

    const r2 = regexCtx.compileRegexPattern('/[a-z]+_bot/g');
    assert.ok(r2 && typeof r2.test === 'function');
    assert.equal(r2.test('spammer_bot'), true);

    const rInvalid = regexCtx.compileRegexPattern('[invalid(regex');
    assert.equal(rInvalid, null);

    // 3. Détection par matchCustomRegex
    // Lien Discord
    const resDiscord = regexCtx.matchCustomRegex('Rejoins mon serveur discord.gg/superstream pour les giveaway');
    assert.equal(resDiscord.matched, true);
    assert.equal(resDiscord.action, 'mute');
    assert.equal(resDiscord.reason, 'Lien Discord non autorisé');

    // Lien Telegram
    const resTelegram = regexCtx.matchCustomRegex('Rejoins nous vite sur t.me/cryptofr !');
    assert.equal(resTelegram.matched, true);
    assert.equal(resTelegram.action, 'mute');

    // Bot followers
    const resBot = regexCtx.matchCustomRegex('Want to get free followers on bigfollows ?');
    assert.equal(resBot.matched, true);
    assert.equal(resBot.action, 'mute');

    // All caps
    const resCaps = regexCtx.matchCustomRegex('REGARDEZ TOUS CE QUI SE PASSE ICI MAINTENANT');
    assert.equal(resCaps.matched, true);
    assert.equal(resCaps.action, 'review');

    // Scam crypto
    const resCrypto = regexCtx.matchCustomRegex('Connect wallet right now to claim free airdrop');
    assert.equal(resCrypto.matched, true);
    assert.equal(resCrypto.action, 'mute');

    // Message sain
    const resClean = regexCtx.matchCustomRegex('Salut tout le monde, bon stream à tous !');
    assert.equal(resClean.matched, false);
    assert.equal(resClean.rule, null);

    // 4. Modale & Rendu de la liste
    regexCtx.openRegexModal();
    assert.equal($('regexModal').open, true);
    assert.equal($('regexRulesList').children.length, 5);
    assert.equal($('regexCount').textContent, '5 règles actives');

    // 5. Testeur interactif en direct
    $('regexTestInput').value = 'Visite t.me/leaks pour tout voir';
    regexCtx.runRegexTester();
    assert.match($('regexTestResult').textContent, /🚫 Bloqué par :/);
    assert.match($('regexTestResult').textContent, /MUTE/);

    $('regexTestInput').value = 'Coucou le chat !';
    regexCtx.runRegexTester();
    assert.match($('regexTestResult').textContent, /✅ Message propre/);

    // 6. Ajout d'une règle personnalisée
    const addSuccess = regexCtx.addCustomRegexRule('TikTok Links', '(?:tiktok\\.com|vm\\.tiktok)\\/[a-z0-9_-]+', 'review', 'Lien TikTok');
    assert.equal(addSuccess, true);
    assert.ok(savedSync);
    assert.equal(savedSync.csg_regex_rules.length, 6);
    assert.equal(regexCtx.getAllRegexRules().length, 6);
    assert.ok(recordedAudit);
    assert.match(recordedAudit.detail, /TikTok Links/);

    // Test de la nouvelle règle personnalisée
    const resCustom = regexCtx.matchCustomRegex('Regarde ma vidéo sur vm.tiktok/abc1234');
    assert.equal(resCustom.matched, true);
    assert.equal(resCustom.rule.name, 'TikTok Links');
    assert.equal(resCustom.action, 'review');

    // 7. Suppression de la règle personnalisée
    const customRule = savedSync.csg_regex_rules.find((r) => r.isCustom);
    assert.ok(customRule);
    regexCtx.deleteCustomRegexRule(customRule.id);
    assert.equal(regexCtx.getAllRegexRules().length, 5);

    // 8. Fermeture de la modale
    regexCtx.closeRegexModal();
    assert.equal($('regexModal').open, false);
  });

  console.log('UI navigation : ' + checks + ' régressions OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});


