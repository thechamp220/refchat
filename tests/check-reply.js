'use strict';

// Les replies republient le message d'origine dans leur en-tete.
//
// C'est le trou par lequel repassait tout ce que l'extension venait de couper :
// un auteur mute reste lisible des que quelqu'un lui repond, et le texte cite
// partait au modele comme s'il venait de celui qui repond. Ce fichier fige les
// deux corrections : on trouve l'en-tete (y compris sur Kick, qui n'expose
// aucune classe « reply »), on le retire du texte juge, et on le masque quand
// la citation est sale — sans jamais masquer la ligne de celui qui repond.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function between(a, b) {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('bloc introuvable : ' + a);
  return src.slice(i, j);
}

// --- DOM minimal -----------------------------------------------------------
// On n'imite que ce que le code appelle vraiment : les quatre selecteurs qu'il
// passe a querySelectorAll, textContent, classList, dataset, contains, remove.
let REPLY_SEL, AUTHOR_SEL;

class N {
  constructor(tag, opts) {
    const o = opts || {};
    this.tag = tag;
    this.text = o.text || '';
    this.replyish = !!o.replyish; // porte une classe/attribut « reply »
    this.author = !!o.author; // est le pseudo de la ligne
    this.kids = [];
    this.parent = null;
    this.dataset = {};
    this._cls = new Set(o.cls || []);
    this.classList = {
      add: (c) => this._cls.add(c),
      remove: (c) => this._cls.delete(c),
      contains: (c) => this._cls.has(c),
      toggle: (c, on) => (on ? this._cls.add(c) : this._cls.delete(c))
    };
    for (const k of o.kids || []) this.add(k);
  }
  add(n) {
    n.parent = this;
    this.kids.push(n);
    return this;
  }
  remove() {
    if (!this.parent) return;
    const i = this.parent.kids.indexOf(this);
    if (i >= 0) this.parent.kids.splice(i, 1);
    this.parent = null;
  }
  get textContent() {
    return this.kids.length ? this.kids.map((k) => k.textContent).join(' ') : this.text;
  }
  descendants() {
    const out = [];
    for (const k of this.kids) out.push(k, ...k.descendants());
    return out;
  }
  contains(o) {
    return this.descendants().indexOf(o) !== -1;
  }
  get nextElementSibling() {
    if (!this.parent) return null;
    const i = this.parent.kids.indexOf(this);
    return i >= 0 ? this.parent.kids[i + 1] || null : null;
  }
  querySelectorAll(sel) {
    const all = this.descendants();
    if (sel === REPLY_SEL) return all.filter((n) => n.replyish);
    if (sel === AUTHOR_SEL) return all.filter((n) => n.author);
    if (sel === 'div,span,p') return all;
    if (sel === '.csg-quote') return all.filter((n) => n._cls.has('csg-quote'));
    return [];
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
}

// --- code sous test --------------------------------------------------------
globalThis.mutedUsers = {};
globalThis.liveMutedUsers = {};
globalThis.learnedWords = [];
globalThis.settings = { extraWords: '', learn: true, target: 'author' };
globalThis.isSelfName = (n) => String(n || '').toLowerCase() === 'moi';
globalThis.hideMuted = () => globalThis.settings.target !== 'message';
globalThis.siteTag = () => 'twitch';
globalThis.currentChannel = () => 'twitch/example';
globalThis.window = {
  CSG_KEYWORDS: {
    parseExtra: () => [],
    hitExtra: () => false,
    matchExtra: () => '',
    analyze: (t) => ({ heavy: /connard/i.test(t) })
  }
};

const code = [
  between('  const REPLY_SEL', '  const DEFAULTS'),
  between('  const AUTHOR_SEL', '  const FRAG_SEL'),
  between('  const RE_REPLY_HEAD', '  function stripReplyNodes'),
  between('  function stripReplyNodes', '  function msgText'),
  between('  function muteSite(rec)', '  function muteAuthor'),
  'Object.assign(globalThis, { REPLY_SEL, AUTHOR_SEL, replyNodes, extractReply, replyTainted, maskReply, stripReplyNodes });'
].join('\n');

// eslint-disable-next-line no-eval
eval(code);
REPLY_SEL = globalThis.REPLY_SEL;
AUTHOR_SEL = globalThis.AUTHOR_SEL;
const { replyNodes, extractReply, maskReply, stripReplyNodes } = globalThis;

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

// --- fabriques de lignes ---------------------------------------------------
// Twitch : l'en-tete porte une classe « reply ».
function twitchLine(quoteText, bodyText) {
  const head = new N('div', { replyish: true, text: quoteText });
  const body = new N('div', {
    kids: [new N('span', { author: true, text: 'viewer_rep' }), new N('span', { text: bodyText })]
  });
  return new N('div', { kids: [head, body] });
}

// Kick : aucune classe « reply » nulle part. L'en-tete n'est qu'un span de
// texte, et la row entiere commence donc elle aussi par « Répond à ».
function kickLine(quoteText, bodyText) {
  const head = new N('div', { kids: [new N('span', { text: quoteText })] });
  const body = new N('div', {
    kids: [new N('button', { author: true, text: 'viewer_rep' }), new N('span', { text: bodyText })]
  });
  return new N('div', { kids: [head, body] });
}

console.log('\n--- on trouve l en-tete des deux cotes ---');
const tw = twitchLine('Répond à @viewer_cite : GLASS CANON', 'il a 5k mdrr');
check('Twitch : en-tete trouve par classe', replyNodes(tw).length, 1);
check('Twitch : auteur cite', extractReply(tw).to, 'viewer_cite');
check('Twitch : texte cite', extractReply(tw).quote, 'GLASS CANON');

const ki = kickLine('Répond à @viewer_cite : GLASS CANON', 'il a 5k mdrr');
const kn = replyNodes(ki);
check('Kick : en-tete trouve par le texte', kn.length, 1);
check("Kick : c'est le noeud le plus profond", kn[0].tag, 'span');
check('Kick : la ligne entiere n est pas prise', kn.indexOf(ki), -1);
check('Kick : le corps du message est epargne', kn[0].textContent, 'Répond à @viewer_cite : GLASS CANON');
check('Kick : auteur cite', extractReply(ki).to, 'viewer_cite');

function kickNamedFirst(quoteText, bodyText) {
  return new N('div', {
    kids: [
      new N('button', { author: true, text: 'viewer_rep' }),
      new N('span', { text: quoteText }),
      new N('span', { text: bodyText })
    ]
  });
}
const first = kickNamedFirst('Répond à @viewer_cite : sale connard', 'bien joué');
check('Kick : pseudo devant, en-tete quand meme', replyNodes(first).length, 1);
check('Kick : pseudo devant, citation', extractReply(first).quote, 'sale connard');
maskReply(first);
check('Kick : pseudo devant, apercu coupe', first._cls.has('csg-reply-cut'), true);
const strippedFirst = kickNamedFirst('Répond à @viewer_cite : sale connard', 'bien joué');
stripReplyNodes(strippedFirst);
check('Kick : pseudo devant, la reponse reste', /bien joué/.test(strippedFirst.textContent), true);
check('Kick : pseudo devant, la citation part', /connard/.test(strippedFirst.textContent), false);

const split = new N('div', {
  kids: [
    new N('button', { author: true, text: 'dina' }),
    new N('span', { text: 'Répond à bob' }),
    new N('span', { text: 'ntm fdp' }),
    new N('span', { text: 'bien joué' })
  ]
});
check('Kick : citation dans le fragment suivant', replyNodes(split).length, 2);
stripReplyNodes(split);
check('Kick : fragment cite retire', /ntm/.test(split.textContent), false);
check('Kick : reponse du fragment gardee', /bien joué/.test(split.textContent), true);
const headerOnly = kickNamedFirst('Répond à @bob', 'la vraie réponse');
stripReplyNodes(headerOnly);
check('Kick : en-tete sans citation ne retire pas la reponse', /la vraie réponse/.test(headerOnly.textContent), true);
const longQuote = 'a'.repeat(350) + ' fin de citation';
check('citation longue conservée pour le contexte Grok',
  extractReply(kickNamedFirst('Répond à @bob : ' + longQuote, 'ok')).quote, longQuote);

console.log('\n--- ligne sans reply : on ne touche a rien ---');
const plain = new N('div', {
  kids: [new N('span', { author: true, text: 'viewer_rep' }), new N('span', { text: 'gg wp' })]
});
check('aucun en-tete trouve', replyNodes(plain).length, 0);
check('extractReply rend du vide', extractReply(plain), { to: '', quote: '' });
maskReply(plain);
check('marque comme non-reply, pour ne pas rescanner', plain.dataset.csgReply, '0');
check('aucune classe posee', plain._cls.has('csg-reply-cut'), false);

console.log('\n--- le texte juge ne contient jamais la citation ---');
// Sinon on juge celui qui repond sur les mots d'un autre : un message propre
// citant une insulte partait au modele avec l'insulte collee devant.
const strip = kickLine('Répond à @viewer_cite : sale connard', 'mdr');
stripReplyNodes(strip);
check('Kick : citation retiree du clone', /connard/.test(strip.textContent), false);
check('Kick : la reponse reste', /mdr/.test(strip.textContent), true);
const stripTw = twitchLine('Répond à @viewer_cite : sale connard', 'mdr');
stripReplyNodes(stripTw);
check('Twitch : citation retiree du clone', /connard/.test(stripTw.textContent), false);

console.log('\n--- on coupe l apercu quand la citation est sale ---');
globalThis.mutedUsers = { viewer_cite: 1 };
const cut = kickLine('Répond à @viewer_cite : GLASS CANON', 'il a 5k mdrr');
maskReply(cut);
check('auteur cite mute -> apercu coupe', cut._cls.has('csg-reply-cut'), true);
check("l en-tete est marque pour le CSS", replyNodes(cut)[0]._cls.has('csg-quote'), true);
check('la ligne de celui qui repond n est PAS bloquee', cut.dataset.csgBlocked, undefined);

globalThis.mutedUsers = {};
const keep = kickLine('Répond à @viewer_cite : GLASS CANON', 'il a 5k mdrr');
maskReply(keep);
check('auteur cite non mute et citation propre -> rien', keep._cls.has('csg-reply-cut'), false);

// Cible « message » : personne n'est mute, donc rien a cacher de ce cote.
globalThis.mutedUsers = { viewer_cite: 1 };
globalThis.settings.target = 'message';
const perMsg = kickLine('Répond à @viewer_cite : GLASS CANON', 'ok');
maskReply(perMsg);
check('cible message -> on ne coupe pas sur le mute', perMsg._cls.has('csg-reply-cut'), false);
globalThis.settings.target = 'author';

// Meme sans mute, une citation qui trippe la liste locale ne doit pas passer.
globalThis.mutedUsers = {};
const dirty = kickLine('Répond à @viewer_cite : sale connard', 'ok');
maskReply(dirty);
check('citation fautive -> apercu coupe sans mute', dirty._cls.has('csg-reply-cut'), true);

// Se citer soi-meme n'est pas une fuite.
globalThis.mutedUsers = { moi: 1 };
const self = kickLine('Répond à @moi : hello', 'ok');
maskReply(self);
check('citation de soi -> pas de coupe', self._cls.has('csg-reply-cut'), false);

console.log('\n--- reglage « cacher le message cite » ---');
// Confort : l'apercu tombe sur TOUTES les reponses, propre ou non.
globalThis.mutedUsers = {};
globalThis.settings.hideQuote = true;
const always = kickLine('Répond à @viewer_cite : GLASS CANON', 'il a 5k mdrr');
maskReply(always);
check('reglage actif -> apercu coupe meme propre', always._cls.has('csg-reply-cut'), true);
check("l en-tete reste marque pour le CSS", replyNodes(always)[0]._cls.has('csg-quote'), true);
const alwaysTw = twitchLine('Répond à @viewer_cite : GLASS CANON', 'ok');
maskReply(alwaysTw);
check('Twitch : apercu coupe aussi', alwaysTw._cls.has('csg-reply-cut'), true);
// Une ligne sans reply ne doit pas heriter de la coupe.
const plainOn = new N('div', {
  kids: [new N('span', { author: true, text: 'viewer_rep' }), new N('span', { text: 'gg wp' })]
});
maskReply(plainOn);
check('ligne sans reply -> rien a couper', plainOn._cls.has('csg-reply-cut'), false);
globalThis.settings.hideQuote = false;
const back = kickLine('Répond à @viewer_cite : GLASS CANON', 'ok');
maskReply(back);
check('reglage coupe -> retour au comportement auto', back._cls.has('csg-reply-cut'), false);

console.log('\n--- masquer les mutes coupe : la citation passe aussi ---');
// L'ecran est du chat vanilla : ni la ligne du mute, ni son apercu cite.
globalThis.mutedUsers = { viewer_cite: 1 };
globalThis.settings.target = 'message';
const vanilla = kickLine('Répond à @viewer_cite : GLASS CANON', 'ok');
maskReply(vanilla);
check('coupe : apercu du mute laisse tel quel', vanilla._cls.has('csg-reply-cut'), false);
globalThis.settings.hideQuote = true;
const vanillaAll = kickLine('Répond à @viewer_rep : hello', 'ok');
maskReply(vanillaAll);
check('coupe : « cacher le message cite » suspendu aussi', vanillaAll._cls.has('csg-reply-cut'), false);
globalThis.settings.hideQuote = false;
globalThis.settings.target = 'author';
const again = kickLine('Répond à @viewer_cite : GLASS CANON', 'ok');
maskReply(again);
check('recoche : apercu du mute recoupe', again._cls.has('csg-reply-cut'), true);
globalThis.mutedUsers = {};

console.log('\n--- rappel : le CSS doit viser la marque ---');
const css = fs.readFileSync(path.join(__dirname, '..', 'content.css'), 'utf8');
check('csg-quote masque sur une ligne coupee', /\.csg-reply-cut:not\(\.csg-revealed\) \.csg-quote/.test(css), true);
check('csg-quote masque sur une ligne bloquee', /\.csg-block:not\(\.csg-revealed\) \.csg-quote/.test(css), true);

console.log(fails ? '\n' + fails + ' ECHEC(S)\n' : '\ntout est vert\n');
process.exit(fails ? 1 : 0);
