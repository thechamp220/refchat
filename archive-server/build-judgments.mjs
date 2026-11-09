#!/usr/bin/env node
'use strict';

// Reconstruit le registre des chats déjà jugés, au même format que
// sync-server/data/codex-judgments.jsonl. Une ligne n'entre que si le message
// et l'auteur sont encore là.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPersonJudgment, toJudgment } from './judgments.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const archiveDir = process.env.REFCHAT_ARCHIVE_DIR || path.join(os.homedir(), 'RefchatArchive');
const snapshotPath = path.join(here, '..', 'sync-server', 'data', 'snapshot.json');
const projectOut = path.join(here, '..', 'sync-server', 'data', 'refchat-judgments.jsonl');
const archiveOut = path.join(archiveDir, 'judgments.jsonl');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') rows.push(row);
    } catch (_) {}
  }
  return rows;
}

function archiveFiles() {
  if (!fs.existsSync(archiveDir)) return [];
  const files = [];
  for (const year of fs.readdirSync(archiveDir)) {
    const dir = path.join(archiveDir, year);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.jsonl')) files.push(path.join(dir, name));
    }
  }
  return files.sort();
}

const byId = new Map();
let conflicts = 0;
let skipped = 0;
for (const file of archiveFiles()) {
  for (const row of readJsonl(file)) {
    if (!isPersonJudgment(row)) {
      skipped += 1;
      continue;
    }
    const rec = toJudgment(row);
    const prev = byId.get(rec.key);
    if (!prev) {
      byId.set(rec.key, rec);
      continue;
    }
    if (prev.verdict !== rec.verdict) conflicts += 1;
    if (prev.verdict !== 'mute' && rec.verdict === 'mute') byId.set(rec.key, rec);
  }
}

if (fs.existsSync(snapshotPath)) {
  const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  for (const row of Array.isArray(snap.ftLog) ? snap.ftLog : []) {
    if (!isPersonJudgment(row)) continue;
    const rec = toJudgment(row);
    if (!byId.has(rec.key)) byId.set(rec.key, rec);
  }
}

const records = Array.from(byId.values()).sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
fs.mkdirSync(path.dirname(projectOut), { recursive: true });
fs.mkdirSync(path.dirname(archiveOut), { recursive: true });
fs.writeFileSync(projectOut, body, 'utf8');
fs.writeFileSync(archiveOut, body, 'utf8');

const tally = { mute: 0, keep: 0 };
for (const rec of records) tally[rec.verdict] += 1;
process.stdout.write(JSON.stringify({
  written: records.length,
  mute: tally.mute,
  keep: tally.keep,
  skipped,
  conflicts,
  projectOut,
  archiveOut
}) + '\n');
