'use strict';
const fs = require('fs');
const path = require('path');
const files = process.argv.slice(2);
function tally(file) {
  const rows = fs
    .readFileSync(file, 'utf8')
    .split(/\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
  const by = {};
  for (const r of rows) {
    const m = r.model || '(none)';
    if (!by[m]) by[m] = { n: 0, mute: 0, keep: 0, pending: 0, dropped: 0, llm: 0, skip: 0 };
    const b = by[m];
    b.n++;
    if (r.label === 'mute') b.mute++;
    else if (r.label === 'keep') b.keep++;
    else if (r.label === 'pending') b.pending++;
    else if (r.label === 'dropped') b.dropped++;
    if (String(r.source || '').indexOf('llm') === 0) b.llm++;
    if (r.source === 'llm_skip') b.skip++;
  }
  return { n: rows.length, by, sampleMute: rows.filter((r) => r.label === 'mute' && r.model).slice(0, 8) };
}
for (const f of files) {
  if (!fs.existsSync(f)) {
    console.log('missing', f);
    continue;
  }
  const t = tally(f);
  console.log('\nFILE', path.basename(f), 'rows', t.n);
  const keys = Object.keys(t.by).sort((a, b) => t.by[b].n - t.by[a].n);
  for (const k of keys) {
    const b = t.by[k];
    const judged = b.mute + b.keep;
    const mutePct = judged ? ((100 * b.mute) / judged).toFixed(1) : '0';
    console.log(
      ' ',
      k,
      'n=' + b.n,
      'mute=' + b.mute,
      'keep=' + b.keep,
      'mute/judged=' + mutePct + '%',
      'dropped=' + b.dropped,
      'skip=' + b.skip
    );
  }
  if (t.sampleMute.length) {
    console.log('  sample mutes:');
    for (const r of t.sampleMute) console.log('   -', r.model, r.author, JSON.stringify(r.text).slice(0, 80));
  }
}
