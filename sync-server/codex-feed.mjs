#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const snapshotPath = path.join(dataDir, 'snapshot.json');
const ledgerPath = path.join(dataDir, 'codex-judgments.jsonl');
const lockPath = path.join(dataDir, 'codex-judgments.lock');
const runPath = path.join(dataDir, 'codex-run.json');
const MAX_BATCH = 100;
const RUN_STALE_MS = 30 * 60 * 1000;

function rowKey(row) {
  const id = String((row && row.id) || '').trim();
  if (id) return 'id:' + id;
  const stable = [
    Number(row && row.ts) || 0,
    String((row && row.author) || ''),
    String((row && row.text) || '').slice(0, 40)
  ].join('|');
  return 'f:' + crypto.createHash('sha256').update(stable).digest('hex');
}

function readSnapshot() {
  if (!fs.existsSync(snapshotPath)) return null;
  const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  if (!snap || snap.v !== 1 || !Array.isArray(snap.ftLog)) {
    throw new Error('snapshot RefChat invalide');
  }
  return snap;
}

function readLedger() {
  const records = [];
  if (!fs.existsSync(ledgerPath)) return records;
  for (const line of fs.readFileSync(ledgerPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item && item.key) records.push(item);
    } catch (_) {}
  }
  return records;
}

function readRun() {
  try {
    return JSON.parse(fs.readFileSync(runPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeRun(run) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(runPath, JSON.stringify(run), 'utf8');
}

function personKey(row) {
  return String(row.channel || '') + '\n' + String(row.author || '').toLowerCase();
}

function isCandidate(row) {
  if (!row || !row.text) return false;
  if (typeof row.eligible === 'boolean') return row.eligible;
  return ['pending', 'dropped'].includes(String(row.label || 'pending').toLowerCase()) &&
    !!row.author && row.author !== '?';
}

export function getCodexDecisions(cursor) {
  const records = readLedger();
  const after = Math.max(0, Math.min(records.length, Math.floor(Number(cursor) || 0)));
  const page = records.slice(after, after + 200).map((item) => ({
    key: String(item.key || ''),
    id: String(item.id || ''),
    ts: Number(item.ts) || 0,
    author: String(item.author || '').slice(0, 100),
    text: String(item.text || '').slice(0, 40),
    channel: String(item.channel || '').slice(0, 160),
    verdict: String(item.verdict || ''),
    reason: String(item.reason || '').slice(0, 500),
    judgedAt: Number(item.judgedAt) || 0
  }));
  return { cursor: after + page.length, total: records.length, records: page };
}

export function getCodexProgress() {
  const snap = readSnapshot();
  if (!snap) return { ready: false, running: false, done: 0, total: 0, peopleDone: 0, peopleTotal: 0, results: [] };
  const all = new Map();
  const decided = new Map();
  for (const item of readLedger()) {
    const key = String(item.key);
    decided.set(key, item);
    all.set(key, item);
  }
  const waitingPeople = new Set();
  for (const row of snap.ftLog) {
    if (!isCandidate(row)) continue;
    const key = rowKey(row);
    all.set(key, row);
    if (!decided.has(key)) waitingPeople.add(personKey(row));
  }
  const people = new Set(Array.from(all.values(), personKey));
  const flagged = Array.from(decided.values())
    .filter((item) => item.verdict === 'mute')
    .sort((a, b) => (Number(a.judgedAt) || 0) - (Number(b.judgedAt) || 0));
  const run = readRun();
  const running = !!(run && run.active && Date.now() - Number(run.updatedAt || run.startedAt) < RUN_STALE_MS);
  return {
    ready: true,
    running,
    done: decided.size,
    total: all.size,
    peopleDone: people.size - waitingPeople.size,
    peopleTotal: people.size,
    flaggedPeople: new Set(flagged.map(personKey)).size,
    current: running ? String(run.current || 'analyse des messages') : '',
    startedAt: Number(run && run.startedAt) || 0,
    err: run && run.active && !running ? 'passage interrompu' : String((run && run.err) || ''),
    results: flagged.slice(-25).map((item) => ({
      a: String(item.author || '').slice(0, 100),
      channel: String(item.channel || '').slice(0, 160),
      text: String(item.text || '').slice(0, 160),
      why: String(item.reason || '').slice(0, 200),
      mute: true,
      applied: false
    }))
  };
}

function startRun() {
  const prior = readRun();
  if (prior && prior.active && Date.now() - Number(prior.updatedAt || prior.startedAt) < RUN_STALE_MS) {
    process.stdout.write(JSON.stringify({ started: false, busy: true }) + '\n');
    return;
  }
  const now = Date.now();
  const runId = crypto.randomUUID();
  writeRun({ runId, active: true, startedAt: now, updatedAt: now, current: 'premier lot', err: '' });
  process.stdout.write(JSON.stringify({ started: true, runId }) + '\n');
}

function finishRun(runId, failed) {
  const prior = readRun();
  if (!prior || !runId || prior.runId !== runId) throw new Error('passage Codex inconnu');
  const now = Date.now();
  writeRun(Object.assign({}, prior, {
    active: false,
    updatedAt: now,
    finishedAt: now,
    current: '',
    err: failed ? 'passage interrompu' : ''
  }));
  process.stdout.write(JSON.stringify({ finished: true }) + '\n');
}

function listPending() {
  const snap = readSnapshot();
  if (!snap) {
    process.stdout.write(JSON.stringify({ ready: false, rows: [] }) + '\n');
    return;
  }
  const seen = new Set(readLedger().map((item) => String(item.key)));
  const all = snap.ftLog
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      key: rowKey(row),
      id: String(row.id || ''),
      ts: Number(row.ts) || 0,
      author: String(row.author || '').slice(0, 100),
      text: String(row.text || '').slice(0, 2000),
      channel: String(row.channel || '').slice(0, 160),
      label: String(row.label || 'pending').toLowerCase(),
      eligible: row.eligible
    }))
    .sort((a, b) => a.ts - b.ts);
  const pending = all.filter((row) => isCandidate(row) && !seen.has(row.key));
  const rows = pending.slice(0, MAX_BATCH).map((row) => {
    const context = all
      .filter((prev) =>
        prev.key !== row.key &&
        prev.channel === row.channel &&
        prev.ts <= row.ts &&
        row.ts - prev.ts <= 120000
      )
      .slice(-12)
      .map(({ author, text, ts }) => ({ author, text, ts }));
    return Object.assign({}, row, { context });
  });
  process.stdout.write(JSON.stringify({ ready: true, rows, remaining: Math.max(0, pending.length - rows.length) }) + '\n');
}

async function acquireLock() {
  await fs.promises.mkdir(dataDir, { recursive: true });
  const deadline = Date.now() + 30000;
  while (true) {
    try {
      return await fs.promises.open(lockPath, 'wx');
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) throw new Error('un autre enregistrement Codex est en cours');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function recordDecisions(inputPath) {
  const resolvedInput = path.resolve(inputPath || '');
  if (!resolvedInput.startsWith(dataDir + path.sep) || !/^codex-decisions-[a-zA-Z0-9_-]+\.json$/.test(path.basename(resolvedInput))) {
    throw new Error('fichier de décisions temporaire invalide');
  }
  const decisions = JSON.parse(await fs.promises.readFile(resolvedInput, 'utf8'));
  if (!Array.isArray(decisions)) throw new Error('les décisions doivent être un tableau JSON');
  const snap = readSnapshot();
  if (!snap) throw new Error('snapshot RefChat absent');
  const current = new Map(
    snap.ftLog
      .filter(isCandidate)
      .map((row) => [rowKey(row), row])
  );
  const lock = await acquireLock();
  try {
    const seen = new Set(readLedger().map((item) => String(item.key)));
    const records = [];
    for (const decision of decisions) {
      const key = String((decision && decision.key) || '');
      const row = current.get(key);
      const verdict = String((decision && decision.verdict) || '').toLowerCase();
      if (!row || seen.has(key) || !['mute', 'keep'].includes(verdict)) continue;
      const reason = String(decision.reason || '').trim().slice(0, 500);
      records.push({
        key,
        id: String(row.id || ''),
        ts: Number(row.ts) || 0,
        author: String(row.author || '').slice(0, 100),
        text: String(row.text || '').slice(0, 2000),
        channel: String(row.channel || '').slice(0, 160),
        verdict,
        reason,
        judgedAt: Date.now()
      });
      seen.add(key);
    }
    if (records.length) {
      await fs.promises.appendFile(ledgerPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      const run = readRun();
      if (run && run.active) writeRun(Object.assign({}, run, {
        updatedAt: Date.now(),
        current: records.length + ' message' + (records.length > 1 ? 's' : '') + ' jugé' + (records.length > 1 ? 's' : '') + ' dans ce lot'
      }));
    }
    process.stdout.write(JSON.stringify({ recorded: records.length }) + '\n');
    await fs.promises.unlink(resolvedInput);
  } finally {
    await lock.close();
    try {
      await fs.promises.unlink(lockPath);
    } catch (_) {}
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = String(process.argv[2] || 'list').toLowerCase();
  if (action === 'record') {
    recordDecisions(process.argv[3]).catch((e) => {
      console.error(String((e && e.message) || e).slice(0, 200));
      process.exitCode = 1;
    });
  } else {
    try {
      if (action === 'list') listPending();
      else if (action === 'status') process.stdout.write(JSON.stringify(getCodexProgress()) + '\n');
      else if (action === 'start') startRun();
      else if (action === 'finish' || action === 'fail') finishRun(process.argv[3], action === 'fail');
      else throw new Error('usage: node codex-feed.mjs [list | status | start | finish <runId> | fail <runId> | record <file>]');
    } catch (e) {
      console.error(String((e && e.message) || e).slice(0, 200));
      process.exitCode = 1;
    }
  }
}
