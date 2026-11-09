'use strict';

const { bench, checker } = require('./bench');

const T = checker();
const check = T.check;
const URL = 'https://api.x.ai/v1';
const body = { model: 'grok-4.20-0309-non-reasoning', messages: [{ role: 'user', content: 'test' }] };

function setup(expires) {
  const b = bench({ csg_engine: { xaiOAuth: { access: 'old', refresh: 'refresh-old', expires } } });
  b.run('globalThis.__requests = []');
  return b;
}

async function call(b) {
  return b.run('llmFetch')(URL, 'old', body, 1000, '/chat/completions');
}

(async () => {
  {
    const b = setup(Date.now() - 1000);
    b.run(`globalThis.fetch = async (url, init) => {
      if (String(url).includes('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'fresh', refresh_token: 'refresh-new', expires_in: 3600 }), { status: 200 });
      __requests.push(init.headers.Authorization);
      return new Response('{}', { status: 200 });
    }`);
    await call(b);
    check('expiration : appel avec jeton renouvelé', b.run('__requests'), ['Bearer fresh']);
    check('expiration : nouveau jeton conservé', b.store.csg_engine.xaiOAuth.access, 'fresh');
  }

  {
    const b = setup(Date.now() + 3600000);
    b.store.csg_engine.xaiKey = 'old-api-key';
    check('OAuth prioritaire sur ancienne clé API', b.run('laneKey')(b.run('splitKeys')(b.store.csg_engine), b.run('CHAIN').find((lane) => lane.key === 'xai')), 'old');
  }

  {
    const b = setup(Date.now() + 3600000);
    b.run("pickedLane = 'grok-4.6'; engineCache = splitKeys({ xaiOAuth: { access: 'old', refresh: 'refresh-old', expires: Date.now() + 3600000 } }); modelSkipUntil[pickedLane] = Date.now() + 300000; modelSkipReason[pickedLane] = 'clé'; rateLimited = true; cooldownUntil = Date.now() + 300000");
    const snap = b.run('snapshotAudit')();
    check('auth refusée : le bandeau ne dit pas rate limit', snap.rateLimited, false);
    check('auth refusée : le modèle apparaît dans le diagnostic', snap.lanes.some((lane) => lane.label.includes('Grok 4.6')), true);
  }

  {
    const b = setup(Date.now() + 3600000);
    b.run(`globalThis.fetch = async (url, init) => {
      if (String(url).includes('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }), { status: 200 });
      __requests.push(init.headers.Authorization);
      return new Response('{}', { status: init.headers.Authorization === 'Bearer old' ? 401 : 200 });
    }`);
    await call(b);
    check('401 anticipé : renouvellement et un seul nouvel essai', b.run('__requests'), ['Bearer old', 'Bearer fresh']);
  }

  {
    const b = setup(Date.now() + 3600000);
    b.run(`globalThis.fetch = async (url, init) => {
      if (String(url).includes('/oauth2/token')) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      __requests.push(init.headers.Authorization);
      return new Response('{}', { status: 401 });
    }`);
    let err = '';
    try { await call(b); } catch (e) { err = String(e.message || e); }
    check('refresh refusé : demande reconnexion', err, 'session SuperGrok expirée — reconnecte ton compte');
    check('refresh refusé : popup ne dit plus connecté', (await b.run('getXaiOAuthStatus')()).has, false);
    await b.run('saveXaiOAuth')({ access: 'reconnected', refresh: 'refresh-new', expires: Date.now() + 3600000 });
    check('reconnexion : statut rétabli', (await b.run('getXaiOAuthStatus')()).has, true);
  }

  if (T.fails) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
