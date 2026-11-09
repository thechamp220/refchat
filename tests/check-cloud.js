'use strict';

globalThis.self = globalThis;
const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'cloud.js'));
const C = globalThis.CSG_CLOUD;

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(
    (ok ? '  ok  ' : ' FAIL ') +
      name +
      (ok ? '' : '\n        obtenu  ' + JSON.stringify(got) + '\n        attendu ' + JSON.stringify(want))
  );
}

console.log('\n--- URL ---');
check('https propre', C.normalizeUrl('https://vps.example:8787/'), 'https://vps.example:8787');
check('chemin conserve', C.normalizeUrl('http://10.0.0.2:8787/csg/'), 'http://10.0.0.2:8787/csg');
check('javascript refuse', C.normalizeUrl('javascript:alert(1)'), '');
check('userinfo refuse', C.normalizeUrl('https://a:b@evil.test'), '');
check('vide', C.normalizeUrl(''), '');
check('origin pattern', C.originPattern('https://vps.example:8787/csg'), 'https://vps.example:8787/*');
check('snapshot path', C.snapshotUrl('http://10.0.0.2:8787'), 'http://10.0.0.2:8787/snapshot');

console.log('\n--- local vide ---');
check(
  'magasin neuf',
  C.localEmpty({ csg_muted: {}, csg_ft_log: [], csg_learned: [], csg_engine: {} }),
  true
);
check('un mute suffit', C.localEmpty({ csg_muted: { bob: { at: 1 } }, csg_ft_log: [], csg_learned: [], csg_engine: {} }), false);
check('une cle n empeche pas un pull', C.localEmpty({ csg_muted: {}, csg_ft_log: [], csg_learned: [], csg_engine: { glmKey: 'ab'.repeat(16) + '.x' } }), true);

console.log('\n--- snapshot ---');
const snap = C.build(
  {
    csg_settings: { extraWords: 'foo' },
    csg_engine: { goKey: 'sk-a' },
    csg_muted: { x: { at: 1, pct: 90, perm: true } },
    csg_learned: [{ w: 'bar', at: 2 }],
    csg_learn_block: ['nope'],
    csg_ft_log: [{ id: '1', label: 'mute', text: 'x', ts: 9 }],
    csg_ft_count: 12
  },
  111
);
check('version', snap.v, 1);
check('rev', snap.rev, 111);
check('ftCount', snap.ftCount, 12);
check('settings', snap.settings.extraWords, 'foo');
check('cles absentes du snapshot', !snap.engine.goKey && !snap.engine.googleKey && !snap.engine.glmKey, true);

console.log('\n--- fusion : reinstall ---');
const remote = C.build(
  {
    csg_muted: { a: { at: 5, pct: 80 } },
    csg_ft_log: [{ id: 'r1', label: 'keep', text: 'gg', ts: 3 }],
    csg_learned: [{ w: 'tox', at: 8 }],
    csg_learn_block: ['nope'],
    csg_engine: { goKey: 'sk-cloud', googleKey: 'AIza' },
    csg_settings: { extraWords: 'cloud' }
  },
  50
);
const emptyLocal = C.build({ csg_muted: {}, csg_ft_log: [], csg_learned: [], csg_engine: {} }, 1);
const take = C.merge(emptyLocal, remote);
check('local vide prend le cloud', take.why, 'local-vide');
check('cles non importees du cloud', !take.snap.engine.goKey && !take.snap.engine.googleKey, true);
check('mutes cloud recuperes', !!take.snap.muted.a, true);

console.log('\n--- fusion : les deux ont des donnees ---');
const local = C.build(
  {
    csg_muted: { a: { at: 1, pct: 40 }, b: { at: 2, pct: 99, perm: true } },
    csg_ft_log: [
      { id: 'r1', label: 'pending', text: 'gg', ts: 1 },
      { id: 'l2', label: 'mute', text: 'sale', ts: 4 }
    ],
    csg_learned: [{ w: 'tox', at: 1, hits: 1 }, { w: 'local', at: 9 }],
    csg_learn_block: ['old'],
    csg_engine: { goKey: 'sk-local' },
    csg_settings: { extraWords: 'moi', hideQuote: true }
  },
  20
);
const fused = C.merge(local, remote);
check('fusion pas ecrasement', fused.why, 'fusion');
check('cles absentes de la fusion', !fused.snap.engine.goKey, true);
check('mute a : meilleur score', fused.snap.muted.a.pct, 80);
check('mute b conserve', fused.snap.muted.b.perm, true);
check('terme local garde', fused.snap.learned.some((x) => x.w === 'local'), true);
check('terme cloud fusionne', fused.snap.learned.some((x) => x.w === 'tox' && x.at === 8), true);
check('ft r1 : le keep cloud gagne sur pending', fused.snap.ftLog.find((r) => r.id === 'r1').label, 'keep');
check('ft l2 local reste', fused.snap.ftLog.some((r) => r.id === 'l2'), true);
check('extraWords local prime', fused.snap.settings.extraWords, 'moi');
check('hideQuote local prime', fused.snap.settings.hideQuote, true);
check('block union', fused.snap.learnBlock.slice().sort(), ['nope', 'old'].sort());

console.log('\n--- fusion : cles partielles ---');
const partialLocal = C.build(
  { csg_engine: { goKey: 'sk-local', googleKey: '', glmKey: '' }, csg_muted: { x: { at: 1 } } },
  30
);
const partialRemote = C.build(
  { csg_engine: { goKey: '', googleKey: 'AIza-cloud', glmKey: 'glm-cloud' }, csg_muted: { y: { at: 1 } } },
  20
);
const partial = C.merge(partialLocal, partialRemote);
check('cles jamais dans le snap fusionne', !partial.snap.engine.goKey && !partial.snap.engine.googleKey && !partial.snap.engine.glmKey, true);

console.log('\n--- refus ---');
check('remote foireux', C.merge(local, { v: 99 }).why, 'remote-invalide');
check('remote null', C.merge(local, null).why, 'remote-invalide');

console.log('\n--- headers ---');
check('bearer', C.headers('abc').Authorization, 'Bearer abc');

const fs = require('fs');
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
console.log('\n--- garde-fous extension ---');
check('optional_host_permissions present', Array.isArray(man.optional_host_permissions) && man.optional_host_permissions.length > 0, true);
check('https://*/* pas en host dur', (man.host_permissions || []).indexOf('https://*/*') === -1, true);
check('importScripts cloud.js', /importScripts\('cloud\.js'\)/.test(bg), true);
check('jeton lu depuis csg_cloud', /cloudCfg\.token/.test(bg), true);
check('filtre sender page', /function fromExtPage/.test(bg), true);
check('filtre sender chat', /function fromChatTab/.test(bg) && /CHAT_MSG/.test(bg), true);

console.log(fails ? '\n' + fails + ' ECHEC(S)\n' : '\ntout est vert\n');
process.exit(fails ? 1 : 0);
