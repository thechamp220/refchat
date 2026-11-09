'use strict';
const assert = require('node:assert/strict');
const { bench, booted, tick, X } = require('./bench');
const sender = { tab: { id: 1, active: true, url: 'https://www.twitch.tv/example', windowId: 1 } };
const classify = (items, count = items.length) => items.map((x, i) => ({ id: x.id, negative: i < count, evidence: i < count ? 'message penible' : '' }));
async function sample(b, n = 12, authors = 3, extra = {}, source = sender) {
  for (let i = 0; i < n; i++) {
    b.emit('runtime.onMessage', Object.assign({ type: 'CSG_AMBIENCE_CAPTURE', id: 'csg_amb_' + i,
      author: 'viewer' + i % authors, text: 'message penible numero ' + i,
      channel: 'twitch/example', source: 'pending', capturedAt: b.run('Date.now()'), ambienceEligible: true }, extra), source, () => {});
    await tick();
  }
  b.advance(15001);
  await b.run('runAmbience()');
  await tick();
}
async function fresh(sync) {
  const b = bench({ csg_engine: X }, { sync: { csg_settings: sync || {} } });
  await booted(b);
  return b;
}
(async () => {
  const b = await fresh();
  b.api.ambience = (xs) => classify(xs, 8);
  await sample(b);
  assert.equal(b.api.ambienceCalls.length, 1);
  let state = b.store.csg_ambience_state['twitch/example'];
  assert.equal(state.hide, true);
  assert.equal(state.total, 12);
  assert.equal(state.negative, 8);
  assert.equal(state.until > b.run('Date.now()'), true);
  assert.equal(Object.keys(b.run('mutedUsers')).length, 0, 'no author mute');
  assert.equal(b.run('bulk.running'), false, 'no manual audit');
  assert.equal(b.run('liveMode()'), 'off', 'separate feature');
  b.advance(60001);
  assert.equal(state.until < b.run('Date.now()'), true, 'finite pause');
  await sample(b);
  assert.equal(b.api.ambienceCalls.length, 1, 'no repeated call during cooldown');

  const clean = await fresh();
  await sample(clean);
  assert.equal(clean.store.csg_ambience_state['twitch/example'].until, 0);
  const one = await fresh(); one.api.ambience = classify;
  await sample(one, 12, 1);
  assert.equal(one.store.csg_ambience_state['twitch/example'].hide, false, 'one loud author insufficient');
  const low = await fresh(); low.api.ambience = (xs) => classify(xs, 7);
  await sample(low);
  assert.equal(low.store.csg_ambience_state['twitch/example'].hide, false, 'less than 60 percent');
  const small = await fresh(); await sample(small, 11);
  assert.equal(small.api.ambienceCalls.length, 0);
  for (const cfg of [{ ambiencePause: false }, { enabled: false }]) {
    const off = await fresh(cfg); await sample(off);
    assert.equal(off.api.ambienceCalls.length, 0);
  }
  const oldSim = await fresh({ simulation: true }); await sample(oldSim);
  assert.equal(oldSim.api.ambienceCalls.length, 1, 'old synced simulation setting ignored');
  const backlog = await fresh(); await sample(backlog, 12, 3, { ambienceEligible: false });
  assert.equal(backlog.api.ambienceCalls.length, 0, 'old DOM backlog not live');
  const bg = await fresh(); await sample(bg, 12, 3, {}, { tab: { ...sender.tab, active: false } });
  assert.equal(bg.api.ambienceCalls.length, 0);
  const unfocused = await fresh(); unfocused.api.window.focused = false; await sample(unfocused);
  assert.equal(unfocused.api.ambienceCalls.length, 0);
  const channels = await fresh();
  await sample(channels, 6);
  await sample(channels, 6, 3, { channel: 'twitch/other' });
  assert.equal(channels.api.ambienceCalls.length, 0, 'channels cannot combine to reach threshold');
  const quota = await fresh();
  quota.run('ambienceBudget = {at:Date.now(), count:240}');
  await sample(quota);
  assert.equal(quota.api.ambienceCalls.length, 0, 'local hourly quota');
  const restart = bench(quota.store, { sync: quota.sync });
  await booted(restart);
  // Save the budget as it would be after the last successful call.
  restart.run('ambienceBudget={at:Date.now(),count:240}; chrome.storage.local.set({csg_ambience_budget:ambienceBudget})');
  await tick();
  const resumed = bench(restart.store, { sync: restart.sync });
  await booted(resumed);
  await sample(resumed);
  assert.equal(resumed.api.ambienceCalls.length, 0, 'quota survives worker restart');
  for (const mode of ['prose', 'length', 'evidence', 'missing', 'duplicate']) {
    const bad = await fresh();
    bad.api.ambience = (xs) => mode === 'prose' || mode === 'length' ? mode :
      mode === 'missing' ? classify(xs).slice(1) : mode === 'duplicate' ? xs.map(() => classify(xs)[0]) :
      xs.map((x) => ({ id: x.id, negative: true, evidence: 'invented evidence' }));
    await sample(bad);
    assert.equal(bad.store.csg_ambience_state['twitch/example'], undefined, mode + ' fails open');
  }
  const reveal = await fresh(); reveal.api.ambience = classify; await sample(reveal);
  await reveal.run('revealAmbience("twitch/example")'); await tick();
  assert.equal(reveal.store.csg_ambience_state['twitch/example'].until, 0);
  assert.equal(reveal.store.csg_ambience_state['twitch/example'].cooldownUntil > reveal.run('Date.now()'), true);
  const stopped = await fresh(); stopped.api.ambience = classify;
  stopped.api.ambience = (xs) => {
    stopped.run('applySettings({ambiencePause:false})');
    return classify(xs);
  };
  await sample(stopped);
  assert.equal(stopped.store.csg_ambience_state['twitch/example'], undefined, 'late result after disable discarded');
  console.log('OK ambiance: seuil, auteurs, erreurs, retour, arret, focus et captures nouvelles');
})().catch((e) => { console.error(e); process.exitCode = 1; });
