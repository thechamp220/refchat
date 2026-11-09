'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bench, booted, tick, wait, X } = require('./bench');
const root = path.join(__dirname, '..');
const items = [
  { id: 'csg_hard_a', a: 'alice', t: 'bonjour', channel: 'twitch/demo' },
  { id: 'csg_hard_b', a: 'bob', t: 'bonjour', channel: 'twitch/demo' }
];
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('  ok  ' + name); }
async function ready(store) {
  const b = bench(store || { csg_engine: X });
  await booted(b);
  for (let i = 0; i < 40 && !b.run('ftLoaded && mutedLoaded && baitLoaded'); i++) await tick();
  assert.equal(b.run('ftLoaded && mutedLoaded && baitLoaded'), true);
  b.run('BULK.GAP_MS = 0; BULK.RETRY_GAP_MS = 0');
  return b;
}
async function until(fn) {
  for (let i = 0; i < 200 && !fn(); i++) await wait(2);
  assert.equal(!!fn(), true, 'état attendu avant le délai du test');
}
function pending(b, id, author, text, channel = 'twitch/demo', ts = Date.now()) {
  b.run('upsertFt(' + JSON.stringify({ id, author, text, channel, ts }) + ', { label: "pending" })');
}
const expired = () => ({ csg_engine: { xaiOAuth: { access: 'old-test', refresh: 'refresh-test', expires: Date.now() - 1000 } } });
const call = b => b.run('llmFetch')('https://api.x.ai/v1', 'old-test', { model: 'grok-4.20-0309-non-reasoning', messages: [] }, 1000, '/chat/completions');
const keepAlive = setInterval(() => {}, 1000);

(async () => {
  {
    const b = bench({ csg_engine: X, csg_manual_run: { running: true, total: 1, done: 0, results: [], err: '' },
      csg_ft_log: [{ id: 'csg_cold_stop', author: 'alice', text: 'message à conserver', channel: 'twitch/demo', ts: Date.now(), label: 'pending' }] });
    b.run('stopBulkAudit()');
    await booted(b);
    for (let i = 0; i < 15; i++) await tick();
    check('arrêt pendant le démarrage : sauvegarde ancienne jamais relancée', () => {
      assert.equal(b.run('bulk.running'), false);
      assert.equal(b.run('ftById.get("csg_cold_stop").label'), 'pending');
      assert.equal(b.run('bulk.done'), 0);
      assert.equal(b.api.calls.length, 0);
    });
  }
  {
    const b = await ready();
    const invalid = ['{}', 'null', '[]', '{"v":[true],"p":[false]}', '{"v":[false,false]}',
      '{"v":["true",false],"p":[false,false]}', '{"v":[false,false],"p":["true",false]}',
      '{"v":[false,false],"p":[false,false],"mute":["csg_hard_a"]}',
      'Le message csg_hard_a est innocent.', '```json\n{"v":[true,false],"p":[false,false]}\n```'];
    for (const raw of invalid) check('JSON incorrect reste sans verdict : ' + raw.slice(0, 45), () => {
      const out = b.run('parseBatchVerdicts')(raw, items);
      assert.equal(out.every(r => r.tag === 'skip' && r.score < 0.5), true);
    });
    check('politique sans mute (p sans v) : lot lu, ligne gardée, pas d escalade', () => {
      const out = b.run('parseBatchVerdicts')('{"v":[false,true],"p":[true,true]}', items);
      assert.deepEqual(Array.from(out, r => [r.tag === 'skip', r.score >= 0.5, !!r.pol]), [[false, false, false], [false, true, true]]);
    });
    check('lot complet accepte exactement deux booléens', () => {
      const out = b.run('parseBatchVerdicts')('{"v":[true,false],"p":[false,false]}', items);
      assert.deepEqual(Array.from(out, r => r.score >= 0.5), [true, false]);
    });
    b.run(`globalThis.__bodies = []; globalThis.__finish = 'length'; globalThis.__content = '{"v":[true,false],"p":[false,false]}';
      fetch = async (_, init) => { __bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ choices: [{ finish_reason: __finish, message: { content: __content, reasoning: '{"v":[true,false],"p":[false,false]}' } }] }), { status: 200 }); };`);
    const lane = b.run('CHAIN')[0];
    let out = await b.run('tryLane')(X, lane, items, 1000);
    check('sortie tronquée rejetée même si son JSON ferme correctement', () => assert.equal(out.every(r => r.tag === 'skip'), true));
    check('requête contient un schéma strict de taille exacte', () => {
      const format = b.run('__bodies[0].response_format');
      assert.equal(format.json_schema.strict, true);
      assert.equal(format.json_schema.schema.properties.v.minItems, 2);
      assert.equal(format.json_schema.schema.properties.v.maxItems, 2);
    });
    b.run("__finish = 'stop'; __content = ''");
    out = await b.run('tryLane')(X, lane, items, 1000);
    check('le raisonnement seul ne devient jamais un verdict', () => assert.equal(out.every(r => r.tag === 'skip'), true));
  }

  {
    const b = await ready(expired());
    b.run(`globalThis.__refreshes = 0; globalThis.__rejected = 0;
      fetch = async (url, init) => {
        if (String(url).includes('/oauth2/token')) { __refreshes++; return new Response(JSON.stringify({ access_token: 'fresh-test', refresh_token: 'refresh-new', expires_in: 3600 }), { status: 200 }); }
        const ok = init.headers.Authorization === 'Bearer fresh-test'; if (!ok) __rejected++;
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"v":[false],"p":[false]}' } }] }), { status: ok ? 200 : 401 });
      };`);
    const snapshot = await b.run('getEngine')();
    for (const it of items) await b.run('tryLane')(snapshot, b.run('CHAIN')[0], [it], 1000);
    check('deux lots utilisent le nouveau jeton malgré leur ancien engine', () => {
      assert.equal(b.run('__refreshes'), 1); assert.equal(b.run('__rejected'), 0);
    });
  }

  for (const mode of ['503', 'network']) {
    const b = await ready(expired());
    b.run(mode === '503'
      ? `fetch = async () => new Response('{"error":"temporarily_unavailable"}', { status: 503 });`
      : `fetch = async () => { throw new Error('fetch failed'); };`);
    await assert.rejects(call(b), e => e.retryable === true);
    const status = await b.run('getXaiOAuthStatus')();
    check('refresh ' + mode + ' conserve la session et indique une panne temporaire', () => {
      assert.equal(status.has, true); assert.equal(status.invalid, false);
      assert.match(status.err, /temporairement indisponible/);
      assert.equal(b.store.csg_engine.xaiOAuth.refresh, 'refresh-test');
    });
  }

  {
    const b = await ready(expired());
    b.run(`globalThis.__refreshStarted = false; globalThis.__release = null;
      fetch = async () => { __refreshStarted = true; return new Promise(resolve => { __release = () => resolve(new Response('{"access_token":"late-test","expires_in":3600}', { status: 200 })); }); };`);
    const req = call(b);
    const rejected = assert.rejects(req, /session SuperGrok expirée/);
    await until(() => b.run('__refreshStarted'));
    await b.run('xaiLogout')();
    b.run('__release()');
    await rejected;
    check('logout pendant un refresh ne reconnecte pas le compte', () => assert.equal(b.store.csg_engine.xaiOAuth, null));
  }

  {
    const b = await ready();
    b.run(`globalThis.__release = null;
      fetch = async () => new Promise(resolve => { __release = () => resolve(new Response('{"device_code":"late-device","user_code":"TEST","verification_uri":"https://x.ai/","expires_in":300}', { status: 200 })); });`);
    const request = b.run('startXaiOAuthLogin')();
    await until(() => b.run('!!__release'));
    await b.run('xaiLogout')(); b.run('__release()');
    const result = await request;
    check('demande de connexion tardive annulée après déconnexion', () => {
      assert.equal(result.ok, false); assert.equal(b.run('xaiOAuthPending'), null);
      assert.equal(b.store.csg_engine.xaiOAuth, null);
    });
  }

  {
    const b = await ready();
    b.run(`xaiOAuthPending = { deviceCode: 'mock-device', expires: Date.now() + 300000 };
      globalThis.__release = null;
      fetch = async () => new Promise(resolve => { __release = () => resolve(new Response('{"access_token":"late-approval","refresh_token":"mock-refresh","expires_in":3600}', { status: 200 })); });`);
    const request = b.run('pollXaiOAuthOnce')();
    await until(() => b.run('!!__release'));
    await b.run('xaiLogout')(); b.run('__release()'); await request;
    check('approbation OAuth tardive ne réactive pas un compte déconnecté', () => {
      assert.equal(b.store.csg_engine.xaiOAuth, null); assert.equal(b.run('xaiOAuthPending'), null);
    });
    b.run(`xaiOAuthPending = { deviceCode: 'new-device', expires: Date.now() + 300000 };
      fetch = async () => new Response('{"access_token":"approved-test","refresh_token":"approved-refresh","expires_in":3600}', { status: 200 });`);
    await b.run('pollXaiOAuthOnce')();
    check('approbation OAuth courante connecte toujours le compte', () => {
      assert.equal(b.store.csg_engine.xaiOAuth.access, 'approved-test'); assert.equal(b.run('xaiOAuthPending'), null);
    });
  }

  {
    const b = await ready();
    b.run(`globalThis.__refreshes = 0; fetch = async (url) => { if (String(url).includes('/oauth2/token')) __refreshes++; return new Response('{"error":"permission_denied"}', { status: 403 }); };`);
    await assert.rejects(call(b), /llm_http_403/);
    check('403 conserve la session sans renouvellement inutile', () => {
      assert.equal(b.run('__refreshes'), 0); assert.equal(!!b.store.csg_engine.xaiOAuth.invalid, false);
    });
  }

  {
    const b = await ready();
    pending(b, 'csg_cancel', 'alice', 'toxique');
    b.api.mode = () => { b.run('stopBulkAudit()'); return 'ok'; };
    const status = await b.run('runBulkAudit')();
    for (let i = 0; i < 5; i++) await tick();
    check('arrêt pendant le modèle écarte un verdict tardif de mute', () => {
      assert.equal(status.done, 0); assert.equal(status.running, false);
      assert.equal(b.run("ftById.get('csg_cancel').label"), 'pending');
      assert.equal(!!b.run("mutedUsers['alice']"), false);
      assert.equal(b.store.csg_manual_run.running, false);
    });
  }

  {
    const b = await ready();
    pending(b, 'csg_abort', 'alice', 'toxique');
    b.run(`globalThis.__started = false; globalThis.__aborted = false;
      fetch = async (_, init) => { __started = true; return new Promise((_, reject) => init.signal.addEventListener('abort', () => { __aborted = true; reject(new Error('AbortError')); })); };`);
    const run = b.run('runBulkAudit')();
    await until(() => b.run('__started'));
    b.run('stopBulkAudit()');
    await run;
    check('arrêt annule la requête réseau et ne met pas la lane en erreur', () => {
      assert.equal(b.run('__aborted'), true);
      assert.equal(b.run("ftById.get('csg_abort').label"), 'pending');
      assert.equal(b.run('modelSkipUntil[CHAIN[0].id] || 0'), 0);
    });
  }

  {
    const b = await ready();
    pending(b, 'csg_retry', 'eve', 'bonjour');
    b.api.mode = () => 'prose';
    const first = await b.run('runBulkAudit')();
    b.run('persistFtNow()');
    for (let i = 0; i < 5; i++) await tick();
    check('première reprise bornée à trois appels et persistée', () => {
      assert.equal(first.running, true); assert.equal(first.retryAttempts, 3);
      assert.equal(b.store.csg_manual_run.retryAttempts, 3);
    });
    const restored = bench(b.store);
    restored.api.mode = () => 'prose';
    restored.run('BULK.RETRY_GAP_MS = 0');
    await booted(restored);
    await until(() => !restored.run('bulk.running') && restored.run('bulk.retryAttempts') >= 6);
    check('reboot ne remet pas les essais à zéro : six puis arrêt', () => {
      assert.equal(restored.run('bulk.retryAttempts'), 6);
      assert.equal(restored.api.calls.length, 3);
      assert.equal(restored.run("ftById.get('csg_retry').label"), 'pending');
      assert.match(restored.run('bulk.err'), /6 tentatives/);
    });
  }

  {
    // Haiku 5.5 oubliait une ligne d'un lot politique (6 verdicts pour 7, le
    // 2026-11-09) : le lot est recoupé au lieu d'être rejoué six fois.
    const b = await ready();
    for (let i = 0; i < 5; i++) pending(b, 'csg_short_' + i, 'zoe', i === 3 ? 'toxique ' + i : 'ligne ' + i);
    pending(b, 'csg_short_next', 'lea', 'bonjour');
    b.api.mode = (_, lines) => (lines.length > 2 ? 'short' : 'ok');
    const status = await b.run('runBulkAudit')();
    check('lot avec une ligne oubliée : recoupé en deux, tout est jugé', () => {
      assert.equal(status.running, false);
      assert.equal(status.done, 6);
      assert.deepEqual(b.api.calls.map((c) => c.n), [5, 3, 2, 1, 2, 1]);
      assert.equal(b.run("ftById.get('csg_short_0').label"), 'keep');
      assert.equal(b.run("ftById.get('csg_short_3').label"), 'mute');
      assert.equal(b.run("ftById.get('csg_short_next').label"), 'keep');
      assert.doesNotMatch(String(status.err || ''), /illisible|tentatives/);
      assert.equal(b.run('modelSkipUntil[CHAIN[0].id] || 0'), 0);
    });
  }

  {
    // Une ligne qui fait dérailler le modèle à elle seule, en tête de file :
    // mise de côté (en attente, pas en Ignorés), le reste de la file est jugé.
    const b = await ready();
    pending(b, 'csg_poison', 'max', 'POISON');
    for (let i = 0; i < 3; i++) pending(b, 'csg_poison_ok_' + i, 'max', 'ligne ' + i);
    pending(b, 'csg_poison_next', 'lea', 'toxique');
    b.api.mode = (_, lines) => (lines.some((l) => /POISON/.test(l)) ? 'prose' : 'ok');
    const status = await b.run('runBulkAudit')();
    check('ligne fautive en tête de file : mise de côté, la file avance', () => {
      assert.equal(status.running, false);
      assert.equal(b.run("ftById.get('csg_poison').label"), 'pending');
      for (let i = 0; i < 3; i++) assert.equal(b.run("ftById.get('csg_poison_ok_" + i + "').label"), 'keep');
      assert.equal(b.run("ftById.get('csg_poison_next').label"), 'mute');
      assert.match(status.err, /1 message laissé en attente/);
      assert.deepEqual(Array.from(b.run('bulk.aside')), ['csg_poison']);
      assert.equal(b.run('droppedCount || 0'), 0);
    });
  }

  {
    // Modèle en panne (que de la prose) sur un lot de plusieurs lignes : le
    // découpage reste borné par les six essais, puis l'analyse s'arrête.
    const b = await ready();
    for (let i = 0; i < 4; i++) pending(b, 'csg_dead_' + i, 'nul', 'ligne ' + i);
    b.api.mode = () => 'prose';
    const status = await b.run('runBulkAudit')();
    check('modèle en panne : découpage borné, six essais puis arrêt', () => {
      assert.equal(status.running, false);
      assert.equal(b.api.calls.length, 8);
      assert.match(status.err, /6 tentatives/);
      for (let i = 0; i < 4; i++) assert.equal(b.run("ftById.get('csg_dead_" + i + "').label"), 'pending');
    });
  }

  {
    const b = await ready();
    const old = Date.now() - 3600000;
    pending(b, 'csg_room_a', 'alice', 'x'.repeat(110) + ' ceci est une citation', 'twitch/a', old);
    pending(b, 'csg_room_b', 'bob', 'message salon b', 'kick/b', old);
    b.run('upsertFt(' + JSON.stringify({ id: 'ctx_old', author: 'prior', text: 'ancien contexte du salon a', channel: 'twitch/a', ts: old - 1000 }) + ', { label: "keep" })');
    b.run('trackAuthor("alice", "ta", { id: "old_alice", channel: "twitch/a", ts: ' + (Date.now() - 60000) + ' })');
    b.run(`rememberChat('new', 'contexte actuel sans rapport', { channel: 'twitch/a' });
      globalThis.__requests = []; globalThis.__originalFetch = fetch;
      fetch = (url, init) => { __requests.push(JSON.parse(init.body)); return __originalFetch(url, init); };`);
    await b.run('runBulkAudit')();
    check('salons séparés, texte complet et contexte de la capture', () => {
      const bodies = b.run('__requests'); assert.equal(bodies.length, 2);
      const a = bodies[0].messages[1].content; const other = bodies[1].messages[1].content;
      assert.match(a, /ceci est une citation/); assert.match(a, /ctx:\n[^]*ancien contexte du salon a/);
      assert.match(a, /hist:\n@alice\n- ta/);
      assert.doesNotMatch(a, /message salon b|contexte actuel sans rapport/);
      assert.doesNotMatch(other, /\nctx:\n/);
      assert.match(other, /Historical verdict examples \(not the current conversation\):/);
    });
  }

  async function replyBench() {
    const b = await ready();
    b.run(`baitMem.hourAt = Date.now(); globalThis.__sent = []; globalThis.__modelCalls = 0;
      sendBaitToTab = async (job, text) => { __sent.push({ id: job.replyToId, text }); return { ok: true }; };
      fetch = async () => { __modelCalls++; return new Response('{"choices":[{"finish_reason":"stop","message":{"content":"ok et"}}]}', { status: 200 }); };`);
    return b;
  }
  const sender = { tab: { id: 1, url: 'https://www.twitch.tv/demo' }, frameId: 0 };
  {
    const b = await replyBench(); b.run('baitMem.sends = 29');
    const out = await Promise.all(items.map(it => b.run('grokReplyTo')({ id: it.id, author: it.a, text: it.t, channel: it.channel }, sender)));
    check('clics simultanés réservent la dernière place des 30 envois', () => {
      assert.equal(out.filter(r => r.ok).length, 1); assert.equal(b.run('baitMem.sends'), 30);
      assert.equal(b.run('__modelCalls'), 1); assert.equal(b.run('baitReservations.size'), 0);
    });
  }
  {
    const b = await replyBench(); b.run('baitMem.calls = 39');
    await Promise.all(items.map(it => b.run('grokReplyTo')({ id: it.id, author: it.a, text: it.t, channel: it.channel }, sender)));
    check('clics simultanés respectent aussi les 40 appels', () => assert.equal(b.run('baitMem.calls'), 40));
  }
  {
    const b = await replyBench(); const msg = { id: items[0].id, author: 'alice', text: 'bonjour', channel: 'twitch/demo' };
    await Promise.all([b.run('grokReplyTo')(msg, sender), b.run('grokReplyTo')(msg, sender)]);
    check('double clic sur la même ligne produit un seul appel et envoi', () => {
      assert.equal(b.run('__modelCalls'), 1); assert.equal(b.run('__sent.length'), 1);
    });
  }

  {
    const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
    const begin = source.indexOf('function sendBaitToTab(');
    const end = source.indexOf('\nfunction pushThread', begin);
    const callbacks = []; const sent = []; let allowed = true;
    const gates = [{ reservation: Symbol() }, { reservation: Symbol() }];
    const ctx = { baitHour() {}, HAND: { SEND_MAX: 30 }, baitMem: { sends: 0 }, replyAssist: { enabled: false },
      baitReservations: new Set(gates.map(g => g.reservation)), baitSendTails: new Map(),
      chrome: { runtime: {}, tabs: { sendMessage(id, msg, opts, cb) { sent.push(msg.text); callbacks.push(cb); } } } };
    vm.createContext(ctx); vm.runInContext(source.slice(begin, end), ctx);
    const one = ctx.sendBaitToTab({ tabId: 1, frameId: 0 }, 'premier', gates[0]);
    const two = ctx.sendBaitToTab({ tabId: 1, frameId: 0 }, 'second', gates[1], () => allowed);
    for (let i = 0; i < 5; i++) await tick();
    check('le composeur reçoit un seul envoi simultané', () => assert.deepEqual(sent, ['premier']));
    allowed = false; callbacks[0]({ ok: true }); await one; const canceled = await two;
    check('reprendre la main annule un envoi qui attendait son tour', () => {
      assert.equal(canceled.ok, false); assert.deepEqual(sent, ['premier']);
    });
  }

  console.log('\ngrok hardening : ' + checks + ' vérifications OK');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
