'use strict';

import crypto from 'node:crypto';

// Même forme que sync-server/data/codex-judgments.jsonl : un message, un verdict.
// La raison reprend la source réelle du journal. Elle n'invente pas de motif.
const REASONS = {
  llm: 'Jugé par le modèle.',
  llm_skip: 'Jugé par le modèle, passe rapide.',
  live: 'Jugé en direct.',
  keyword: 'Liste locale.',
  harsh: 'Liste locale, insulte dure.',
  extra: 'Mot personnel.',
  appris: 'Terme appris.',
  recoolle: 'Message recollé.',
  copypasta: 'Copypasta.',
  muted: 'Auteur déjà muet.',
  politique: 'Filtre politique.',
  trivial: 'Message anodin, gardé sans appel au modèle.',
  clean: 'Message classé propre, gardé sans appel au modèle.',
  doublon: 'Même verdict qu’un message déjà jugé.',
  one_click: 'Analyse au clic.'
};

export function rowKey(row) {
  const id = String((row && row.id) || '').trim();
  if (id) return 'id:' + id;
  const stable = [
    Number(row && row.ts) || 0,
    String((row && row.author) || ''),
    String((row && row.text) || '').slice(0, 40)
  ].join('|');
  return 'f:' + crypto.createHash('sha256').update(stable).digest('hex');
}

export function isPersonJudgment(row) {
  if (!row || typeof row !== 'object') return false;
  const verdict = String(row.label || row.verdict || '').toLowerCase();
  if (verdict !== 'mute' && verdict !== 'keep') return false;
  const author = String(row.author || '').trim();
  const text = String(row.text || '').trim();
  return !!text && !!author && author !== '?';
}

export function toJudgment(row) {
  const verdict = String(row.label || row.verdict || '').toLowerCase();
  const source = String(row.source || '').slice(0, 40);
  const score = Number(row.score);
  const model = String(row.model || '').slice(0, 80);
  return {
    key: rowKey(row),
    id: String(row.id || ''),
    ts: Number(row.ts) || 0,
    author: String(row.author || '').trim().slice(0, 100),
    text: String(row.text || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
    channel: String(row.channel || '').slice(0, 160),
    verdict,
    reason: REASONS[source] || (source ? 'Jugé par Refchat (' + source + ').' : 'Jugé par Refchat.'),
    source,
    score: Number.isFinite(score) ? score : null,
    model
  };
}
