'use strict';

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const bg = fs.readFileSync(path.join(root, 'background.js'), 'utf8');

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails += 1;
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (ok ? '' : '\n        obtenu  ' + JSON.stringify(got) + '\n        attendu ' + JSON.stringify(want)));
}

function between(src, a, b) {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error('bloc introuvable: ' + a);
  return src.slice(i, j);
}

console.log('\n--- garde-fous ---');
check('handleLine laisse passer un whiteliste', /isWhitelisted\(author\)/.test(between(content, 'function handleLine', '\n  function hideMuted')), true);
check('muteAuthor refuse un whiteliste', /isWhitelisted\(key\)/.test(between(content, 'function muteAuthor', '\n  function harvestBlurred')), true);
check('addMute refuse un whiteliste', /isWhitelisted\(key\)/.test(between(bg, 'function addMute', '\nfunction removeMute')), true);
check('message whitelist autorise depuis le chat', /CSG_WHITELIST:\s*1/.test(bg) && /msg\.type === 'CSG_WHITELIST'/.test(bg), true);
check('bouton muter sur la carte', /csg-mute-btn/.test(content) && /function onMuteClick/.test(content), true);
check('unmute carte autorise depuis le chat', /CSG_MUTE_REMOVE:\s*1/.test(bg), true);

console.log('\n--- carte viewer ---');
const api = new Function(
  `function nick(s) {
    return String(s || '').replace(/[\\u200b-\\u200d\\ufeff]/g, '').replace(/^@+/, '').trim().toLowerCase();
  }
  ${between(content, 'const NOT_LOGIN', '\n  function placeWl')}
  return { loginFromHref, cardNames, findViewerCards };`
)();

function match(node, sel) {
  return String(sel)
    .split(',')
    .some((raw) => {
      const s = raw.trim();
      if (s === 'button') return node.tag === 'button';
      if (s === 'a[href]') return node.tag === 'a' && node.attrs.href;
      if (s.indexOf('[data-a-target="') === 0) return node.attrs['data-a-target'] === s.slice(16, -2);
      if (s.indexOf('[data-test-selector="') === 0) return node.attrs['data-test-selector'] === s.slice(21, -2);
      if (/^h[1-5]$/.test(s) || s === 'p' || s === 'a' || s === 'button' || s === 'span') return node.tag === s;
      return false;
    });
}

function el(tag, opts) {
  const node = {
    tag,
    attrs: (opts && opts.attrs) || {},
    text: (opts && opts.text) || '',
    children: (opts && opts.children) || [],
    classList: { contains: (c) => String((opts && opts.cls) || '').split(' ').indexOf(c) !== -1 },
    parentElement: null,
    getAttribute(k) {
      return this.attrs[k] || null;
    },
    querySelector(sel) {
      const hit = this.querySelectorAll(sel);
      return hit[0] || null;
    },
    querySelectorAll(sel) {
      const all = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (match(c, sel)) all.push(c);
          walk(c);
        }
      };
      walk(this);
      return all;
    },
    closest(sel) {
      let n = this;
      while (n) {
        if (match(n, sel)) return n;
        n = n.parentElement;
      }
      return null;
    },
    get textContent() {
      return (this.text + this.children.map((c) => c.textContent).join('')).replace(/\s+/g, ' ').trim();
    },
    get innerText() {
      return this.textContent;
    }
  };
  for (const c of node.children) c.parentElement = node;
  return node;
}

global.document = { body: el('body'), documentElement: el('html') };

check('login depuis un href court', api.loginFromHref('/Netizen29'), 'netizen29');
check('login depuis une url twitch', api.loginFromHref('https://www.twitch.tv/netizen29'), 'netizen29');
check('pas un chemin du site', api.loginFromHref('/directory'), '');

const card = el('div', {
  children: [
    el('a', { attrs: { href: '/netizen29' }, text: 'Netizen29' }),
    el('p', { text: 'Badges' }),
    el('p', { text: 'Tout voir (20)' }),
    el('button', { text: 'Offrir un sub' }),
    el('button', { text: 'Suivre' }),
    el('button', { text: 'Chuchoter' })
  ]
});
const doc = el('div', { children: [card] });
check('le panneau Chuchoter donne le blaze', api.findViewerCards(doc).length, 1);
check('blaze lu sur le lien', api.cardNames(api.findViewerCards(doc)[0]), ['netizen29']);

const en = el('div', {
  children: [
    el('span', {
      tag: 'h4',
      attrs: { 'data-a-target': 'viewer-card-display-name' },
      text: 'CoolNick'
    }),
    el('button', { attrs: { 'data-a-target': 'viewer-card-whisper-button' }, text: 'Whisper' }),
    el('button', { text: 'Follow' })
  ]
});
check('carte anglaise', api.cardNames(api.findViewerCards(el('div', { children: [en] }))[0]), ['coolnick']);

const bare = el('div', {
  children: [
    el('span', { text: 'Netizen29' }),
    el('p', { text: 'Badges' }),
    el('button', { text: 'Suivre' }),
    el('button', { text: 'Chuchoter' })
  ]
});
check('blaze lu sans lien', api.cardNames(api.findViewerCards(el('div', { children: [bare] }))[0]), ['netizen29']);

console.log(fails ? '\n' + fails + ' ECHEC(S)\n' : '\ntout est vert\n');
process.exit(fails ? 1 : 0);
