'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const seed = String(process.env.ZAI_API_KEY || '').trim();
if (!seed) throw new Error('ZAI_API_KEY manquante');
const i = src.indexOf('const JUDGE_SYS');
const j = src.indexOf('const AUDIT =');
const box = { NL: '\n' };
vm.runInNewContext(src.slice(i, j) + '\nthis.JUDGE_SYS=JUDGE_SYS;this.JUDGE_SHOTS=JUDGE_SHOTS;', box);

const MUTE = [
  'ntm fdp',
  'sale arabe',
  'va te pendre',
  'retourne a la cuisine',
  'comment il a vu ca lui',
  '67',
  'donk L',
  'quel bot ce joueur',
  'zywoo washed c est un bot',
  'elle stream pour les dons',
  'bravo pour ce whiff de legende',
  'gg wp'
];

function prompt(n) {
  const lines = MUTE.slice(0, n)
    .map((t, k) => k + 1 + '. [@viewer] ' + t)
    .join('\n');
  return box.JUDGE_SHOTS + '\n' + n + ' lines:\n' + lines + '\n{"v":[' + n + ' bools],"p":[' + n + ' bools]}';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function call(model, n) {
  const t0 = Date.now();
  const res = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + seed, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      do_sample: false,
      max_tokens: 160,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: box.JUDGE_SYS },
        { role: 'user', content: prompt(n) }
      ]
    })
  });
  const ms = Date.now() - t0;
  const data = await res.json().catch(() => ({}));
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const ch = data.choices && data.choices[0];
  return {
    http: res.status,
    ms,
    err: data.error,
    finish: ch && ch.finish_reason,
    content: String(msg.content || ''),
    think: String(msg.reasoning_content || ''),
    usage: data.usage
  };
}

(async () => {
  for (const n of [4, 12]) {
    await sleep(5000);
    let r = await call('glm-4.7-flash', n);
    if (r.http === 429) {
      await sleep(12000);
      r = await call('glm-4.7-flash', n);
    }
    console.log('\n4.7-flash n=' + n, r.http, r.ms + 'ms', 'finish=' + r.finish);
    if (r.err) console.log('ERR', JSON.stringify(r.err).slice(0, 200));
    console.log('content', r.content.slice(0, 400));
    console.log('think_len', r.think.length, 'usage', JSON.stringify(r.usage));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
