'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
function section(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
let observer, paints = 0, dead = false, tornDown = false;
const timers = [];
const root = {};
const ctx = vm.createContext({
  window: {}, document: { documentElement: root },
  ctxDead: () => dead, teardown: () => { tornDown = true; },
  paintViewerCards: () => { paints++; },
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
  MutationObserver: class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe(node, options) { assert.equal(node, root); assert.equal(options.childList, true); }
  }
});
vm.runInContext(section('  function setCardText(', '  function paintViewerCards(') +
  section('  function ensureCardObserver(', '  window.__csgObserver = observer;'), ctx);
let text = 'Whitelist', writes = 0;
const label = {
  get textContent() { return text; },
  set textContent(value) { writes++; text = value; }
};
for (let i = 0; i < 20; i++) ctx.setCardText(label, 'Whitelist');
assert.equal(writes, 0, 'unchanged card labels must not replace text nodes');
ctx.setCardText(label, 'Whitelisté');
assert.equal(writes, 1, 'a real state change updates the label');
ctx.ensureCardObserver();
const own = { nodeType: 1, closest: (selector) => selector === '.csg-wl-slot' ? {} : null };
const external = { nodeType: 1, closest: () => null };
observer.callback([{ target: own }]);
observer.callback([{ target: { nodeType: 3, parentElement: own } }]);
assert.equal(timers.length, 0, 'painting RefChat labels must not schedule another paint');
observer.callback([{ target: own }, { target: external }]);
observer.callback([{ target: external }]);
assert.equal(timers.length, 1, 'Twitch changes still schedule one debounced paint');
timers[0]();
assert.equal(paints, 1);
observer.callback([{ target: external }]);
assert.equal(timers.length, 2, 'later Twitch card changes are still observed');
dead = true;
observer.callback([{ target: external }]);
assert.equal(tornDown, true, 'an invalidated extension stops observing');
console.log('OK viewer cards: no self-triggered paints, stable labels, external updates and teardown');
