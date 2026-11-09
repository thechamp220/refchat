#!/usr/bin/env node
'use strict';

// Archive disque à vie des messages Refchat.
//   node archive-server/server.mjs
// Écoute 127.0.0.1:8788 (REFCHAT_ARCHIVE_PORT) et écrit dans
// %USERPROFILE%\RefchatArchive (REFCHAT_ARCHIVE_DIR) : un fichier JSONL par
// jour, rangé par année (2026/2026-09-14.jsonl). Rien n'est jamais réécrit ni
// supprimé, les fichiers se lisent tels quels par un LLM ou `jq`.
//
// Protocole : POST /rows {epoch, from, rows}. `from` est la position de la
// première ligne dans l'archive de l'extension ; le serveur retient la suite
// attendue par époque, ignore ce qu'il a déjà et refuse un trou (409 + next).
// Une époque neuve = archive de l'extension repartie de zéro (réinstallation).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPersonJudgment, toJudgment } from './judgments.mjs';

const PORT = Number(process.env.REFCHAT_ARCHIVE_PORT) || 8788;
const DIR = process.env.REFCHAT_ARCHIVE_DIR || path.join(os.homedir(), 'RefchatArchive');
const STATE = path.join(DIR, 'state.json');
const JUDGMENTS = path.join(DIR, 'judgments.jsonl');
const MAX = 64 * 1024 * 1024;

fs.mkdirSync(DIR, { recursive: true });

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return { epochs: (s && s.epochs) || {}, rows: Number(s && s.rows) || 0 };
  } catch (_) {
    return { epochs: {}, rows: 0 };
  }
}

let state = loadState();
const judgmentIds = new Set();
if (fs.existsSync(JUDGMENTS)) {
  for (const line of fs.readFileSync(JUDGMENTS, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item && item.id) judgmentIds.add(String(item.id));
    } catch (_) {}
  }
}

async function saveState() {
  const tmp = STATE + '.' + process.pid + '.tmp';
  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.promises.rename(tmp, STATE);
}

function dayFile(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const y = String(d.getFullYear());
  return path.join(DIR, y, y + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '.jsonl');
}

// Ajout puis fsync, fichier par fichier. Un crash entre l'ajout et saveState
// peut dupliquer un lot au renvoi : chaque ligne porte son `id` pour dédoublonner.
async function appendJudgments(rows) {
  const lines = [];
  // Les ids ne sont retenus qu'après l'écriture : une écriture échouée puis
  // renvoyée ne doit pas sauter ces jugements comme « déjà écrits ».
  const batch = new Set();
  for (const row of rows) {
    if (!isPersonJudgment(row)) continue;
    const id = String(row.id || '').trim();
    if (!id || judgmentIds.has(id) || batch.has(id)) continue;
    batch.add(id);
    lines.push(JSON.stringify(toJudgment(row)));
  }
  if (!lines.length) return;
  const fh = await fs.promises.open(JUDGMENTS, 'a');
  try {
    await fh.writeFile(lines.join('\n') + '\n');
    await fh.sync();
  } finally {
    await fh.close();
  }
  for (const id of batch) judgmentIds.add(id);
}

async function appendRows(rows) {
  const byFile = new Map();
  for (const r of rows) {
    const f = dayFile(r && r.ts);
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(JSON.stringify(r));
  }
  for (const [f, lines] of byFile) {
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    const fh = await fs.promises.open(f, 'a');
    try {
      await fh.writeFile(lines.join('\n') + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX) {
        reject(Object.assign(new Error('too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

// ------------------------------------------------------------ file d'attente
// Copie de la file de l'extension (POST /queue toutes les 3-10 s quand elle
// bouge). GET /queue l'affiche, GET /queue.json la donne brute. Le fichier
// queue.json se relit au démarrage : la dernière file connue reste visible.
const QUEUE_FILE = path.join(DIR, 'queue.json');
let queueSnap = { at: 0, received: 0, rows: [] };
try {
  const q = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  if (q && Array.isArray(q.rows)) queueSnap = q;
} catch (_) {}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function sendQueuePage(res) {
  const { rows, received } = queueSnap;
  const ago = received ? Math.round((Date.now() - received) / 1000) : null;
  const fresh = ago !== null && ago < 360;
  const when = received ? new Date(received).toLocaleTimeString('fr-FR') : 'jamais';
  const age = (ts) => {
    const s = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 1000));
    return s < 60 ? s + ' s' : s < 3600 ? Math.floor(s / 60) + ' min' : Math.floor(s / 3600) + ' h';
  };
  const body = rows
    .map((r, i) =>
      '<tr' + (r.state === 'judging' ? ' class="j"' : '') + '><td class="d">' + (i + 1) + '</td><td class="d">' + age(r.ts) +
      '</td><td class="d">' + escHtml(r.channel || '') + '</td><td class="w">' + escHtml(r.a || '?') + '</td><td>' + escHtml(r.t || '') +
      (r.state === 'judging' ? ' <i>en cours</i>' : '') + '</td></tr>')
    .join('');
  const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="refresh" content="3"><title>Refchat — File d\'attente</title><style>' +
    ':root{color-scheme:dark}body{margin:0;background:#0b0c0e;color:#eceef1;font:14px/1.45 "Segoe UI",system-ui,sans-serif}' +
    'main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}.m{color:#7d848e;font-size:12.5px;margin-bottom:16px}' +
    '.n{color:#f2b441}.old{color:#ff5c72}table{width:100%;border-collapse:collapse;background:#121418;border-radius:12px;overflow:hidden}' +
    'th,td{text-align:left;padding:7px 10px;border-bottom:1px solid rgba(255,255,255,.045);vertical-align:top}th{color:#7d848e;font-size:12px;background:#181b20}' +
    'td.d{color:#7d848e;white-space:nowrap}td.w{font-weight:600;white-space:nowrap}tr.j td{background:rgba(242,180,65,.08)}i{color:#f2b441;font-style:normal;font-size:11px}' +
    '.e{padding:40px 0;text-align:center;color:#7d848e}</style></head><body><main>' +
    '<h1>File d\'attente <span class="n">' + rows.length + '</span></h1>' +
    '<div class="m' + (fresh ? '' : ' old') + '">Reçue de l\'extension à ' + when +
    (fresh ? '' : ' — copie ancienne : Brave est fermé ou la file n\'a pas bougé depuis') + ' · se recharge toute seule</div>' +
    (rows.length
      ? '<table><thead><tr><th>#</th><th>Âge</th><th>Chaîne</th><th>Auteur</th><th>Message</th></tr></thead><tbody>' + body + '</tbody></table>'
      : '<p class="e">Aucun message en attente.</p>') +
    '</main></body></html>';
  const buf = Buffer.from(html);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

// Les lots passent un par un : deux POST concurrents entrelaceraient leurs lignes.
let chain = Promise.resolve();

async function handleRows(body) {
  const epoch = String(body && body.epoch || '');
  const from = Number(body && body.from);
  const rows = Array.isArray(body && body.rows) ? body.rows : null;
  if (!epoch || !Number.isInteger(from) || from < 0 || !rows) return [400, { err: 'epoch, from, rows attendus' }];
  const next = Number(state.epochs[epoch]) || 0;
  if (from > next) return [409, { next }];
  const fresh = rows.slice(next - from);
  if (fresh.length) {
    await appendRows(fresh);
    await appendJudgments(fresh);
    state.epochs[epoch] = next + fresh.length;
    state.rows += fresh.length;
    await saveState();
  }
  return [200, { next: Number(state.epochs[epoch]) || 0, total: state.rows }];
}

const server = http.createServer(async (req, res) => {
  const url = String(req.url || '').split('?')[0];
  // Une page web peut viser localhost : seule l'extension (permission d'hôte,
  // donc pas de CORS) envoie l'en-tête maison sans préflight refusé.
  const origin = String(req.headers.origin || '');
  if (origin && !origin.startsWith('chrome-extension://')) return send(res, 403, { err: 'origine refusée' });
  if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true, total: state.rows });
  if (req.method === 'GET' && url === '/queue.json') return send(res, 200, queueSnap);
  if (req.method === 'GET' && url === '/diag.json') return send(res, 200, { at: queueSnap.at, received: queueSnap.received, pending: queueSnap.rows.length, diag: queueSnap.diag || null });
  if (req.method === 'GET' && url === '/queue') return sendQueuePage(res);
  // Verdicts manuels écrits à la main dans verdicts.json, appliqués par l'extension.
  if (req.method === 'GET' && url === '/verdicts') {
    try {
      const v = JSON.parse(await fs.promises.readFile(path.join(DIR, 'verdicts.json'), 'utf8'));
      return send(res, 200, { verdicts: Array.isArray(v && v.verdicts) ? v.verdicts : [] });
    } catch (_) {
      return send(res, 200, { verdicts: [] });
    }
  }
  if (req.method === 'POST' && url === '/queue') {
    if (req.headers['x-refchat'] !== '1') return send(res, 403, { err: 'en-tête x-refchat manquant' });
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const rows = Array.isArray(body && body.rows) ? body.rows : null;
      if (!rows) return send(res, 400, { err: 'rows attendu' });
      // diag : dernières erreurs des modèles, lisibles via GET /diag.json
      // (le stockage de Brave ne se lit pas de l'extérieur). Jamais de clé dedans.
      const diag = body && body.diag && typeof body.diag === 'object' ? body.diag : null;
      queueSnap = { at: Number(body.at) || Date.now(), received: Date.now(), rows, diag };
      // Une ligne par envoi : qui envoie (id d'extension) et avec quelle version.
      console.log(new Date().toLocaleTimeString('fr-FR') + ' POST /queue ' + String(req.headers.origin || '-') + ' ua=' + String(req.headers['user-agent'] || '-').slice(-60) + ' lignes=' + rows.length + ' diag=' + (diag ? 'v' + String(diag.v || '?') : 'non'));
      const tmp = QUEUE_FILE + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(queueSnap));
      await fs.promises.rename(tmp, QUEUE_FILE);
      return send(res, 200, { ok: true, n: rows.length });
    } catch (e) {
      return send(res, e && e.code === 413 ? 413 : 400, { err: String((e && e.message) || e).slice(0, 120) });
    }
  }
  if (req.method === 'POST' && url === '/review') {
    if (req.headers['x-refchat'] !== '1') return send(res, 403, { err: 'en-tête x-refchat manquant' });
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const f = path.join(DIR, 'pardon-review.json');
      const tmp = f + '.' + process.pid + '.' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(body));
      await fs.promises.rename(tmp, f);
      const n = Array.isArray(body && body.authors) ? body.authors.length : 0;
      return send(res, 200, { ok: true, n });
    } catch (e) {
      return send(res, e && e.code === 413 ? 413 : 400, { err: String((e && e.message) || e).slice(0, 120) });
    }
  }
  if (req.method !== 'POST' || url !== '/rows') return send(res, 404, { err: 'not found' });
  if (req.headers['x-refchat'] !== '1') return send(res, 403, { err: 'en-tête x-refchat manquant' });
  try {
    const body = JSON.parse((await readBody(req)).toString('utf8'));
    const [code, out] = await (chain = chain.then(() => handleRows(body), () => handleRows(body)));
    send(res, code, out);
  } catch (e) {
    send(res, e && e.code === 413 ? 413 : 400, { err: String((e && e.message) || e).slice(0, 120) });
  }
});

server.requestTimeout = 60000;
server.listen(PORT, '127.0.0.1', () => {
  console.log('refchat-archive 127.0.0.1:' + PORT + ' -> ' + DIR + ' (' + state.rows + ' lignes)');
});
