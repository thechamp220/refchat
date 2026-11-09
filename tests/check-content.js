'use strict';

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function between(a, b) {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('bloc introuvable: ' + a);
  return src.slice(i, j);
}

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails += 1;
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (ok ? '' : '\n        obtenu  ' + JSON.stringify(got) + '\n        attendu ' + JSON.stringify(want)));
}

console.log('\n--- outbox bornee ---');
const makeOutbox = new Function(`
  const OUTBOX = { MAX_TRIES: 4, MAX: 2 };
  const outbox = [];
  const ctxDead = () => false;
  const scheduleOutbox = () => {};
  ${between('function requeue', '\n  function deliver')}
  return { requeue, outbox };
`);
const box = makeOutbox();
let dropped = 0;
for (let i = 0; i < 3; i++) box.requeue({ tries: 0, onDrop: () => { dropped += 1; } });
check('plafond respecte', box.outbox.length, 2);
check('eviction notifie onDrop', dropped, 1);
box.requeue({ tries: 4, onDrop: () => { dropped += 1; } });
check('epuisement des essais notifie onDrop', dropped, 2);

console.log('\n--- application locale et mutes ---');
check('termes appris forces actifs', /const FORCED = \{[\s\S]*?\blearn:\s*true,/.test(src), true);
check('scope n est plus force a all', /const FORCED = \{[\s\S]*?\bscope:\s*'all'/.test(src), false);
check('detection CS2 bornee au jeu du stream', /function pageLooksLikeCs2\(/.test(src) && /stream-game-link/.test(src), true);
check('captureWhy ne bloque plus sur scope', /settings\.scope !== 'all' && !pageLooksLikeCs2\(\)/.test(between('function captureWhy', '\n  function wantsLlmQueue')), false);
check('file LLM respect scope ou jugement coupe', /function wantsLlmQueue\(/.test(src) && /settings\.judge === false/.test(between('function wantsLlmQueue', '\n  function isChatFrame')), true);
check('enqueueLlm refuse hors portee', /function enqueueLlm[\s\S]{0,120}if \(!wantsLlmQueue\(\)\) return;/.test(src), true);
check(
  'le content script necrit plus directement csg_muted',
  /chrome\.storage\.local\.(?:get|set)/.test(between('function muteAuthor', '\n  function harvestBlurred')),
  false
);
check(
  'act ne refuse plus une ligne sans pseudo',
  /const name =[\s\S]{0,100}if \(!name\) return;/.test(between('function act', '\n  function labelText')),
  false
);
check(
  'act masque les filtres locaux, pas seulement LLM',
  /if \(reason !== 'muet' && reason !== 'LLM'/.test(between('function act', '\n  function labelText')),
  false
);
check(
  'le chargement des reglages remasque et repeint la pause',
  /markSettingsReady\(\);[\s\S]{0,240}restyleAll\(\);\s*retroHideMuted\(\);\s*paintAmbiencePause\(\);/.test(src),
  true
);
check(
  'le cache de capture suit l URL et l arrivee du chat',
  /href === whyCacheHref && !chatArrived/.test(between('function getWhy', '\n  const CHAT_ROOT_SEL')),
  true
);

console.log('\n--- masquer les mutes : un reglage d affichage, rien de plus ---');
// Un element de chat minimal : on regarde les classes, le titre et la puce.
function fakeEl(reason) {
  const cls = new Set();
  const kids = [];
  const el = {
    dataset: { csgBlocked: '1', csgReason: reason || 'LLM' },
    title: 'Masque par Refchat',
    classList: {
      add: (c) => cls.add(c),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      contains: (c) => cls.has(c),
      toggle: (c, on) => (on ? cls.add(c) : cls.delete(c))
    },
    querySelector: (sel) => kids.find((n) => String(n.className).split(' ').includes(sel.slice(1))) || null,
    querySelectorAll: (sel) => kids.filter((n) => sel.split(',').some((s) => String(n.className).split(' ').includes(s.trim().slice(1)))),
    appendChild: (n) => kids.push(n),
    removeAttribute: (k) => {
      if (k === 'title') el.title = '';
    },
    cls,
    kids
  };
  return el;
}

const styler = new Function(`
  let settings = { mode: 'block', target: 'author' };
  const hideMuted = () => settings.target !== 'message';
  const labelText = () => 'bloque';
  const blockedLabel = () => ({ className: 'csg-blocked-label', textContent: '', remove: () => {} });
  ${between('function applyStyle', '\n  function restyleAll')}
  return { applyStyle, set: (s) => (settings = s) };
`)();

{
  const el = fakeEl('LLM');
  styler.set({ mode: 'block', target: 'author' });
  styler.applyStyle(el);
  check('coche : la ligne est masquee', Array.from(el.cls), ['csg-hidden']);

  styler.set({ mode: 'block', target: 'message' });
  styler.applyStyle(el);
  check('coupe : aucune classe de masquage', Array.from(el.cls), []);
  check('coupe : plus d infobulle', el.title, '');
  check('coupe : le verdict reste sur la ligne', [el.dataset.csgBlocked, el.dataset.csgReason], ['1', 'LLM']);

  styler.set({ mode: 'block', target: 'author' });
  styler.applyStyle(el);
  check('recoche : remasquee sans rejuger', Array.from(el.cls), ['csg-hidden']);

  const el2 = fakeEl('mot perso');
  styler.set({ mode: 'block', target: 'author' });
  styler.applyStyle(el2);
  check('coche : puce posee', el2.kids.length, 1);
  let removed = 0;
  el2.kids[0].remove = () => (removed += 1);
  styler.set({ mode: 'block', target: 'message' });
  styler.applyStyle(el2);
  check('coupe : la puce est retiree', removed, 1);

  const muted = fakeEl('muet');
  styler.set({ mode: 'block', target: 'author', blankMute: false });
  styler.applyStyle(muted);
  check('muet : pseudo barre, puce gardee', Array.from(muted.cls), ['csg-block', 'csg-mute']);
  check('muet : une puce', muted.kids.length, 1);

  styler.set({ mode: 'block', target: 'author', blankMute: true });
  styler.applyStyle(muted);
  check('muet cache : ligne entiere retiree', Array.from(muted.cls), ['csg-hidden']);
}

check(
  'coupe : la citation n est pas coupee non plus',
  /csg-reply-cut', hideMuted\(\) &&/.test(between('function maskReply', 'function stripReplyNodes')),
  true
);
// Le reglage ne decide plus du mute : la fiche est posee dans les deux cas.
check(
  'muteAuthor ne regarde plus le reglage d affichage',
  /hideMuted\(\)/.test(between('function muteAuthor', '\n  function harvestBlurred')),
  false
);
check(
  'harvestBlurred non plus',
  /hideMuted\(\)/.test(between('function harvestBlurred', '\n  function act')),
  false
);
check('hud sans LM Studio', src.indexOf('LM Studio') === -1, true);

console.log(fails ? '\n' + fails + ' ECHEC(S)\n' : '\ntout est vert\n');
process.exit(fails ? 1 : 0);
