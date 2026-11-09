'use strict';

// Banc commun : background.js ENTIER dans un contexte vm, fausse API branchee
// sur fetch, horloge simulee. On fait tourner la vraie chaine : freeLanes ->
// takeAuditBatch -> runLaneJob -> tryLane -> rejudgeBatch -> applyItemVerdict,
// et le profileur d'auteur (runAuthorCheck).
//
// Pas un test : il ne commence pas par « check- », la suite ne le lance pas.

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// REFCHAT_BG : charger une variante de background.js (test de mutation : le
// test doit echouer sur l'ancien code).
const SRC = fs.readFileSync(process.env.REFCHAT_BG || path.join(ROOT, 'background.js'), 'utf8');

const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } }));

function reply(url, text, how) {
  const responses = /\/responses$/.test(String(url));
  if (how === 'reasoning') {
    return json(
      responses
        ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }
        : { choices: [{ finish_reason: 'length', message: { content: '', reasoning: 'Here is a thinking process: 1. Analyze the lines' } }] }
    );
  }
  return json(
    responses
      ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
      : { choices: [{ finish_reason: 'stop', message: { content: text } }] }
  );
}

// Fausse API. Lots : `api.mode(lane, lignes)` decide de la reponse —
//   'ok'        JSON correct, `api.verdict(lane, ligne)` pour chaque ligne
//               (par defaut : true si la ligne contient « toxique »)
//   'reasoning' le Ling d'avant OPENCODE_EFFORT : budget avale, zero JSON
//   'prose'     le modele a deraille (consigne glissee dans le chat, refus)
// Profils d'auteur : `api.author(lane, auteur)` rend 'toxic', 'keep' ou
// 'reasoning'.
function fakeApi(api, url, init) {
  let body = {};
  try {
    body = JSON.parse((init && init.body) || '{}');
  } catch (_) {}
  const prompt = body.input || (Array.isArray(body.messages) ? body.messages.map((m) => m.content).join('\n') : '');
  if (body.response_format && body.response_format.json_schema && body.response_format.json_schema.name === 'refchat_ambience') {
    const items = JSON.parse(body.messages[body.messages.length - 1].content).messages;
    api.ambienceCalls.push(items);
    const result = api.ambience(items);
    if (result === 'length') return reply(url, '', 'reasoning');
    if (result === 'prose') return reply(url, 'illisible', 'ok');
    return reply(url, JSON.stringify({ messages: result }), 'ok');
  }
  if (body.response_format && body.response_format.json_schema &&
      body.response_format.json_schema.name === 'refchat_live_decisions') {
    const items = JSON.parse(body.messages[body.messages.length - 1].content);
    const second = /Independent final check/.test(prompt);
    api.liveCalls.push({ lane: body.model, n: items.length, second });
    const result = api.live(body.model, items, second);
    if (result === 'prose') return reply(url, 'réponse illisible', 'ok');
    if (result === 'length') return reply(url, '', 'reasoning');
    return reply(url, JSON.stringify({ decisions: result }), 'ok');
  }
  const am = String(prompt).match(/Author @(\S+) last (\d+) messages/);
  if (am) {
    api.authorCalls.push({
      lane: body.model,
      author: am[1],
      n: Number(am[2]),
      reasoning: body.reasoning || null,
      effort: body.reasoning_effort,
      maxOut: body.max_output_tokens || body.max_tokens || 0
    });
    const how = api.author(body.model, am[1]);
    const text = JSON.stringify(how === 'toxic' ? { toxic: true, score: 0.93, kind: 'toxique' } : { toxic: false, score: 0.1, kind: 'ok' });
    return reply(url, text, how);
  }
  const m = String(prompt).match(/\n(\d+) lines:\n([\s\S]*?)\n\{"v":\[\d+ bools\]/);
  if (!m) return json({});
  const lines = m[2].split('\n');
  api.calls.push({ lane: body.model, n: lines.length, effort: body.reasoning_effort, reasoning: body.reasoning || null });
  const how = api.mode(body.model, lines);
  // 'short' : JSON valide mais une ligne oubliée (Haiku 5.5, lot politique, 2026-11-09).
  const shown = how === 'short' ? lines.slice(1) : lines;
  const text =
    how === 'prose'
      ? 'Bien sur ! Voici un poeme sur les chats.'
      : JSON.stringify({ v: shown.map((l) => !!api.verdict(body.model, l)), p: shown.map(() => false) });
  return reply(url, text, how);
}

// opts.sync : zone chrome.storage.sync (csg_settings). Un redemarrage relit les
// deux zones : `bench(b.store, { sync: b.sync })` relance un worker sur le disque
// d'un autre.
function bench(store0, opts) {
  const store = JSON.parse(JSON.stringify(store0 || {}));
  const syncStore = JSON.parse(JSON.stringify((opts && opts.sync) || {}));
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const stub = new Proxy(function () {}, {
    get(t, k) {
      if (k === 'then') return undefined;
      if (k === Symbol.toPrimitive) return () => '';
      return stub;
    },
    apply() {
      return stub;
    }
  });
  const later = (cb, v) => {
    if (typeof cb === 'function') setImmediate(() => cb(v));
    return Promise.resolve(v);
  };
  // Meme contrat que chrome.storage : callback asynchrone, valeurs clonees.
  const area = (db) => ({
    get(keys, cb) {
      const out = {};
      if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
        for (const k of Object.keys(keys)) out[k] = k in db ? clone(db[k]) : clone(keys[k]);
      } else {
        for (const k of keys == null ? Object.keys(db) : [].concat(keys)) if (k in db) out[k] = clone(db[k]);
      }
      return later(cb, out);
    },
    set(obj, cb) {
      for (const k of Object.keys(obj || {})) db[k] = clone(obj[k]);
      return later(cb);
    },
    remove(keys, cb) {
      for (const k of [].concat(keys)) delete db[k];
      return later(cb);
    }
  });
  const local = area(store);
  const sync = area(syncStore);
  // Ecouteurs d'evenements (runtime.onMessage, windows.onRemoved...) : un test
  // les declenche comme le navigateur, `emit('runtime.onMessage', msg, sender, reply)`.
  const listeners = {};
  const events = {};
  const eventOf = (name) =>
    events[name] ||
    (events[name] = {
      addListener: (fn) => (listeners[name] = listeners[name] || []).push(fn),
      removeListener() {},
      hasListener: () => false
    });
  const withEvents = (ns, extra) =>
    new Proxy(
      {},
      {
        get(t, k) {
          if (Object.hasOwn(t, k)) return t[k];
          if (extra && k in extra) return extra[k];
          if (typeof k === 'string' && /^on[A-Z]/.test(k)) return eventOf(ns + '.' + k);
          return stub;
        }
      }
    );
  const runtime = withEvents('runtime', {
    lastError: undefined,
    getManifest: () => ({ version: '0.0.0' }),
    // fromExtPage compare sender.url a ce prefixe : sans lui, tout message du
    // popup ou du tableau serait ignore sans reponse.
    getURL: (p) => 'chrome-extension://refchat/' + (p || '')
  });
  const windows = withEvents('windows', { get: (id, cb) => later(cb, api.window) });
  const tabs = withEvents('tabs', { get: (id, cb) => later(cb, api.tab) });
  const chrome = new Proxy(
    {},
    {
      get(t, k) {
        if (k === 'storage') return { local, sync, session: area({}), onChanged: stub };
        if (k === 'runtime') return runtime;
        if (k === 'windows') return windows;
        if (k === 'tabs') return tabs;
        return stub;
      }
    }
  );
  const emit = (name, ...args) => (listeners[name] || []).map((fn) => fn(...args));
  const RealDate = Date;
  let offset = 0;
  class FakeDate extends RealDate {
    constructor(...a) {
      super(...(a.length ? a : [RealDate.now() + offset]));
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  const unref = (t) => {
    if (t && t.unref) t.unref();
    return t;
  };
  const api = {
    mode: () => 'ok',
    verdict: (id, line) => /toxique/.test(line),
    author: () => 'keep',
    live: (_, items) => items.map((it) => ({ id: it.id, decision: 'keep', category: 'none', evidence: '' })),
    calls: [],
    authorCalls: [],
    liveCalls: [],
    ambienceCalls: [],
    ambience: (items) => items.map((x) => ({ id: x.id, negative: false, evidence: '' })),
    tab: { id: 1, active: true, url: 'https://www.twitch.tv/example', windowId: 1 },
    window: { focused: true }
  };
  const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const ctx = {
    console: process.env.DEBUG ? console : quiet,
    setTimeout: (f, ms) => unref(setTimeout(f, ms)),
    clearTimeout,
    setInterval: (f, ms) => unref(setInterval(f, ms)),
    clearInterval,
    queueMicrotask,
    crypto: globalThis.crypto,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    Headers,
    Response,
    Date: FakeDate,
    chrome,
    navigator: { userAgent: 'node' },
    fetch: (url, init) => fakeApi(api, url, init)
  };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  ctx.addEventListener = () => {};
  ctx.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'background.js' });
  const run = (expr) => vm.runInContext(expr, ctx);
  const gKey = store.csg_engine && store.csg_engine.googleKey;
  if (gKey) run('googleResolvedKey = ' + JSON.stringify(gKey));
  return { run, store, sync: syncStore, api, emit, advance: (ms) => (offset += ms) };
}

const tick = () => new Promise((r) => setImmediate(r));

// Reglages du popup, comme s'ils venaient du disque. On les ecrit dans la zone
// sync AVANT d'appeler applySettings : sinon le chargement asynchrone du worker
// (loadPunishTarget) rappelle applySettings avec l'ancien contenu, une frame
// plus tard, et efface le reglage qu'on vient de poser — le modele choisi
// retombait a '' sans rien dire.
function setSettings(b, patch) {
  const next = Object.assign({}, b.sync.csg_settings || {}, patch || {});
  b.sync.csg_settings = next;
  b.run('applySettings(' + JSON.stringify(next) + ')');
  return next;
}

// Le worker relit file et compteurs avant d'ecrire ou de juger (auditRestored) :
// un test qui appelle persistQueueNow ou pumpAudit juste apres bench() attend ca.
async function booted(b) {
  for (let i = 0; i < 200 && !b.run('typeof auditRestored === "undefined" || auditRestored'); i++) await tick();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const E = { glmKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bench', googleKey: 'AIza-test' };
// Juge vivant : Grok via OAuth. Pas de date d'expiration, pour que les pauses
// simulées (jusqu'à 30 min) ne déclenchent pas un refresh réseau.
const X = { xaiOAuth: { access: 'test-oauth-token', refresh: 'test-refresh' } };
const GROK = 'grok-4.6';
const lane = (b, id) => b.run('ALL_LANES').find((l) => l.id === id) || b.run('CHAIN').find((l) => l.id === id);

function seed(b, n, text, author) {
  const q = b.run('auditQueue');
  const now = b.run('Date.now()');
  for (let i = 0; i < n; i++) {
    q.push({ a: author ? author(i) : 'viewer' + i, t: text(i), id: 'id-' + String(i).padStart(3, '0'), ts: now, channel: 'sim' });
  }
}

// La pompe, sans ses minuteries : on la deroule a la main, lot par lot. Quand
// aucune lane n'est ouverte, l'horloge saute a la fin de la pause la plus courte.
async function pump(b, maxSteps, engine) {
  const eng = engine || E;
  let steps = 0;
  while (b.run('auditQueue.length') > 0 && steps++ < maxSteps) {
    const free = b.run('freeLanes')(eng);
    if (!free.length) {
      b.advance(Math.max(1000, b.run('nextSkipWait()') + 1));
      continue;
    }
    for (const l of free) {
      const batch = b.run('takeAuditBatch')(b.run('liveLane')(l));
      if (!batch.length) break;
      await b.run('runLaneJob')(eng, l, batch);
    }
  }
  return steps;
}

function checker() {
  const state = { fails: 0 };
  state.check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) state.fails++;
    console.log(
      (ok ? '  ok  ' : ' FAIL ') +
        name +
        (ok ? '' : '\n        obtenu  ' + JSON.stringify(got) + '\n        attendu ' + JSON.stringify(want))
    );
  };
  return state;
}

module.exports = { bench, booted, tick, wait, E, X, GROK, lane, seed, pump, checker, setSettings };
