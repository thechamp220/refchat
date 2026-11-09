'use strict';
const assert = require('node:assert/strict');
const { bench, booted, tick, X } = require('./bench');
const sender = { tab: { id: 1, active: true, url: 'https://www.twitch.tv/example', windowId: 1 } };
const negative = (items) => items.map((item) => ({ id: item.id, negative: true, evidence: 'message penible' }));
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('OK ' + name); }
async function settle() { for (let i = 0; i < 20; i++) await tick(); }
async function fresh(store) {
  const b = bench(Object.assign({ csg_engine: X }, store));
  await booted(b);
  await settle();
  return b;
}
function captureAmbience(b, prefix, tab = sender.tab) {
  for (let i = 0; i < 12; i++) b.run('captureAmbience')({
    id: 'csg_' + prefix + '_' + i, author: 'viewer' + i % 3, text: 'message penible ' + i,
    channel: 'twitch/example', capturedAt: b.run('Date.now()'), ambienceEligible: true
  }, { tab });
}
const keepAlive = setInterval(() => {}, 1000);
(async () => {
  await check('démuter et ajouter simultanément ne ressuscite pas le mute retiré', async () => {
    const b = await fresh({ csg_muted: { old: { at: Date.now(), site: 'twitch', strikes: 'manuel' } } });
    b.run('removeMute("old"); addMute("new", 1, "manuel", {channel:"twitch/example"})');
    await settle();
    assert.deepEqual(Object.keys(b.store.csg_muted), ['new']);
    assert.deepEqual(Object.keys(b.run('mutedUsers')), ['new']);
  });
  await check('une écriture échouée ne publie pas de mute et libère les écritures suivantes', async () => {
    const b = await fresh();
    b.run(`globalThis.__muteResults = []; globalThis.__failMute = true;
      globalThis.__localSet = chrome.storage.local.set;
      chrome.storage.local.set = (value, cb) => {
        if (value.csg_muted && __failMute) { __failMute = false; throw new Error('test: stockage indisponible'); }
        return __localSet(value, cb);
      };
      addMute('failed', 1, 'manuel', {channel:'twitch/example'}, ok => __muteResults.push(ok));
      addMute('saved', 1, 'manuel', {channel:'twitch/example'}, ok => __muteResults.push(ok));`);
    await settle();
    assert.deepEqual(Array.from(b.run('__muteResults')), [false, true]);
    assert.deepEqual(Object.keys(b.store.csg_muted), ['saved']);
    assert.equal(b.run('muteWriteBusy'), false);
  });
  await check('deux ajouts simultanés du même pseudo conservent Twitch et Kick', async () => {
    const b = await fresh();
    b.run(`addMute('bob', 1, 'manuel', {channel:'kick/example', perm:true});
      addMute('bob', 1, 'manuel', {channel:'twitch/example', perm:true});`);
    await settle();
    assert.equal(!!b.run('mutedOn("bob", "twitch")'), true);
    assert.equal(!!b.run('mutedOn("bob", "kick")'), true);
    assert.deepEqual(Object.keys(b.store.csg_muted.bob.sites).sort(), ['kick', 'twitch']);
  });
  await check('le mute manuel confirme le stockage et conserve le choix permanent', async () => {
    const b = await fresh();
    let answer;
    const response = new Promise(resolve => {
      const handled = b.emit('runtime.onMessage', { type: 'CSG_LOCAL_MUTE', author: 'bob', score: 1,
        reason: 'motif personnel', channel: 'twitch/example', perm: true },
      { url: 'chrome-extension://refchat/board.html' }, value => { answer = value; resolve(value); });
      assert.ok(handled.includes(true), 'canal de réponse maintenu ouvert');
    });
    assert.equal(answer, undefined, 'pas de confirmation avant l’écriture');
    const confirmed = await response;
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.applied, true);
    assert.equal(b.store.csg_muted.bob.perm, true);
    assert.equal(b.store.csg_muted.bob.strikes, 'motif personnel');
    b.run('pardonFalseMutes([])');
    await settle();
    assert.equal(!!b.store.csg_muted.bob, true, 'le choix permanent reste protégé');
  });
  await check('effacer la liste pendant un ajout attend l’écriture et reste vide', async () => {
    const b = await fresh();
    b.run('addMute("bob", 1, "manuel", {channel:"twitch/example"})');
    const response = new Promise(resolve => b.emit('runtime.onMessage', { type: 'CSG_MUTE_CLEAR' },
      { url: 'chrome-extension://refchat/board.html' }, resolve));
    const answer = await response;
    await settle();
    assert.equal(answer.ok, true);
    assert.deepEqual(Object.keys(b.store.csg_muted), []);
    assert.deepEqual(Object.keys(b.run('mutedUsers')), []);
  });
  for (const action of ['disable', 'reveal']) await check('résultat d’ambiance ignoré pendant le dernier contrôle de focus : ' + action, async () => {
    const b = await fresh();
    b.api.ambience = negative;
    b.run('globalThis').__focusHook = () => {
      if (!b.api.ambienceCalls.length) return;
      b.run(action === 'disable' ? 'configureAmbience({ambiencePause:false})' : 'revealAmbience("twitch/example")');
    };
    b.run('liveTabFocused = async () => { __focusHook(); return true; }');
    captureAmbience(b, action);
    b.advance(15001);
    await b.run('runAmbience()');
    await settle();
    const state = b.store.csg_ambience_state['twitch/example'];
    assert.equal(!!(state && state.until > b.run('Date.now()')), false);
    if (action === 'disable') assert.equal(b.run('ambienceEnabled'), false);
  });
  await check('les captures arrivées pendant une analyse déclenchent la suivante sans nouveau message', async () => {
    const b = await fresh();
    b.run('globalThis.__scheduled = []; setTimeout = (fn, ms) => { __scheduled.push({fn,ms}); return __scheduled.length; }; clearTimeout = () => {};');
    b.api.ambience = (items) => {
      if (b.api.ambienceCalls.length === 1) {
        captureAmbience(b, 'during');
        b.advance(10000);
      }
      return items.map(item => ({ id: item.id, negative: false, evidence: '' }));
    };
    captureAmbience(b, 'before');
    b.run('ambienceTimer = null; __scheduled = []');
    b.advance(15001);
    await b.run('runAmbience()');
    await settle();
    const next = b.run('__scheduled').find(timer => String(timer.fn).includes('runAmbience'));
    assert.ok(next, 'prochaine passe planifiée');
    assert.ok(next.ms > 0 && next.ms <= 5000);
    b.advance(next.ms + 1);
    next.fn();
    await settle();
    assert.equal(b.api.ambienceCalls.length, 2);
    assert.equal(b.api.ambienceCalls[1].every(item => item.id.startsWith('csg_during_')), true);
  });
  await check('un changement d’URL dans le même chat renouvelle l’échantillon', async () => {
    const b = await fresh();
    const newTab = { ...sender.tab, url: sender.tab.url + '?ref=changed' };
    b.api.ambience = (items) => {
      if (b.api.ambienceCalls.length === 1) {
        b.api.tab = newTab;
        captureAmbience(b, 'new_url', newTab);
      }
      return negative(items);
    };
    captureAmbience(b, 'old_url');
    b.advance(15001);
    await b.run('runAmbience()');
    await settle();
    assert.equal(b.store.csg_ambience_state['twitch/example'], undefined, 'ancien résultat rejeté');
    b.advance(15001);
    await b.run('runAmbience()');
    await settle();
    assert.equal(b.api.ambienceCalls.length, 2);
    assert.equal(b.store.csg_ambience_state['twitch/example'].hide, true);
  });
  await check('annuler une décision IA directe retire aussi son mute persistant', async () => {
    const b = await fresh();
    await b.run('setLiveMode("on")');
    b.api.live = (_, items) => items.map(it => ({ id: it.id, decision: 'mute', category: 'targeted_insult', evidence: 'sale connard' }));
    b.emit('runtime.onMessage', { type: 'CSG_CAPTURE', id: 'csg_undo_live', author: 'bob',
      text: 'tu es un sale connard', channel: 'twitch/example', source: 'pending',
      label: 'pending', capturedAt: b.run('Date.now()'), liveEligible: true }, sender, () => {});
    await settle();
    await b.run('runLiveQueue()');
    await settle();
    assert.equal(!!b.run('mutedOn("bob", "twitch")'), true);
    const result = await b.run('undoLiveMute("twitch/example", "bob")');
    await settle();
    assert.equal(result.ok, true);
    assert.equal(b.run('liveMode()'), 'off');
    assert.equal(!!b.run('mutedOn("bob", "twitch")'), false);
    assert.equal(!!b.store.csg_muted.bob, false);
  });
  for (const action of ['keep_other_site', 'remove_other_site', 'manual_override']) {
    await check('annulation directe préserve la provenance des décisions : ' + action, async () => {
      const b = await fresh();
      await b.run('setLiveMode("on")');
      const item = { id: 'csg_owned_' + action, author: 'bob', text: 'sale connard', channel: 'twitch/example',
        capturedAt: b.run('Date.now()'), tabId: 1, tabUrl: sender.tab.url };
      assert.equal(await b.run('applyLiveMute')(item, 'targeted_insult', b.run('liveEpoch')), true);
      if (action === 'manual_override') {
        await new Promise(resolve => b.run('addMute')('bob', 1, 'manuel', { channel: 'twitch/example', perm: true }, resolve));
      } else {
        await new Promise(resolve => b.run('addMute')('bob', 1, 'manuel', { channel: 'kick/example', perm: true }, resolve));
        if (action === 'remove_other_site') {
          await new Promise(resolve => b.run('removeMute')('bob', resolve, 'kick'));
          assert.equal(!!b.store.csg_muted.bob.perm, false, 'le permanent de Kick ne migre pas sur Twitch');
        }
      }
      const result = await b.run('undoLiveMute("twitch/example", "bob")');
      await settle();
      assert.equal(result.ok, true);
      assert.equal(!!b.run('mutedOn("bob", "twitch")'), action === 'manual_override');
      assert.equal(!!b.run('mutedOn("bob", "kick")'), action === 'keep_other_site');
    });
  }
  await check('arrêter le direct pendant son écriture ne laisse pas un mute persistant tardif', async () => {
    const b = await fresh();
    await b.run('setLiveMode("on")');
    b.run('globalThis').__stopDuringMute = () => { b.run('setLiveMode("off")'); };
    b.run(`globalThis.__originalSet = chrome.storage.local.set;
      chrome.storage.local.set = (value, cb) => {
        if (value.csg_muted && value.csg_muted.bob && liveMode() === 'on') __stopDuringMute();
        return __originalSet(value, cb);
      };`);
    const item = { id: 'csg_late_mute', author: 'bob', text: 'sale connard', channel: 'twitch/example',
      capturedAt: b.run('Date.now()'), tabId: 1, tabUrl: sender.tab.url };
    const applied = await b.run('applyLiveMute')(item, 'targeted_insult', b.run('liveEpoch'));
    await settle();
    assert.equal(applied, false);
    assert.equal(!!b.store.csg_muted.bob, false);
    assert.deepEqual(Object.keys(b.store.csg_live_muted), []);
  });
  console.log(checks + ' régressions de concurrence OK');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
