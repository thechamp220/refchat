'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
let now = 100000, channel = 'twitch/example', listener, timer;
const classes = new Set(), sent = [], nodes = [];
function node() {
  return { kids: [], removed: false, textContent: '',
    setAttribute() {}, append(...xs) { this.kids.push(...xs); },
    appendChild(x) { this.kids.push(x); }, remove() { this.removed = true; },
    addEventListener(_, fn) { this.click = fn; }, get firstChild() { return this.kids[0]; } };
}
const sandbox = {
  Date: { now: () => now }, Math, Number, settings: { enabled: true, ambiencePause: true },
  currentChannel: () => channel, ctxDead: () => false, safe: (fn) => fn(),
  setInterval: (fn) => { timer = fn; return 1; }, clearInterval() {},
  sendBg: (msg) => sent.push(msg),
  contentCleanups: [],
  listenStorage: (fn) => { listener = fn; },
  document: { documentElement: { classList: {
    toggle: (key, yes) => yes ? classes.add(key) : classes.delete(key), remove: (key) => classes.delete(key)
  } }, body: node(), createElement: () => { const n = node(); nodes.push(n); return n; } },
  chrome: { storage: { local: { get: (_, cb) => cb({ csg_ambience_state: {} }) },
    onChanged: { addListener: (fn) => { listener = fn; } } } }
};
vm.createContext(sandbox);
vm.runInContext(src.slice(src.indexOf('  let ambienceStates = {}'), src.indexOf('  function flushMuts()')), sandbox);
const update = () => listener({ csg_ambience_state: { newValue: { 'twitch/example': { until: 160000, ratio: 0.75 } } } }, 'local');
update();
assert.equal(classes.has('csg-chat-paused'), true);
assert.equal(sandbox.document.body.kids[0].firstChild.textContent.includes('60 s'), true);
now += 1000; timer();
assert.equal(sandbox.document.body.kids[0].firstChild.textContent.includes('59 s'), true);
channel = 'kick/other'; timer();
assert.equal(classes.has('csg-chat-paused'), false, 'other channel visible');
channel = 'twitch/example'; timer();
assert.equal(classes.has('csg-chat-paused'), true);
sandbox.settings.ambiencePause = false; timer();
assert.equal(classes.has('csg-chat-paused'), false, 'disable restores immediately');
sandbox.settings.ambiencePause = true; timer();
now = 160001; timer();
assert.equal(classes.has('csg-chat-paused'), false, 'automatic expiry without click or worker');
now = 101000; update();
const banner = sandbox.document.body.kids.at(-1);
banner.kids[1].click();
assert.equal(classes.has('csg-chat-paused'), false, 'manual reveal immediate even without worker response');
assert.equal(sent[0].type, 'CSG_AMBIENCE_REVEAL');
update();
assert.equal(classes.has('csg-chat-paused'), false, 'late storage update cannot rehide same pause');
now = 160001; timer();
assert.equal(classes.has('csg-chat-paused'), false, 'expires');
console.log('OK pause UI: compteur, salon, desactivation, retour manuel et expiration');
