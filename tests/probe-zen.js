'use strict';

// Sonde d'un candidat OpenCode Zen gratuit AVANT de l'ajouter a la chaine :
// vrai background.js (banc vm), vrai corps de requete (tryLane), vrai reseau.
// Pas un test : il ne commence pas par « check- », la suite ne le lance pas.
//
//   node tests/probe-zen.js <id> [refId|-] [essais] [lot] [timeoutMs]
//   node tests/probe-zen.js deepseek-v4-flash-free ling-3.0-flash-fin-free 6 12 60000
//
// Un id absent de CHAIN est sonde avec les reglages de Ling (Zen, chat).
// Critere d'entree : lots lisibles ET dans le timeout de la lane, verdicts
// justes sur les lignes sans ambiguite du corpus.
//
// Quota gratuit Zen (2026-09-15) : 429 FreeUsageLimitError, retry-after ~12 h,
// commun a TOUTES les lanes gratuites de la cle. La sonde s'arrete au premier
// 429 long et affiche l'heure de retour au lieu d'insister.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { bench } = require('./bench');

const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'), 'utf8'));
const goKey = auth['opencode-go'] && auth['opencode-go'].key;
if (!goKey) throw new Error('pas de cle opencode-go');
const E = { goKey, googleKey: '' };

const ID = process.argv[2] || 'deepseek-v4-flash-free';
const REF = process.argv[3] || 'ling-3.0-flash-fin-free';
const TRIES = Number(process.argv[4] || 6);
const BATCH = Number(process.argv[5] || 12);
const MS = Number(process.argv[6] || 60000);

// true = a couper sans discussion, false = propre sans discussion, null = pas note.
const CORPUS = [
  ['ta mère la pute', true], ['gg le clutch', false], ['vous êtes des chiens', true], ['on a gagné !!!', false],
  ['ferme ta gueule sale merde', true], ['quelqu un sait quand est le prochain match ?', false], ['nique ta race', true],
  ['bien joué la team', false], ['retourne sur roblox sale noob', true], ['eco next round', false], ['gg wp', false],
  ['suicide toi fdp', true], ['lol', false], ['le smoke mid était parfait', false], ['bonne nuit le chat', false],
  ['il est nul ce joueur', null], ['report ce mec il spam', null], ['kick ce streamer', null], ['ez', null],
  ['t es qu un sale bougnoule', true], ['incroyable ce retake', false], ['ptdr le whiff', false], ['va crever', true], ['merci pour le stream', false]
];

const b = bench({ csg_engine: { goKey } });
const calls = [];
b.run('globalThis').fetch = async (url, init) => {
  let req = {};
  try {
    req = JSON.parse((init && init.body) || '{}');
  } catch (_) {}
  const t0 = Date.now();
  const res = await fetch(url, init);
  const txt = await res.clone().text();
  const rec = { status: res.status, ms: Date.now() - t0, effort: req.reasoning_effort, retry: Number(res.headers.get('retry-after')) || 0 };
  try {
    const j = JSON.parse(txt);
    const ch = j.choices && j.choices[0];
    rec.finish = ch ? ch.finish_reason : j.status;
    const u = j.usage || {};
    rec.out = u.completion_tokens || u.output_tokens;
    rec.reason = (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || (u.output_tokens_details && u.output_tokens_details.reasoning_tokens) || 0;
  } catch (_) {}
  if (!res.ok) rec.err = txt.replace(/\s+/g, ' ').slice(0, 180);
  calls.push(rec);
  return res;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function specOf(id) {
  const chain = b.run('CHAIN');
  const found = chain.find((l) => l.id === id);
  if (found) return b.run('liveLane')(found);
  return Object.assign({}, chain.find((l) => l.id === 'ling-3.0-flash-fin-free'), { id, label: id });
}

// false = quota gratuit epuise : inutile de continuer.
async function run(id, tries) {
  const spec = specOf(id);
  const rows = [];
  for (let i = 0; i < tries; i++) {
    const start = (i * 7) % CORPUS.length;
    const pick = Array.from({ length: BATCH }, (_, k) => CORPUS[(start + k) % CORPUS.length]);
    const now = Date.now();
    const items = pick.map(([t], k) => ({ a: 'viewer' + k, t, id: id + '-' + i + '-' + k, ts: now, channel: 'sim' }));
    const n0 = calls.length;
    const t0 = Date.now();
    let line;
    try {
      const results = await b.run('tryLane')(E, spec, items, MS);
      const unread = results.length > 0 && results.every((r) => r && r.tag === 'skip');
      let good = 0;
      let bad = 0;
      const marks = results
        .map((r, k) => {
          if (!r || r.tag === 'skip') return '?';
          const m = r.score >= 0.5;
          const want = pick[k][1];
          if (want !== null) m === want ? good++ : bad++;
          return m ? 'M' : '.';
        })
        .join('');
      line = (unread ? 'ILLISIBLE' : 'ok') + ' ' + (Date.now() - t0) + ' ms · ' + marks + ' · justes ' + good + '/' + (good + bad);
      rows.push({ ok: !unread, ms: Date.now() - t0, good, bad });
    } catch (e) {
      line = 'ERREUR ' + (Date.now() - t0) + ' ms · ' + String((e && e.message) || e).slice(0, 160);
      rows.push({ ok: false, ms: Date.now() - t0, good: 0, bad: 0 });
    }
    const mine = calls.slice(n0);
    console.log('  ' + id + ' #' + (i + 1) + ' ' + line);
    console.log('      ' + mine.map((c) => c.status + ' ' + c.ms + 'ms fin=' + c.finish + ' out=' + c.out + ' raisonnement=' + c.reason + ' effort=' + c.effort + (c.err ? ' ' + c.err : '')).join(' | '));
    const long = mine.find((c) => c.status === 429 && c.retry >= 900);
    if (long) {
      console.log('\nquota gratuit Zen epuise : retour vers ' + new Date(Date.now() + long.retry * 1000).toLocaleString('fr-FR') + ' (retry-after ' + long.retry + ' s)');
      return false;
    }
    await sleep(1500);
  }
  const oks = rows.filter((r) => r.ok);
  const ms = oks.map((r) => r.ms).sort((x, y) => x - y);
  const good = rows.reduce((s, r) => s + r.good, 0);
  const bad = rows.reduce((s, r) => s + r.bad, 0);
  console.log('= ' + id + ' : ' + oks.length + '/' + rows.length + ' lisibles · latence ' + (ms.length ? 'min ' + ms[0] + ' / med ' + ms[Math.floor(ms.length / 2)] + ' / max ' + ms[ms.length - 1] + ' ms' : 'n/a') + ' · verdicts justes ' + good + '/' + (good + bad) + '\n');
  return true;
}

(async () => {
  console.log('lot ' + BATCH + ' · timeout sonde ' + MS + ' ms');
  if ((await run(ID, TRIES)) && REF && REF !== '-') await run(REF, Math.min(3, TRIES));
  process.exit(0);
})().catch((e) => {
  console.error('sonde KO', e && e.message);
  process.exit(1);
});
