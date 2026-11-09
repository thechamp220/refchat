'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refchat-sync-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const token = 'test-token-123456789';
let server;
let fails = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails += 1;
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (ok ? '' : '\n        obtenu  ' + JSON.stringify(got) + '\n        attendu ' + JSON.stringify(want)));
}

function snap(rev, marker) {
  return {
    v: 1,
    rev,
    settings: { marker },
    engine: {},
    muted: {},
    learned: [],
    learnLog: [],
    learnBlock: [],
    learnAt: 0,
    ftLog: [],
    ftCount: 0,
    authors: {},
    toxic: {}
  };
}

function start() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(ROOT, 'sync-server', 'server.mjs')], {
      env: Object.assign({}, process.env, {
        CSG_PORT: String(port),
        CSG_BIND: '127.0.0.1',
        CSG_TOKEN: token,
        CSG_FILE: path.join(dir, 'snapshot.json')
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('demarrage timeout: ' + out)), 5000);
    const onData = (d) => {
      out += String(d);
      if (out.includes('csg-sync')) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    server.on('exit', (code) => {
      if (!out.includes('csg-sync')) {
        clearTimeout(timer);
        reject(new Error('serveur quitte ' + code + ': ' + out));
      }
    });
  });
}

async function request(method, body, extra) {
  const headers = Object.assign(
    { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    extra || {}
  );
  const res = await fetch('http://127.0.0.1:' + port + '/snapshot', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = method === 'HEAD' ? '' : await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      parsed = text;
    }
  }
  return { status: res.status, etag: res.headers.get('etag') || '', body: parsed };
}

(async () => {
  await start();

  console.log('\n--- validation du snapshot ---');
  check('objet vide refuse', (await request('PUT', {})).status, 422);
  check('aucun fichier cree', (await request('GET')).status, 404);

  console.log('\n--- creation conditionnelle ---');
  const created = await request('PUT', snap(1, 'initial'), { 'If-None-Match': '*' });
  check('premiere creation', created.status, 200);
  check('etag retourne', !!created.etag, true);
  check('seconde creation refusee', (await request('PUT', snap(2, 'late'), { 'If-None-Match': '*' })).status, 412);

  console.log('\n--- protection contre le dernier PUT gagnant ---');
  const before = await request('GET');
  check('lecture initiale', before.body.settings.marker, 'initial');
  const winner = await request('PUT', snap(3, 'winner'), { 'If-Match': before.etag });
  check('premier ecrivain accepte', winner.status, 200);
  const stale = await request('PUT', snap(4, 'stale'), { 'If-Match': before.etag });
  check('ecrivain stale refuse', stale.status, 412);
  check('snapshot gagnant conserve', (await request('GET')).body.settings.marker, 'winner');

  console.log('\n--- rejet sans destruction ---');
  check('schema incomplet refuse', (await request('PUT', { v: 1 })).status, 422);
  check('snapshot precedent intact', (await request('GET')).body.settings.marker, 'winner');

  console.log(fails ? '\n' + fails + ' ECHEC(S)\n' : '\ntout est vert\n');
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  if (server) server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
