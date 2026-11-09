'use strict';

const seed = String(process.env.ZAI_API_KEY || '').trim();
if (!seed) throw new Error('ZAI_API_KEY manquante');

const LINES = ['ntm fdp', 'sale arabe', 'va te pendre', 'gg wp'];
const user =
  'One boolean per line, true=MUTE false=keep. JSON only {"v":[4 bools],"p":[4 bools]}.\n' +
  LINES.map((t, i) => i + 1 + '. ' + t).join('\n') +
  '\n{"v":[4 bools],"p":[4 bools]}';

const variants = [
  { name: 'thinking.disabled', extra: { thinking: { type: 'disabled' } } },
  { name: 'enable_thinking.false', extra: { enable_thinking: false } },
  { name: 'both-off', extra: { thinking: { type: 'disabled' }, enable_thinking: false } },
  { name: 'json_object+disabled', extra: { thinking: { type: 'disabled' }, response_format: { type: 'json_object' } } }
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function once(model, extra) {
  const t0 = Date.now();
  const body = Object.assign(
    {
      model,
      temperature: 0,
      do_sample: false,
      max_tokens: 120,
      messages: [
        { role: 'system', content: 'CS2 chat moderator. JSON only. true=MUTE.' },
        { role: 'user', content: user }
      ]
    },
    extra
  );
  const res = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + seed, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const ms = Date.now() - t0;
  const data = await res.json().catch(() => ({}));
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const ch = data.choices && data.choices[0];
  return {
    http: res.status,
    ms,
    err: data.error || null,
    model: data.model,
    finish: ch && ch.finish_reason,
    content: msg.content || '',
    think: msg.reasoning_content || '',
    usage: data.usage || null
  };
}

(async () => {
  for (const model of ['glm-4.7-flash', 'glm-4.5-flash']) {
    console.log('\n====', model, '====');
    for (const v of variants) {
      await sleep(3000);
      let r = await once(model, v.extra);
      if (r.http === 429) {
        await sleep(10000);
        r = await once(model, v.extra);
      }
      console.log('--', v.name, r.http, r.ms + 'ms', 'finish=' + r.finish, 'ret_model=' + r.model);
      if (r.err) console.log('   ERR', JSON.stringify(r.err).slice(0, 220));
      console.log('   content', JSON.stringify(r.content).slice(0, 300));
      console.log('   think  ', r.think ? JSON.stringify(r.think).slice(0, 180) : '(vide)');
      console.log('   usage  ', JSON.stringify(r.usage));
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
