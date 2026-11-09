'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const start = source.indexOf('  let replyAssistEnabled = false;');
const end = source.indexOf('  const GROK_TIP', start);
assert.ok(start >= 0 && end > start, 'reply draft UI section exists');
const legacyStart = source.indexOf('  function sendBaitLine(');
const legacyEnd = source.indexOf('  const onContentMessage', legacyStart);
assert.ok(legacyStart >= 0 && legacyEnd > legacyStart, 'legacy sending section exists');
const popupSource = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
const popupStart = popupSource.indexOf('let replyAssistConfig =');
const popupEnd = popupSource.indexOf("$('enabled').addEventListener", popupStart);
assert.ok(popupStart >= 0 && popupEnd > popupStart, 'reply draft popup settings section exists');

class Element {
  constructor(tag, root = false) {
    this.tagName = tag.toUpperCase();
    this.root = root;
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.handlers = {};
    this.textContent = '';
    this.value = '';
    this.disabled = false;
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  appendChild(child) { this.append(child); return child; }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, callback) { this.handlers[type] = callback; }
  get isConnected() { return this.root || !!(this.parentElement && this.parentElement.isConnected); }
  async click() {
    if (!this.disabled && this.handlers.click) await this.handlers.click({ currentTarget: this });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(options = {}) {
  const body = new Element('body', true);
  const document = { body, visibilityState: 'visible', createElement: (tag) => new Element(tag), getElementById: (id) => body.children.find(el => el.id === id) || null };
  const state = {
    channel: 'twitch/example', composer: { value: '' }, dead: false,
    requests: [], placements: [], nativeCalls: [], sends: 0, enters: 0, timers: [], allowLegacySend: false,
    nativeReply: () => Promise.resolve(true), listeners: [], cleanups: []
  };
  const ctx = vm.createContext({
    document,
    Date,
    setTimeout: (fn, delay) => { state.timers.push({ fn, delay }); return state.timers.length; },
    chrome: { storage: { local: { get: (_defaults, callback) => callback({ csg_reply_assist: { enabled: options.enabled !== false } }) } } },
    safe: (fn) => fn(),
    listenStorage: (fn) => state.listeners.push(fn),
    contentCleanups: state.cleanups,
    currentChannel: () => state.channel,
    ctxDead: () => state.dead,
    findComposer: () => state.composer,
    composerDraft: (composer) => String(composer.value || '').trim(),
    openNativeReply: (id, author) => { state.nativeCalls.push({ id, author }); return state.nativeReply(); },
    placeComposerText: (composer, text) => { composer.value = text; state.placements.push(text); return true; },
    clickChatSend: () => { state.sends++; if (!state.allowLegacySend) throw new Error('draft UI must never click Send'); return true; },
    pressEnter: () => { state.enters++; if (!state.allowLegacySend) throw new Error('draft UI must never press Enter'); },
    sendBg: (message, callbacks) => { state.requests.push({ message, callbacks }); return true; }
  });
  vm.runInContext(source.slice(start, end), ctx);
  vm.runInContext(source.slice(legacyStart, legacyEnd), ctx);
  const api = {
    state, ctx, document,
    show: (extra = {}) => ctx.showReplyDraft({ channel: 'twitch/example', author: 'alice', replyToId: 'message-42', text: 'mon texte', ...extra }),
    legacy: (text, options) => ctx.sendBaitLine(text, options),
    enable: () => state.listeners.forEach((fn) => fn({ csg_reply_assist: { newValue: { enabled: true } } }, 'local')),
    disable: () => state.listeners.forEach((fn) => fn({ csg_reply_assist: { newValue: { enabled: false } } }, 'local')),
    targets: (value) => state.listeners.forEach((fn) => fn({ csg_hand: { newValue: value } }, 'local')),
    ui: () => {
      const panel = body.children[0];
      assert.ok(panel, 'draft panel is visible');
      const [title, note, input, status, actions] = panel.children;
      const [rephrase, place, close] = actions.children;
      return { panel, title, note, input, status, rephrase, place, close };
    },
    assertNoSend: () => {
      assert.equal(state.sends, 0, 'no Send button click');
      assert.equal(state.enters, 0, 'no Enter key submission');
    }
  };
  return api;
}

function popupHarness(config = { enabled: false, learnStyle: false }, stats = { count: 0 }) {
  const elements = Object.fromEntries(['replyAssistOn', 'replyStyleOn', 'replyStyleStatus'].map((id) => [id, new Element('input')]));
  const requests = [];
  const runtime = {
    lastError: null,
    sendMessage: (message, callback) => requests.push({ message, callback })
  };
  const ctx = vm.createContext({
    $: (id) => elements[id],
    chrome: { runtime, storage: { local: { get: (_defaults, callback) => callback({ csg_reply_assist: config, csg_reply_style_stats: stats }) } } }
  });
  vm.runInContext(popupSource.slice(popupStart, popupEnd), ctx);
  return { elements, requests, runtime, ctx,
    config: () => JSON.parse(vm.runInContext('JSON.stringify(replyAssistConfig)', ctx)) };
}

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

test('refuse disabled assistance, another channel and a hidden tab', () => {
  const disabled = harness({ enabled: false });
  assert.equal(disabled.show().ok, false);
  assert.equal(disabled.document.body.children.length, 0);
  const h = harness();
  assert.equal(h.show({ channel: 'twitch/other' }).ok, false);
  h.document.visibilityState = 'hidden';
  assert.equal(h.show().ok, false);
  assert.equal(h.document.body.children.length, 0);
  h.assertNoSend();
});

test('preserve an open draft when another arrives', () => {
  const h = harness();
  assert.equal(h.show().ok, true);
  const first = h.ui();
  first.input.value = 'mon édition en cours';
  assert.equal(h.show({ author: 'bob', text: 'autre proposition' }).ok, false);
  assert.equal(h.ui().panel, first.panel);
  assert.equal(first.input.value, 'mon édition en cours');
  assert.equal(h.state.placements.length, 0);
  h.assertNoSend();
});

test('readiness checks reject an occupied panel without creating UI or requests', async () => {
  const h = harness();
  assert.equal(h.ctx.replyDraftReady('twitch/example').ok, true);
  assert.equal(h.ctx.replyDraftReady('twitch/other').ok, false);
  assert.equal(h.document.body.children.length, 0);
  h.show();
  assert.equal(h.ctx.replyDraftReady('twitch/example').ok, false);
  await h.ui().close.click();
  assert.equal(h.ctx.replyDraftReady('twitch/example').ok, true);
  h.document.visibilityState = 'hidden';
  assert.equal(h.ctx.replyDraftReady('twitch/example').ok, false);
  h.document.visibilityState = 'visible';
  h.disable();
  assert.equal(h.ctx.replyDraftReady('twitch/example').ok, false);
  assert.equal(h.document.body.children.length, 0);
  assert.equal(h.state.requests.length, 0);
  h.assertNoSend();
});

test('preserve the existing Twitch composer', async () => {
  const h = harness();
  h.state.composer.value = 'je suis en train de taper';
  h.show();
  await h.ui().place.click();
  assert.equal(h.state.composer.value, 'je suis en train de taper');
  assert.equal(h.state.nativeCalls.length, 0);
  assert.equal(h.state.placements.length, 0);
  assert.equal(h.ui().panel.isConnected, true);
  h.assertNoSend();
});

test('political drafts open blank and rephrase only user supplied text', async () => {
  const h = harness();
  h.show({ political: true, text: 'un argument reçu du modèle', author: 'political-user', replyQuote: 'contexte privé' });
  const ui = h.ui();
  assert.equal(ui.input.value, '', 'the political UI must require the user to write their own view');
  assert.equal(h.state.requests.length, 0, 'opening a panel makes no generation request');
  await ui.rephrase.click();
  assert.equal(h.state.requests.length, 0, 'a blank view is not sent to Grok');
  ui.input.value = '  voici mon propre avis  ';
  await ui.rephrase.click();
  assert.deepEqual(Object.keys(h.state.requests[0].message).sort(), ['text', 'type']);
  assert.equal(h.state.requests[0].message.type, 'CSG_REPHRASE_DRAFT');
  assert.equal(h.state.requests[0].message.text, 'voici mon propre avis');
  assert.equal(h.state.requests[0].callbacks.noRetry, true);
  h.assertNoSend();
});

test('an asynchronous reformulation preserves later user edits', async () => {
  const h = harness();
  h.show();
  const ui = h.ui();
  await ui.rephrase.click();
  ui.input.value = 'ma correction pendant la requête';
  h.state.requests[0].callbacks.onReply({ ok: true, line: 'ancienne reformulation' });
  assert.equal(ui.input.value, 'ma correction pendant la requête');
  assert.equal(ui.rephrase.disabled, false);
  assert.match(ui.status.textContent, /conservé/);
  h.assertNoSend();
});

test('an asynchronous reformulation is ignored after a channel change or closing', async () => {
  for (const action of ['navigate', 'close']) {
    const h = harness();
    h.show();
    const ui = h.ui();
    await ui.rephrase.click();
    if (action === 'navigate') h.state.channel = 'twitch/other';
    else await ui.close.click();
    h.state.requests[0].callbacks.onReply({ ok: true, line: 'résultat arrivé trop tard' });
    assert.equal(ui.input.value, 'mon texte');
    h.assertNoSend();
  }
});

test('placing copies to the native reply composer without sending', async () => {
  const h = harness();
  h.show();
  assert.equal(h.state.placements.length, 0, 'opening the panel does not touch Twitch');
  await h.ui().place.click();
  assert.deepEqual(h.state.nativeCalls, [{ id: 'message-42', author: 'alice' }]);
  assert.equal(h.state.composer.value, 'mon texte');
  assert.equal(h.document.body.children.length, 0);
  assert.equal(h.state.requests.length, 0);
  h.assertNoSend();
});

test('placing falls back to an explicit mention without sending', async () => {
  const h = harness();
  h.state.nativeReply = () => Promise.resolve(false);
  h.show({ author: '@alice' });
  await h.ui().place.click();
  assert.equal(h.state.composer.value, '@alice mon texte');
  h.assertNoSend();
});

test('placement revalidates channel, visibility and composer after the native reply opens', async () => {
  for (const action of ['navigate', 'hide', 'type', 'close', 'disable', 'dead']) {
    const h = harness();
    const pending = deferred();
    h.state.nativeReply = () => pending.promise;
    h.show();
    const ui = h.ui();
    const placing = ui.place.click();
    assert.equal(h.state.nativeCalls.length, 1);
    if (action === 'navigate') h.state.channel = 'twitch/other';
    if (action === 'hide') h.document.visibilityState = 'hidden';
    if (action === 'type') h.state.composer.value = 'nouveau texte personnel';
    if (action === 'close') await ui.close.click();
    if (action === 'disable') h.disable();
    if (action === 'dead') h.state.dead = true;
    pending.resolve(true);
    await placing;
    assert.equal(h.state.placements.length, 0, action + ' blocks the pending placement');
    assert.equal(h.state.composer.value, action === 'type' ? 'nouveau texte personnel' : '');
    h.assertNoSend();
  }
});

test('closing, disabling and extension cleanup remove the panel', async () => {
  for (const action of ['close', 'disable', 'cleanup']) {
    const h = harness();
    h.show();
    const ui = h.ui();
    if (action === 'close') await ui.close.click();
    if (action === 'disable') h.disable();
    if (action === 'cleanup') h.state.cleanups.forEach((fn) => fn());
    assert.equal(ui.panel.isConnected, false, action);
    assert.equal(h.document.body.children.length, 0, action);
    if (action === 'disable') assert.equal(h.show().ok, false);
    h.assertNoSend();
  }
});

test('enabling drafts cancels legacy sending while waiting for an occupied composer', async () => {
  const h = harness({ enabled: false });
  h.state.composer.value = 'mon message en cours';
  const pending = h.legacy('ancienne réponse automatique');
  assert.equal(h.state.timers[0].delay, 400);
  h.enable();
  h.state.composer.value = '';
  h.state.timers.shift().fn();
  assert.equal((await pending).ok, false);
  assert.equal(h.state.composer.value, '');
  assert.equal(h.state.placements.length, 0);
  h.assertNoSend();
});

test('enabling drafts cancels legacy sending while waiting for the native reply', async () => {
  const h = harness({ enabled: false });
  const native = deferred();
  h.state.nativeReply = () => native.promise;
  const pending = h.legacy('ancienne réponse automatique', { author: 'alice', replyToId: 'message-42' });
  assert.equal(h.state.nativeCalls.length, 1);
  h.enable();
  native.resolve(true);
  assert.equal((await pending).ok, false);
  assert.equal(h.state.composer.value, '');
  assert.equal(h.state.placements.length, 0);
  h.assertNoSend();
});

test('enabling drafts cancels the legacy fallback resend', async () => {
  const h = harness({ enabled: false });
  h.state.allowLegacySend = true;
  const pending = h.legacy('ancienne réponse automatique');
  assert.equal(h.state.sends, 1, 'the first attempt happened before draft mode was enabled');
  assert.equal(h.state.enters, 0);
  assert.equal(h.state.timers[0].delay, 900);
  h.enable();
  h.state.timers.shift().fn();
  assert.equal((await pending).ok, false);
  assert.equal(h.state.sends, 1, 'no second Send click after draft mode is enabled');
  assert.equal(h.state.enters, 0, 'no Enter fallback after draft mode is enabled');
  assert.equal(h.state.timers.length, 0);
});

test('popup switches send only their opt-in property and wait for acknowledgement', () => {
  for (const [id, key] of [['replyAssistOn', 'enabled'], ['replyStyleOn', 'learnStyle']]) {
    const h = popupHarness();
    const input = h.elements[id];
    assert.equal(input.checked, false, key + ' starts off');
    input.checked = true;
    input.handlers.change();
    assert.equal(input.disabled, true, 'setting waits for the background acknowledgement');
    assert.equal(h.config()[key], false, 'the stored UI config is not changed optimistically');
    assert.deepEqual(Object.keys(h.requests[0].message).sort(), [key, 'type'].sort());
    assert.equal(h.requests[0].message.type, 'CSG_REPLY_ASSIST_SET');
    assert.equal(h.requests[0].message[key], true);
    h.requests[0].callback({ ok: true, config: { enabled: key === 'enabled', learnStyle: key === 'learnStyle' }, stats: { count: 0 } });
    assert.equal(input.disabled, false);
    assert.equal(input.checked, true);
    assert.equal(h.config()[key], true);
  }
});

test('popup restores the previous setting if saving fails', () => {
  for (const failure of ['response', 'runtime']) {
    const h = popupHarness();
    const input = h.elements.replyAssistOn;
    input.checked = true;
    input.handlers.change();
    if (failure === 'runtime') h.runtime.lastError = { message: 'disconnected' };
    h.requests[0].callback({ ok: false });
    assert.equal(input.disabled, false);
    assert.equal(input.checked, false);
    assert.equal(h.config().enabled, false);
    assert.match(h.elements.replyStyleStatus.textContent, /non enregistré/);
  }
});

test('popup explains local retention and the minimum style sample count', () => {
  const h = popupHarness({ enabled: true, learnStyle: false }, { count: 12 });
  assert.match(h.elements.replyStyleStatus.textContent, /Apprentissage désactivé/);
  assert.match(h.elements.replyStyleStatus.textContent, /localement/);
  h.ctx.paintReplyAssist({ enabled: true, learnStyle: true }, { count: 7 });
  assert.match(h.elements.replyStyleStatus.textContent, /7 messages retenus/);
  assert.match(h.elements.replyStyleStatus.textContent, /8 nécessaires/);
  h.ctx.paintReplyAssist({ enabled: true, learnStyle: true }, { count: 8 });
  assert.match(h.elements.replyStyleStatus.textContent, /8 messages retenus/);
  assert.match(h.elements.replyStyleStatus.textContent, /style utilisé/);
});

test('stopping an automatic target cancels a reply waiting for the composer', async () => {
  const h = harness({ enabled: false });
  h.targets({ alice: { name: 'Alice', channel: 'twitch/example', at: 10 } });
  h.state.composer.value = 'texte utilisateur';
  const pending = h.legacy('réponse en attente', { targetKey: 'alice', targetAt: 10 });
  h.targets({});
  h.state.composer.value = '';
  h.state.timers.shift().fn();
  assert.equal((await pending).ok, false);
  assert.equal(h.state.placements.length, 0);
  h.assertNoSend();
});

test('a new authorization does not revive an older pending automatic reply', async () => {
  const h = harness({ enabled: false });
  h.targets({ alice: { name: 'Alice', channel: 'twitch/example', at: 10 } });
  const native = deferred(); h.state.nativeReply = () => native.promise;
  const pending = h.legacy('ancienne réponse', { author: 'Alice', targetKey: 'alice', targetAt: 10 });
  h.targets({ alice: { name: 'Alice', channel: 'twitch/example', at: 20 } });
  native.resolve(true);
  assert.equal((await pending).ok, false);
  assert.equal(h.state.placements.length, 0);
  h.assertNoSend();
});

test('the chat stop button revokes local sending before worker acknowledgement', async () => {
  const h = harness({ enabled: false });
  h.targets({ alice: { name: 'Alice', channel: 'twitch/example', at: 10 } });
  const panel = h.document.getElementById('csg-auto-reply-control');
  assert.ok(panel);
  await panel.children[0].children[1].click();
  assert.equal(h.ctx.autoReplyAllowed({ targetKey: 'alice', targetAt: 10 }), false);
  assert.equal(h.document.getElementById('csg-auto-reply-control'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.requests[0].message)), { type: 'CSG_HAND_STOP', key: 'alice' });
});

(async () => {
  let failures = 0;
  for (const { name, fn } of cases) {
    try { await fn(); console.log('OK ' + name); }
    catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  assert.equal(failures, 0, failures + ' reply draft UI check(s) failed');
  console.log('OK reply draft UI: ' + cases.length + ' behavioral checks');
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
