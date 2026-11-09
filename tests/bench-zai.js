'use strict';

// Bench live Z.ai Flash vs le juge Refchat. Pas un check-* : appelle l API.
//   node tests/bench-zai.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const seed = String(process.env.ZAI_API_KEY || '').trim();
if (!seed) {
  console.error('ZAI_API_KEY manquante');
  process.exit(1);
}

const i = src.indexOf('const JUDGE_SYS');
const j = src.indexOf('const AUDIT =');
if (i < 0 || j < 0) throw new Error('prompts introuvables');
const ctx = { NL: '\n' };
vm.runInNewContext(src.slice(i, j) + '\nthis.JUDGE_SYS = JUDGE_SYS; this.JUDGE_SHOTS = JUDGE_SHOTS;', ctx);
const SYS = ctx.JUDGE_SYS;
const SHOTS = ctx.JUDGE_SHOTS;

const CASES = [
  // mute nets
  ['MUTE', 'ntm fdp', 'insulte'],
  ['MUTE', 'sale encule va', 'insulte'],
  ['MUTE', 'zywoo washed c est un bot', 'vitality'],
  ['MUTE', 'comment il a vu ca lui', 'triche'],
  ['MUTE', 'retourne a la cuisine', 'misogynie'],
  ['MUTE', 'sale arabe', 'racisme'],
  ['MUTE', 'va te pendre', 'suicide'],
  ['MUTE', 'elle stream pour les dons', 'misogynie'],
  ['MUTE', '67', '67'],
  ['MUTE', 'donk L', 'pile-on'],
  ['MUTE', 'il cheat cest evident', 'triche'],
  ['MUTE', 'gros pd', 'insulte'],
  ['MUTE', 'apex fini il touche plus rien', 'vitality'],
  ['MUTE', 'bravo pour ce whiff de legende', 'sarcasme'],
  ['MUTE', 'on sait tous pourquoi elle a autant de viewers', 'misogynie'],
  ['MUTE', 'quel bot ce joueur', 'trashtalk'],
  // keep nets
  ['KEEP', 'gg wp', 'clean'],
  ['KEEP', 'rotate B', 'strat'],
  ['KEEP', 'zywoo trop fort', 'praise'],
  ['KEEP', 'on est 6-7', 'score'],
  ['KEEP', 'mb jai throw', 'excuse'],
  ['KEEP', 'il cheat pas il est juste fort', 'defense'],
  ['KEEP', 'mongolz trop fort', 'team'],
  ['KEEP', 'ptn de clavier', 'interjection'],
  ['KEEP', 'ns site', 'call'],
  ['KEEP', 'mute le sur le jeu', 'ingame'],
  ['KEEP', 'je suis trauma des francais dans mes games', 'region'],
  ['KEEP', 'csfloat 12 euros le skin', 'market'],
  ['KEEP', 'nice 1v3', 'praise'],
  ['KEEP', 'eco next round', 'strat'],
  ['KEEP', 'wsh le round', 'interjection'],
  ['KEEP', 'ELRATTTTTT', 'cheer']
];

function parseVerdicts(raw, n) {
  const t = String(raw || '')
    .replace(/```json|```/g, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    const v = obj && obj.v;
    if (!Array.isArray(v) || v.length !== n) return null;
    return v.map((x) => !!x);
  } catch (_) {
    return null;
  }
}

function userPrompt(batch) {
  const lines = batch
    .map((c, i) => i + 1 + '. [@viewer] ' + c[1])
    .join('\n');
  return SHOTS + '\n' + batch.length + ' lines:\n' + lines + '\n{"v":[' + batch.length + ' bools],"p":[' + batch.length + ' bools]}';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callModel(model, batch) {
  let last = { ok: false, ms: 0, err: 'no try' };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(8000 * attempt);
    const t0 = Date.now();
    const res = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + seed,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en'
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        do_sample: false,
        max_tokens: 220,
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: SYS },
          { role: 'user', content: userPrompt(batch) }
        ]
      })
    });
    const ms = Date.now() - t0;
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) {
      last = { ok: false, ms, err: '429 ' + JSON.stringify(data).slice(0, 160) };
      continue;
    }
    if (!res.ok) {
      return { ok: false, ms, err: res.status + ' ' + JSON.stringify(data).slice(0, 180) };
    }
    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    const raw = String(msg.content || '');
    const think = String(msg.reasoning_content || '');
    const v = parseVerdicts(raw, batch.length);
    return {
      ok: !!v,
      ms,
      raw: raw.slice(0, 280),
      think: think.length,
      finish: data.choices && data.choices[0] && data.choices[0].finish_reason,
      v
    };
  }
  return last;
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

(async () => {
  const models = ['glm-4.7-flash', 'glm-4.5-flash'];
  const batches = chunks(CASES, 12);
  console.log('corpus', CASES.length, 'lignes,', batches.length, 'lots de 12 (taille live GLM)\n');

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    if (mi) await sleep(12000);
    const rows = [];
    let thinkTok = 0;
    let msSum = 0;
    console.log('===', model, '===');
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      if (b) await sleep(4000);
      const r = await callModel(model, batch);
      msSum += r.ms;
      thinkTok += r.think;
      if (!r.ok) {
        console.log('  LOT', b + 1, 'ILLISIBLE', r.ms + 'ms', r.err || r.raw);
        for (const c of batch) rows.push({ want: c[0], got: null, text: c[1], cat: c[2] });
        continue;
      }
      console.log('  lot', b + 1, r.ms + 'ms', 'finish=' + r.finish, 'think_chars=' + r.think);
      for (let i = 0; i < batch.length; i++) {
        rows.push({ want: batch[i][0], got: r.v[i] ? 'MUTE' : 'KEEP', text: batch[i][1], cat: batch[i][2] });
      }
    }

    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    let unread = 0;
    for (const r of rows) {
      if (!r.got) {
        unread++;
        continue;
      }
      if (r.want === 'MUTE' && r.got === 'MUTE') tp++;
      else if (r.want === 'KEEP' && r.got === 'KEEP') tn++;
      else if (r.want === 'KEEP' && r.got === 'MUTE') fp++;
      else fn++;
    }
    const muteN = rows.filter((r) => r.want === 'MUTE').length;
    const keepN = rows.filter((r) => r.want === 'KEEP').length;
    const rec = muteN ? tp / muteN : 0;
    const prec = tp + fp ? tp / (tp + fp) : 0;
    console.log(
      '  catch MUTE',
      tp + '/' + muteN,
      '(' + Math.round(rec * 100) + '%)  faux positifs',
      fp + '/' + keepN,
      '  precision',
      Math.round(prec * 100) + '%  latence moy',
      Math.round(msSum / batches.length) + 'ms  think',
      thinkTok ? 'OUI ' + thinkTok + 'c' : 'off'
    );
    for (const r of rows) {
      if (!r.got) console.log('  ?  [' + r.cat + ']', JSON.stringify(r.text));
      else if (r.want !== r.got) console.log('  ' + r.want + '→' + r.got, '[' + r.cat + ']', JSON.stringify(r.text));
    }
    console.log('');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
