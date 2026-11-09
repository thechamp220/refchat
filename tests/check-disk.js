'use strict';

// Archive disque à vie : chaque ligne de l'archive ft doit finir en JSONL sur le
// disque, une seule fois, même si le serveur est coupé un moment ou qu'une
// réponse se perd. On fait tourner le vrai archive-server/server.mjs dans un
// dossier temporaire, et le vrai code de background.js contre un faux storage.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
function between(a, b) {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('bloc introuvable : ' + a);
  return src.slice(i, j);
}

let store = {};
globalThis.chrome = {
  runtime: { lastError: null, onSuspend: { addListener() {} } },
  storage: {
    local: {
      get(what, cb) {
        const out = {};
        const keys = Array.isArray(what) ? what : Object.keys(what);
        for (const k of keys) {
          const v = k in store ? store[k] : Array.isArray(what) ? undefined : what[k];
          if (v !== undefined) out[k] = JSON.parse(JSON.stringify(v));
        }
        setTimeout(() => cb(out), 1);
      },
      set(obj, cb) {
        for (const k of Object.keys(obj)) store[k] = JSON.parse(JSON.stringify(obj[k]));
        setTimeout(() => cb && cb(), 1);
      },
      remove(keys, cb) {
        for (const k of [].concat(keys)) delete store[k];
        setTimeout(() => cb && cb(), 1);
      }
    }
  }
};

// eslint-disable-next-line no-eval
eval(
  [
    between('const FT = {', '\nconst BEH = {'),
    between('// ------------------------------------------------------------ archive ft', '\nfunction loadFtLog()'),
    `Object.assign(globalThis, { FT, DISK, archiveFt, flushFtArchive, clearFtArchive, pushDiskArchive,
      restart: () => { ftArchQueue = []; ftArchTimer = null; ftArchIndex = null; diskState = null; diskBusy = false; } });`
  ].join('\n')
);
const { FT, DISK, archiveFt, flushFtArchive, clearFtArchive, pushDiskArchive, restart } = globalThis;
FT.CHUNK = 8;
DISK.CALL_MS = 3000;

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (ok ? '' : '\n        obtenu  ' + JSON.stringify(got) + '\n        attendu ' + JSON.stringify(want)));
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refchat-disk-'));
const port = 20000 + Math.floor(Math.random() * 20000);
DISK.URL = 'http://127.0.0.1:' + port;
let srv = null;

function startServer() {
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, [path.join(__dirname, '..', 'archive-server', 'server.mjs')], {
      env: Object.assign({}, process.env, { REFCHAT_ARCHIVE_DIR: dir, REFCHAT_ARCHIVE_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'inherit']
    });
    srv.stdout.once('data', () => resolve());
    srv.once('error', reject);
  });
}
function stopServer() {
  return new Promise((resolve) => {
    srv.once('exit', () => resolve());
    srv.kill();
  });
}

const push = () => new Promise((r) => pushDiskArchive(r));
const flush = () => new Promise((r) => flushFtArchive(r));
const DAY = Date.UTC(2026, 8, 14, 12);
// Lignes 16+ le lendemain : l ordre des fichiers suit alors celui des lignes.
const row = (i) => ({ id: 'r' + i, ts: DAY + (i > 15 ? 86400000 : 0) + i, text: 'msg ' + i, label: 'keep' });

function onDisk() {
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.jsonl')) for (const l of fs.readFileSync(p, 'utf8').split('\n')) if (l) out.push(JSON.parse(l).id);
    }
  };
  walk(dir);
  return out;
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => 'r' + (a + i));

(async () => {
  await startServer();

  console.log('\n--- l archive part sur le disque, dans l ordre ---');
  const first = [];
  for (let i = 1; i <= 20; i++) first.push(row(i));
  archiveFt(first);
  let st = await push();
  check('20 lignes confirmees', st.sent, 20);
  check('serveur joignable', st.ok, true);
  check('lignes sur disque', onDisk(), range(1, 20));
  check('un fichier par jour', fs.readdirSync(path.join(dir, '2026')).sort(), ['2026-09-14.jsonl', '2026-09-15.jsonl']);

  console.log('\n--- renvoyer ne duplique rien ---');
  st = await push();
  check('rien de neuf', onDisk().length, 20);
  st.sent = 10; // reponse perdue : l extension croit en etre a 10
  st = await push();
  check('le serveur saute ce qu il a deja', onDisk(), range(1, 20));
  check('position recalee', st.sent, 20);

  console.log('\n--- serveur coupe : rien ne se perd ---');
  await stopServer();
  archiveFt([row(21), row(22), row(23)]);
  st = await push();
  check('erreur visible', st.ok, false);
  check('position inchangee', st.sent, 20);
  restart(); // le worker MV3 meurt pendant la coupure
  await startServer();
  st = await push();
  check('rattrapage apres redemarrage', st.sent, 23);
  check('disque complet', onDisk(), range(1, 23));

  console.log('\n--- archive videe : nouvelle epoque, pas de trou ---');
  const oldEpoch = st.epoch;
  await new Promise((r) => clearFtArchive(r));
  archiveFt([row(24), row(25)]);
  st = await push();
  check('nouvelle epoque', st.epoch !== oldEpoch, true);
  check('les anciennes lignes restent sur disque', onDisk(), range(1, 25));

  console.log('\n--- flushs concurrents : aucun bloc ecrase ---');
  restart();
  await new Promise((r) => clearFtArchive(r));
  archiveFt(range(1, 5).map((_, i) => row(100 + i)));
  const p1 = flush();
  archiveFt(range(1, 5).map((_, i) => row(200 + i)));
  const p2 = flush();
  await Promise.all([p1, p2]);
  check('10 lignes dans l index', store.csg_ft_arch.rows, 10);
  check('bloc 0 plein', store.csg_ftc_0.length, 8);
  check('bloc 1 = la suite', store.csg_ftc_1.map((r) => r.id), ['r203', 'r204']);

  await stopServer();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? '\n' + fails + ' ECHEC(S)\n' : '\ntout est vert\n');
  process.exit(fails ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try {
    await stopServer();
  } catch (_) {}
  process.exit(1);
});
