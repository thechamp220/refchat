'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(process.env.REFCHAT_CONTENT || path.join(root, 'content.js'), 'utf8');
function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'section content.js introuvable : ' + from);
  return source.slice(start, end);
}

// Execute the production learned-list initialization and handleLine together.
// Supplying learnedWords from the harness would hide an undeclared-variable
// crash: the content script must own it before either storage callback runs.
const messages = [];
const actions = [];
const localReads = [];
const localStore = { csg_learned: [{ w: 'termeappris' }] };
let onStorageChanged;
const ctx = vm.createContext({
  window: {},
  Date,
  Math,
  WeakMap,
  liveLineAt: new WeakMap(),
  ambienceLineAt: new WeakMap(),
  chrome: {
    storage: {
      local: {
        get(defaults, callback) {
          localReads.push(() => callback(Object.assign({}, defaults, localStore)));
        }
      },
      sync: { get: (defaults, callback) => callback(defaults) },
      onChanged: { addListener: (callback) => { onStorageChanged = callback; } }
    }
  },
  safe: (callback) => { callback(); return true; },
  listenStorage: (callback) => { onStorageChanged = callback; },
  sendBg: (message) => { messages.push(message); return true; },
  isChatLine: () => true,
  isComposer: () => false,
  isBroadcaster: () => false,
  isOwnMessage: () => false,
  isSelfName: () => false,
  isWhitelisted: () => false,
  hideMuted: () => false,
  rowLen: (el) => String(el.text.length),
  rowKey: (el) => el.author + '|' + el.text,
  extractReply: () => ({ to: '', quote: '' }),
  msgText: (el) => el.text,
  chatName: (el) => el.author,
  addGrokBtn() {},
  currentChannel: () => 'twitch/capturetest',
  currentStreamContext: () => 'Test capture',
  joinedVerdict: () => null,
  rememberTail() {},
  pastaReason: () => '',
  noteBurst: () => 0,
  act: (el, score, reason) => actions.push({ el, score, reason }),
  paintViewerCards() {},
  restyleAll() {},
  retroHideMuted() {},
  paintHud() {},
  unhideWhitelisted() {}
});
vm.runInContext(fs.readFileSync(path.join(root, 'keywords.js'), 'utf8'), ctx);
vm.runInContext([
  "'use strict';",
  section('  const DEFAULTS = {', '  // --- Contexte court'),
  section('  const BURST = {', '  const authorTail ='),
  section('  // Liste apprise par le deep', '  function rootDocs()'),
  section('  function nextId()', '  // Un seul reglage, une seule question')
].join('\n'), ctx, { filename: 'content.js capture regression' });

function line(text, author = 'viewer') {
  return { dataset: {}, author, text };
}
function capture(el) {
  const before = messages.length;
  assert.doesNotThrow(() => ctx.handleLine(el), 'une ligne de chat doit atteindre la capture');
  assert.equal(messages.length, before + 1, 'la ligne doit etre envoyee une fois au journal');
  const message = messages.at(-1);
  assert.equal(message.type, 'CSG_CAPTURE');
  assert.equal(message.text, el.text);
  assert.equal(message.author, el.author);
  assert.equal(message.channel, 'twitch/capturetest');
  assert.match(message.id, /^csg_/);
  return message;
}

assert.equal(vm.runInContext('settings.learn', ctx), true, 'la liste apprise est active par defaut');
const early = line('Bonsoir le chat');
assert.equal(capture(early).source, 'pending', 'capture avant la reponse asynchrone du stockage');
assert.equal(messages.at(-1).label, 'pending');
assert.equal(actions.length, 0, 'un message ordinaire reste visible');
ctx.handleLine(early);
assert.equal(messages.length, 1, 'le rescan ne duplique pas une capture terminee');

for (const complete of localReads) complete();
assert.equal(capture(line('Le match commence bientot', 'alice')).source, 'pending',
  'la capture ordinaire continue apres lecture du stockage');
const learned = capture(line('Voici le termeappris', 'bob'));
assert.equal(learned.source, 'appris', 'un terme appris valide garde son filtre local');
assert.equal(learned.term, 'termeappris');
assert.equal(learned.label, 'mute');
assert.equal(actions.at(-1).reason, 'appris');

onStorageChanged({ csg_learned: { newValue: [{ w: 'nouveauterme' }] } }, 'local');
assert.equal(capture(line('Voici le nouveauterme', 'carol')).source, 'appris',
  'une modification de la liste est prise en compte sans recharger le chat');
assert.equal(capture(line('Voici le termeappris', 'david')).source, 'pending',
  'un ancien terme retire de la liste ne masque plus le message');
assert.equal(messages.every((message) => message.type === 'CSG_CAPTURE'), true,
  'la capture seule ne lance aucune analyse implicite');

console.log('Capture runtime OK : stockage asynchrone, messages ordinaires, liste apprise et rescan.');
