#!/usr/bin/env node
'use strict';

// Mini-serveur de snapshot ChatGate.
//   CSG_TOKEN=... node server.mjs
// Écoute 127.0.0.1:8787 (CSG_PORT) par defaut : le serveur ne sort pas de la
// machine tout seul. Derrière nginx (meme hote) ou en conteneur, loopback
// suffit ; pour une exposition reseau voulue, CSG_BIND=0.0.0.0.
// PUT/GET /snapshot, GET /health.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CSG_PORT) || 8787;
const BIND = process.env.CSG_BIND || '127.0.0.1';
const TOKEN = String(process.env.CSG_TOKEN || '').trim();
const FILE = process.env.CSG_FILE || path.join(__dirname, 'data', 'snapshot.json');
const BAK = FILE + '.bak';
const MAX = 8 * 1024 * 1024;

if (!TOKEN || TOKEN.length < 16) {
  console.error('CSG_TOKEN manquant ou trop court (16+ caractères).');
  process.exit(1);
}

fs.mkdirSync(path.dirname(FILE), { recursive: true });

// Une coupure en plein rename peut laisser le snapshot absent : la sauvegarde
// de la version precedente permet de repartir sans repartir de zero.
try {
  if (!fs.existsSync(FILE) && fs.existsSync(BAK)) {
    fs.copyFileSync(BAK, FILE);
    console.error('snapshot restauré depuis ' + BAK);
  }
} catch (_) {}

function tokenOk(req) {
  const h = String(req.headers.authorization || '');
  const bearer = h.replace(/^Bearer\s+/i, '').trim();
  const alt = String(req.headers['x-csg-token'] || '').trim();
  const got = bearer || alt;
  if (!got || got.length !== TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(TOKEN));
  } catch (_) {
    return false;
  }
}

function send(res, code, body, type, extraHeaders) {
  const buf = Buffer.from(body == null ? '' : body);
  res.writeHead(
    code,
    Object.assign(
      {
        'Content-Type': type || 'text/plain; charset=utf-8',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store'
      },
      extraHeaders || {}
    )
  );
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > MAX) {
        done = true;
        chunks.length = 0;
        const e = new Error('too large');
        e.code = 413;
        reject(e);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

async function fsyncDir(dir) {
  try {
    const dh = await fs.promises.open(dir, 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch (_) {}
}

// Windows refuse (EPERM/EBUSY) de remplacer un fichier qu'un autre processus ou
// une autre requete tient ouvert. Sous PUT concurrents, rename/copy echouaient
// sans ce court reessai.
async function retryFs(fn, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!e || (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY')) throw e;
      await new Promise((r) => setTimeout(r, 20 * (i + 1)));
    }
  }
  throw last;
}

// Ecriture atomique et durable : fichier temporaire UNIQUE (deux PUT simultanes
// se corrompaient avec un nom partage), fsync avant rename, sauvegarde de la
// version precedente, puis fsync du dossier pour que le rename survive a une
// coupure.
async function atomicWrite(buf) {
  const tmp = FILE + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  let fh = null;
  try {
    fh = await fs.promises.open(tmp, 'w');
    await fh.writeFile(buf);
    await fh.sync();
    await fh.close();
    fh = null;
    // Sauvegarde de la version precedente AVANT ecrasement, via un tmp unique
    // puis rename : deux ecritures concurrentes ne peuvent pas se melanger
    // dans .bak. Best-effort : son echec ne bloque pas l'ecriture principale.
    try {
      const btmp = BAK + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      try {
        await retryFs(async () => {
          await fs.promises.copyFile(FILE, btmp);
          await fs.promises.rename(btmp, BAK);
        });
      } catch (_) {
        try {
          await fs.promises.unlink(btmp);
        } catch (_) {}
      }
    } catch (_) {}
    await retryFs(() => fs.promises.rename(tmp, FILE));
    await fsyncDir(path.dirname(FILE));
  } catch (e) {
    if (fh) {
      try {
        await fh.close();
      } catch (_) {}
    }
    try {
      await fs.promises.unlink(tmp);
    } catch (_) {}
    throw e;
  }
}

function snapshotValid(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 1) return false;
  return (
    value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings) &&
    value.engine && typeof value.engine === 'object' && !Array.isArray(value.engine) &&
    value.muted && typeof value.muted === 'object' && !Array.isArray(value.muted) &&
    Array.isArray(value.learned) &&
    Array.isArray(value.ftLog)
  );
}

function etag(buf) {
  return '"' + crypto.createHash('sha256').update(buf).digest('base64url') + '"';
}

let writeChain = Promise.resolve();

async function storeSnapshot(buf, expected, createOnly) {
  let current = null;
  try {
    current = await fs.promises.readFile(FILE);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  if (expected && (!current || etag(current) !== expected)) {
    throw Object.assign(new Error('snapshot modifié, refaire la fusion'), { code: 412 });
  }
  if (createOnly && current) {
    throw Object.assign(new Error('snapshot déjà créé, refaire la fusion'), { code: 412 });
  }
  await atomicWrite(buf);
  return etag(buf);
}

const server = http.createServer(async (req, res) => {
  const url = String(req.url || '').split('?')[0];
  if (req.method === 'GET' && url === '/health') {
    send(res, 200, 'ok\n');
    return;
  }
  if (req.method === 'GET' && (url === '/codex/status' || url === '/codex/decisions') && process.env.CSG_CODEX_BRIDGE === '1') {
    if (!tokenOk(req)) {
      send(res, 401, 'unauthorized\n');
      return;
    }
    try {
      const { getCodexProgress, getCodexDecisions } = await import('./codex-feed.mjs');
      const cursor = new URL(req.url, 'http://localhost').searchParams.get('cursor');
      const body = url === '/codex/status' ? getCodexProgress() : getCodexDecisions(cursor);
      send(res, 200, JSON.stringify(body) + '\n', 'application/json');
    } catch (e) {
      send(res, 500, String((e && e.message) || e).slice(0, 80) + '\n');
    }
    return;
  }
  if (url !== '/snapshot') {
    send(res, 404, 'not found\n');
    return;
  }
  if (!tokenOk(req)) {
    send(res, 401, 'unauthorized\n');
    return;
  }
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      let buf;
      try {
        buf = await fs.promises.readFile(FILE);
      } catch (e) {
        if (e && e.code === 'ENOENT') {
          send(res, 404, 'empty\n');
          return;
        }
        throw e;
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': buf.length, ETag: etag(buf), 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      send(res, 200, buf, 'application/json', { ETag: etag(buf) });
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const buf = await readBody(req);
      // Un corps valide mais errone ne doit pas detruire l'unique copie : le
      // JSON est valide avant tout, et la version precedente gardee en .bak.
      const snap = JSON.parse(buf.toString('utf8'));
      if (!snapshotValid(snap)) {
        send(res, 422, 'invalid snapshot\n');
        return;
      }
      const expected = String(req.headers['if-match'] || '').trim();
      const createOnly = String(req.headers['if-none-match'] || '').trim() === '*';
      const tag = await (writeChain = writeChain.then(
        () => storeSnapshot(buf, expected, createOnly),
        () => storeSnapshot(buf, expected, createOnly)
      ));
      send(res, 200, '{"ok":true}\n', 'application/json', { ETag: tag });
      return;
    }
    send(res, 405, 'method\n');
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (e && e.code === 413) {
      send(res, 413, 'too large\n');
      // On draine le reste de la requete pour ne pas bloquer la socket.
      try {
        req.resume();
      } catch (_) {}
      return;
    }
    send(res, e && e.code === 412 ? 412 : 400, msg.slice(0, 80) + '\n');
  }
});

server.requestTimeout = 30000;
server.headersTimeout = 20000;
server.keepAliveTimeout = 5000;

server.listen(PORT, BIND, () => {
  console.log('csg-sync ' + BIND + ':' + PORT + ' -> ' + FILE);
});

function shutdown(sig) {
  console.log('csg-sync ' + sig + ' : arrêt');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
