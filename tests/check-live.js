'use strict';

const assert = require('node:assert/strict');
const { bench, booted, tick, wait, X } = require('./bench');

const sender = { tab: { id: 1, active: true, url: 'https://www.twitch.tv/example', windowId: 1 } };
const toxic = 'tu es un sale connard';
const verdict = (items, decision = 'mute') => items.map((it) => ({
  id: it.id,
  decision,
  category: decision === 'mute' ? 'targeted_insult' : 'none',
  evidence: decision === 'mute' ? 'sale connard' : ''
}));

async function ready(b) {
  await booted(b);
  for (let i = 0; i < 30 && !b.run('liveLoaded && mutedLoaded && ftLoaded'); i++) await tick();
  assert.equal(b.run('liveLoaded && mutedLoaded && ftLoaded'), true);
}

async function capture(b, id, author, text = toxic) {
  const msg = { type: 'CSG_CAPTURE', id, author, text, channel: 'twitch/example',
    source: 'pending', label: 'pending', capturedAt: b.run('Date.now()'), liveEligible: true };
  b.emit('runtime.onMessage', msg, sender, () => {});
  await tick();
}

async function drainLive(b) {
  for (let i = 0; i < 100; i++) {
    if (!b.run('liveBusy') && !b.run('liveQueue.length')) {
      await wait(5);
      if (!b.run('liveBusy') && !b.run('liveQueue.length')) return;
    }
    await wait(5);
  }
}

(async () => {
  const b = bench({ csg_engine: X });
  await ready(b);
  b.api.live = (_, items) => verdict(items);

  // À l'arrêt, les captures restent en pending sans aucun appel direct ni bulk.
  await capture(b, 'csg_off', 'bob', 'salut');
  assert.equal(b.run('liveQueue.length'), 0, 'direct coupé par défaut');
  assert.equal(b.run('bulk.running'), false);
  assert.equal(b.api.liveCalls.length, 0);

  // Activer l'IA en direct NE DOIT PAS lancer l'analyse globale des captures (bulk).
  let status = await b.run("setLiveMode('on')");
  assert.equal(status.mode, 'on');
  assert.equal(b.run('bulk.running'), false, 'activer le direct ne lance pas le bulk audit');
  assert.equal(b.run("ftById.get('csg_off').label"), 'pending', 'les anciens messages du journal restent au clic');

  // Un nouveau message arrivant pendant le live est traité par la queue live
  await capture(b, 'csg_live_1', 'bob', toxic);
  assert.equal(b.run('liveQueue.length'), 1);
  await b.run('runLiveQueue()');
  await drainLive(b);
  assert.equal(b.run('bulk.running'), false, 'le bulk audit ne s est toujours pas déclenché');
  assert.equal(b.run("ftById.get('csg_live_1').label"), 'mute');
  assert.equal(!!b.run("mutedUsers['bob']"), true);

  // Groupement par personne dans la file live
  const multi = bench({ csg_engine: X });
  await ready(multi);
  await multi.run("setLiveMode('on')");
  multi.api.live = (_, items) => items.map((it) => ({
    id: it.id,
    decision: it.text.includes('toxique') ? 'mute' : 'keep',
    category: it.text.includes('toxique') ? 'targeted_insult' : 'none',
    evidence: it.text.includes('toxique') ? 'toxique' : ''
  }));
  await capture(multi, 'csg_m1', 'alice', 'bonjour');
  await capture(multi, 'csg_m2', 'bob', 'coucou');
  await capture(multi, 'csg_m3', 'alice', 'attaque toxique');
  await multi.run('runLiveQueue()');
  await drainLive(multi);
  assert.equal(multi.run('bulk.running'), false);
  assert.equal(multi.run("ftById.get('csg_m3').label"), 'mute');
  assert.equal(!!multi.run("mutedUsers['alice']"), true);

  // Couper remet à l'arrêt sans lancer de bulk
  await multi.run("setLiveMode('off')");
  assert.equal(multi.run('liveMode()'), 'off');
  assert.equal(multi.run('bulk.running'), false);

  console.log('live : on/arrêt indépendant du bulk audit, file de personnes, mute direct OK');
})().catch((e) => { console.error(e); process.exitCode = 1; });
