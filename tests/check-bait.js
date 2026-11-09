'use strict';

// Grok repond a ta place : le bouton « Grok lui repond » de la carte d'un
// viewer lui confie la conversation, et chaque ligne qu'il t'adresse part a
// Grok 4.7 (effort high), qui repond en ton nom. C'est le seul appel modele
// sans clic Analyser, et le seul qui ECRIT dans le chat depuis ton compte.
// Ce fichier verifie que personne n'est confie sans clic, que seules les lignes
// qui te visent partent, que les plafonds tiennent, et qu'aucune replique
// douteuse ne part.
//
//   node tests/check-bait.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const noop = () => {};
const OAUTH = { access: 'xai-oauth-bait', refresh: 'r', exp: Date.now() + 3600000 };
const CHAT = { tab: { id: 7, url: 'https://kick.com/x' }, frameId: 3 };
const PAGE = { url: 'chrome-extension://test/popup.html' };

// Un worker complet sur un storage donne : relancer = rebooter sur le meme.
function boot(store) {
  const w = { store, sent: [], calls: [], tabReply: { ok: true }, reply: 'ok et', onMessage: [] };
  const event = (list) => ({ addListener: (fn) => list && list.push(fn), removeListener: noop, hasListener: () => false });
  const localApi = {
    get: (d, cb) => {
      const out = {};
      for (const k of Object.keys(d || {})) out[k] = k in store ? JSON.parse(JSON.stringify(store[k])) : d[k];
      if (cb) cb(out);
    },
    set: (o, cb) => {
      for (const k of Object.keys(o || {})) store[k] = JSON.parse(JSON.stringify(o[k]));
      if (cb) cb();
    },
    remove: (k, cb) => {
      for (const key of [].concat(k)) delete store[key];
      if (cb) cb();
    }
  };
  const chrome = {
    runtime: { onMessage: event(w.onMessage), onInstalled: event(), onStartup: event(), lastError: null, id: 'test', getURL: (p) => 'chrome-extension://test/' + (p || ''), sendMessage: noop },
    storage: { local: localApi, sync: localApi, session: localApi, onChanged: event() },
    alarms: { create: noop, clear: noop, onAlarm: event() },
    notifications: { create: noop, clear: noop, onClicked: event(), onButtonClicked: event() },
    tabs: {
      query: (q, cb) => cb && cb([]),
      // Onglet du stream : ce que content.js repondrait a CSG_BAIT_SEND.
      sendMessage: (id, msg, opts, cb) => {
        if (typeof opts === 'function') cb = opts;
        const bait = msg && msg.type === 'CSG_BAIT_SEND';
        if (bait) w.sent.push({ id, msg, opts });
        if (cb) cb(bait ? w.tabReply : undefined);
      },
      onUpdated: event(),
      onRemoved: event(),
      create: noop
    },
    scripting: { executeScript: () => Promise.resolve([]) },
    webNavigation: { onCompleted: event(), onHistoryStateUpdated: event() },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setTitle: noop, onClicked: event() },
    windows: { create: noop, onRemoved: event(), onFocusChanged: event() }
  };
  const sandbox = { chrome, console, fetch: () => Promise.reject(new Error('offline')), AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, URL, TextEncoder, TextDecoder };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  sandbox.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'keywords.js'), 'utf8'), ctx, { filename: 'keywords.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  w.run = (code) => vm.runInContext(code, ctx);

  // Faux reseau, sous chatCall : le corps envoye a xAI est donc le vrai.
  // `w.reply` : une chaine (contenu du modele), une Error, ou une fonction qui
  // recoit le signal d'annulation et rend une promesse.
  sandbox.__bait = {
    fetch(url, apiKey, body, ms, p, pool) {
      w.calls.push({ url, apiKey, body, ms });
      const r = w.reply;
      if (r instanceof Error) return Promise.reject(r);
      if (typeof r === 'function') {
        const ctrl = new AbortController();
        if (pool) pool.add(ctrl);
        return r(ctrl.signal).finally(() => pool && pool.delete(ctrl));
      }
      return Promise.resolve({ choices: [{ message: { content: r }, finish_reason: 'stop' }] });
    }
  };
  w.run('llmFetch = function(url, apiKey, body, ms, p, pool) { return __bait.fetch(url, apiKey, body, ms, p, pool); }');
  // Pas d'attente reelle entre ses lignes ni entre deux repliques.
  w.run('HAND.SETTLE_MS = 0; HAND.GAP_MS = 0;');
  w.run('setSelfNicks(["moi"])');

  // Message runtime, avec son expediteur : le filtre CHAT_MSG / page s'applique.
  w.send = (msg, sender) =>
    new Promise((resolve) => {
      let answered = false;
      const reply = (r) => {
        answered = true;
        resolve(r);
      };
      for (const fn of w.onMessage) fn(msg, sender, reply);
      setTimeout(() => !answered && resolve('SANS REPONSE'), 250);
    });
  let seq = 0;
  // Une ligne capturee, comme le content script l'envoie.
  w.line = async (author, text, extra) => {
    seq += 1;
    await w.send(Object.assign({ type: 'CSG_CAPTURE', id: 'b' + seq + '-' + author, author, text, channel: 'kick/x' }, extra || {}), CHAT);
    await settle();
  };
  w.hand = (name, on, channel) => w.send({ type: 'CSG_HAND_SET', name, on: on !== false, channel: channel || 'kick/x' }, CHAT);
  w.status = () => w.run('baitStatus.kind');
  w.texts = () => w.sent.map((s) => s.msg.text);
  return w;
}

// scheduleBait passe par un vrai setTimeout (meme a 0 ms) : quelques tours de
// timers, pas seulement des microtaches.
async function settle() {
  for (let round = 0; round < 4; round++) {
    await new Promise((r) => setTimeout(r, 2));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  }
}

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (ok ? '' : '\n        obtenu  ' + JSON.stringify(got) + '\n        attendu ' + JSON.stringify(want)));
}

// Worker neuf, SuperGrok connecte, `names` confies a Grok.
async function fresh(names) {
  const w = boot({ csg_engine: { xaiOAuth: OAUTH } });
  await settle();
  for (const n of names || []) await w.hand(n);
  return w;
}

(async () => {
  console.log('\n--- contexte du salon et message entier ---');
  {
    const w = await fresh();
    await w.line('Autre', 'CONTEXTE_AUTRE_SALON', { channel: 'twitch/autre' });
    await w.line('Local', 'CONTEXTE_DU_SALON', { channel: 'twitch/streamer_fr' });
    w.run("recentChat.push({a:'ancien',t:'CONTEXTE_SANS_SALON'})");
    const text = 'Assez de spoilers, merci. ' + 'Chacun choisit son jeu. '.repeat(18) + 'Ne racontez pas la fin dans chaque conversation.';
    await w.send({ type: 'CSG_GROK_REPLY', id: 'whole-message', author: 'viewer_long', text,
      channel: 'twitch/streamer_fr', streamContext: { title: 'Discussion du soir', category: 'Just Chatting' },
      replyTo: 'Local', replyQuote: 'Citation complete' }, CHAT);
    const user = w.calls[0].body.messages.slice(-1)[0].content;
    check('chaine et plateforme transmises au modele', user.includes('chat Twitch de streamer_fr (twitch/streamer_fr)'), true);
    check('titre et categorie visibles transmis', user.includes('Discussion du soir') && user.includes('Just Chatting'), true);
    check('message long conserve jusqu a sa conclusion', user.includes(text), true);
    check('citation attribuee a son auteur', user.includes('a Local : "Citation complete"'), true);
    check('contexte du salon uniquement', user.includes('CONTEXTE_DU_SALON') && !user.includes('CONTEXTE_AUTRE_SALON') && !user.includes('CONTEXTE_SANS_SALON'), true);
    check('chaine Kick avec le bon domaine', w.run('replyChatBlock("kick/x")').includes('https://kick.com/x'), true);
    check('chaine absente explicite', w.run('replyChatBlock("")').includes('chaine inconnue'), true);
    const hand = await fresh(['Bob']);
    await hand.line('Bob', '@moi ' + text, { streamContext: { title: 'Titre Kick', category: 'Jeux' } });
    const followed = hand.calls[0].body.messages.slice(-1)[0].content;
    check('suivi recoit aussi le salon et le message entier', followed.includes('chat Kick de x') && followed.includes('Titre Kick') && followed.includes(text), true);
  }
  console.log('\n--- personne n est confie sans clic ---');
  {
    const w = await fresh();
    await w.line('Troll', '@moi t es une merde a ce jeu');
    check('personne confie : rien ne part', w.calls.length, 0);
    w.run('applySettings')({ baitReply: true });
    await w.line('Troll', '@moi t es une merde a ce jeu, vraiment');
    check('ancienne case baitReply : ne confie personne', w.calls.length, 0);
    check('lane hors CHAIN : Analyser ne l appelle pas', w.run('CHAIN.some((l) => l.id === BAIT_LANE.id)'), false);
    const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
    check('plus de case a cocher dans le popup', /id="baitReply"/.test(html), false);
  }

  console.log('\n--- le bouton de la carte ---');
  {
    const w = await fresh();
    check('clic : confie', await w.hand('Troll'), { ok: true, on: true });
    check('  enregistre sur disque', Object.keys(w.store.csg_hand || {}), ['troll']);
    check('  avec son salon', (w.store.csg_hand.troll || {}).channel, 'kick/x');
    check('toi-meme : refuse', (await w.hand('moi')).ok, false);
    check('une page web ne peut pas confier', await w.send({ type: 'CSG_HAND_SET', name: 'Bob', on: true }, { tab: { id: 9, url: 'https://evil.example/' } }), 'SANS REPONSE');
    for (const n of ['a2', 'a3', 'a4', 'a5']) await w.hand(n);
    check('5 personnes au plus', (await w.hand('a6')).ok, false);
    check('re-clic : reprend la main', (await w.hand('Troll', false)).on, false);
    check('  retire du disque', 'troll' in (w.store.csg_hand || {}), false);
    check('Arreter du popup (page de l extension)', await w.send({ type: 'CSG_HAND_STOP', key: 'a2' }, PAGE), { ok: true });
    check('  retire', 'a2' in w.store.csg_hand, false);
    check('Arreter depuis le chat : autorise', await w.send({ type: 'CSG_HAND_STOP', all: true }, CHAT), { ok: true });
    await w.send({ type: 'CSG_HAND_STOP', all: true }, PAGE);
    check('Tout arreter', w.store.csg_hand, {});
    check('  statut coupe', w.status(), 'off');
  }

  console.log('\n--- il te parle : Grok reflechit et repond ---');
  {
    const w = await fresh(['Troll']);
    await w.line('Autre', 'belle game hier');
    await w.line('Troll', '@moi t es nul, desinstalle le jeu');
    check('un appel', w.calls.length, 1);
    const c = w.calls[0] || { body: {} };
    check('  vers xAI', /api\.x\.ai/.test(c.url || ''), true);
    check('  avec le jeton SuperGrok', c.apiKey, OAUTH.access);
    check('  modele grok-4.7', c.body.model, 'grok-4.7');
    check('  reflexion high', c.body.reasoning_effort, 'high');
    check('  le temps de reflechir (90 s)', c.ms, 90000);
    const msgs = c.body.messages || [];
    const sys = msgs.length > 1 ? msgs[0].content : '';
    const user = msgs.length ? msgs[msgs.length - 1].content : '';
    check('  il repond quand une reponse utile est possible', /reponds quand une reponse utile est possible/i.test(sys), true);
    check('  humour facultatif, jamais sur un sujet serieux', /humour est possible/.test(sys) && /Sujet serieux[^\n]*aucune blague/.test(sys), true);
    check('  il ecrit en ton nom', /Tu es moi\. Tu parles avec Troll/.test(user), true);
    check('  la ligne est dans la demande', /desinstalle le jeu/.test(user), true);
    check('  avec le chat autour', /belle game hier/.test(user), true);
    check('replique envoyee', w.texts(), ['ok et']);
    check('  en reponse Twitch a sa ligne (sinon @Troll)', w.sent[0] && [w.sent[0].msg.replyToId, w.sent[0].msg.author], ['b2-Troll', 'Troll']);
    check('  au bon onglet, au bon frame', w.sent[0] && [w.sent[0].id, w.sent[0].opts.frameId], [7, 3]);
    check('  avec le salon (content.js refuse un autre salon)', w.sent[0] && w.sent[0].msg.channel, 'kick/x');
    check('statut : envoye', w.status(), 'sent');
    check('fil garde sur disque', (w.store.csg_hand.troll.thread || []).map((m) => m.w + ':' + m.t), ['lui:@moi t es nul, desinstalle le jeu', 'moi:ok et']);

    w.reply = 'tu forces un peu';
    await w.line('Troll', 'ah ouais et pourquoi');
    check('suite directe sans @ : il repond encore', w.texts().length, 2);
    const user2 = (w.calls[1] && w.calls[1].body.messages.slice(-1)[0].content) || '';
    check('  il relit le fil', /Fil complet avec Troll[\s\S]*ok et/.test(user2), true);

    await w.line('Troll', '@bob t as vu ca');
    check('il parle a quelqu un d autre : rien', w.calls.length, 2);
    await w.line('Troll', 'mdr', { replyTo: 'bob' });
    check('il repond a quelqu un d autre : rien', w.calls.length, 2);
    await w.line('Autre', '@moi toi aussi t es nul');
    check('quelqu un que tu n as pas confie : rien', w.calls.length, 2);
    await w.line('Troll', '@moi ailleurs', { channel: 'kick/y' });
    check('autre salon : rien', w.calls.length, 2);
    w.run('baitTargets.troll.sentAt = Date.now() - HAND.FOLLOW_MS - 1');
    await w.line('Troll', 'bref');
    check('sans @ apres 3 min : ce n est plus a toi', w.calls.length, 2);
    await w.line('Troll', 'on en reparle', { replyTo: 'moi' });
    check('reponse a ton message : repart', w.calls.length, 3);
  }

  console.log('\n--- plusieurs lignes d affilee : une seule replique ---');
  {
    const w = await fresh(['Troll']);
    w.run('HAND.SETTLE_MS = 80');
    await w.line('Troll', '@moi premiere');
    await w.line('Troll', '@moi deuxieme');
    await w.line('Troll', '@moi troisieme');
    check('rien avant qu il ait fini', w.calls.length, 0);
    await new Promise((r) => setTimeout(r, 150));
    await settle();
    check('un seul appel', w.calls.length, 1);
    const user = (w.calls[0] && w.calls[0].body.messages.slice(-1)[0].content) || '';
    check('  avec ses trois lignes', ['premiere', 'deuxieme', 'troisieme'].every((s) => user.indexOf(s) !== -1), true);
    check('  une replique', w.sent.length, 1);
  }

  console.log('\n--- ce qui ne part pas ---');
  for (const [label, out] of [
    ['SKIP du modele', 'SKIP'],
    ['SKIP sur une ligne a part', 'bon\nSKIP'],
    ['insulte lourde', 'ta gueule toi'],
    ['ton IA', 'je comprends ton point de vue'],
    ['aveu d IA', 'je suis une ia tu sais'],
    ['lien', 'regarde https://x.com/a'],
    ['emoji', 'ok et 😂'],
    ['pave', Array.from({ length: 36 }, (_, i) => 'mot' + i).join(' ')],
    ['reponse vide', '']
  ]) {
    const w = await fresh(['Troll']);
    w.reply = out;
    await w.line('Troll', '@moi t es nul, desinstalle le jeu');
    check(label + ' : rien envoye', w.sent.length, 0);
    if (label === 'SKIP du modele') check('  statut : rien a repondre', w.status(), 'skip');
  }

  console.log('\n--- nettoyage de la replique ---');
  {
    const w = await fresh();
    const clean = w.run('cleanBaitLine');
    check('guillemets retires, le reste tel quel (aucun exemple de toi : on ne devine rien)', clean('"Tu forces."', 'x'), 'Tu forces.');
    check('  ni minuscules ni point final imposes', clean('Ok et. Tu parles tout seul.', 'x'), 'Ok et. Tu parles tout seul.');
    const before = w.run('myStyleBlock("")');
    check('  consigne d humour, pas de style invente', /humour/.test(before) && /aucun tic invente/.test(before) && !/minuscules|mec du chat/.test(before), true);
    const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
    check('  le champ du popup est supprime', /id="myStyle"/.test(html), false);
    check('@ du modele retire (ajoute a l envoi)', clean('@Troll ca va aller', 'x'), 'ca va aller');
    check('style vide + consigne : tel quel', w.run('styleFit')('Déjà vu, frère.', null), 'Déjà vu, frère.');
    check('derniere ligne gardee', clean('hmm\nparle moins', 'x'), 'parle moins');
    check('JSON {t} lu', clean('{"t":"ca va aller"}', 'x'), 'ca va aller');
    check('JSON {skip} : rien', clean('{"skip":true}', 'x'), '');
    check('ne repete pas sa phrase', clean('desinstalle le jeu', '@moi t es nul, desinstalle le jeu'), '');
  }

  console.log('\n--- plafonds ---');
  {
    const w = await fresh(['Troll', 'Relou']);
    w.run('baitHour(); baitMem.sends = HAND.SEND_MAX;');
    await w.line('Troll', '@moi t es nul');
    check('30 envois dans l heure : plus rien', [w.calls.length, w.status()], [0, 'cap']);
    w.run('baitMem.sends = 0; baitMem.calls = HAND.CALL_MAX;');
    await w.line('Troll', '@moi toujours nul');
    check('40 appels dans l heure : plus rien', w.calls.length, 0);
    w.run('baitMem.hourAt = Date.now() - HAND.HOUR_MS');
    await w.line('Troll', '@moi encore nul');
    check('  l heure suivante : ca repart', w.calls.length, 1);
    // La 3e ligne (b3) est celle qui est partie a Grok : on la renvoie telle quelle.
    await w.send({ type: 'CSG_CAPTURE', id: 'b3-Troll', author: 'Troll', text: '@moi encore nul', channel: 'kick/x' }, CHAT);
    await settle();
    check('meme ligne recue deux fois : un seul appel', w.calls.length, 1);
    w.run('HAND.GAP_MS = 60000');
    await w.line('Troll', '@moi trop vite');
    check('jamais deux repliques a la meme personne en 8 s', w.calls.length, 1);
    w.run('HAND.GAP_MS = 0; baitTargets.troll.sentAt = 0; scheduleBait("troll", 0)');
    await settle();
    check('  une fois l ecart passe : elle part', w.calls.length, 2);
  }

  console.log('\n--- erreurs ---');
  {
    const w = await fresh(['Troll', 'Relou']);
    w.store.csg_engine = {};
    await w.line('Troll', '@moi t es nul');
    check('SuperGrok deconnecte : aucun appel', w.calls.length, 0);
    check('  et le popup le dit', [w.status(), w.run('baitStatus.detail')], ['err', 'SuperGrok deconnecte']);

    w.store.csg_engine = { xaiOAuth: OAUTH };
    w.reply = new Error('llm_http_429 rate limit');
    await w.line('Troll', '@moi t es nul encore');
    check('429 : statut quota', [w.status(), w.run('baitStatus.detail')], ['err', 'quota, pause']);
    w.reply = 'ok et';
    await w.line('Relou', '@moi t es nul');
    check('  pause d une minute : pas de nouvel appel', w.calls.length, 1);

    const w2 = await fresh(['Troll']);
    w2.tabReply = { ok: false, err: 'tu ecrivais' };
    await w2.line('Troll', '@moi t es nul');
    check('tu ecrivais : statut attente, rien compte', [w2.status(), w2.run('baitMem.sends')], ['wait', 0]);

    const w3 = await fresh(['Troll']);
    w3.run('applySettings')({ simulation: true });
    await w3.line('Troll', '@moi t es nul');
    check('ancien reglage simulation : ignore, ca part', [w3.calls.length, w3.sent.length], [1, 1]);
  }

  console.log('\n--- reprendre la main pendant qu il reflechit ---');
  {
    const w = await fresh(['Troll']);
    let answer;
    w.reply = (signal) =>
      new Promise((resolve, reject) => {
        answer = () => resolve({ choices: [{ message: { content: 'ok et' } }] });
        signal.addEventListener('abort', () => reject(new Error('AbortError: aborted')));
      });
    await w.line('Troll', '@moi t es nul');
    check('Grok reflechit', w.status(), 'think');
    await w.hand('Troll', false);
    if (answer) answer();
    await settle();
    check('  rien n est envoye', w.sent.length, 0);
    check('  statut coupe', w.status(), 'off');

    // Reponse qui arrive malgre l'annulation (passerelle qui l'ignore).
    const w2 = await fresh(['Troll']);
    let late;
    w2.reply = () => new Promise((resolve) => (late = () => resolve({ choices: [{ message: { content: 'ok et' } }] })));
    await w2.line('Troll', '@moi t es nul');
    await w2.hand('Troll', false);
    if (late) late();
    await settle();
    check('  reponse tardive apres reprise : jetee', w2.sent.length, 0);
  }

  console.log('\n--- relance et oubli ---');
  {
    const w = await fresh(['Troll']);
    await w.line('Troll', '@moi t es nul');
    const w2 = boot(w.store);
    await settle();
    check('Troll toujours confie apres relance', Object.keys(w2.run('baitTargets')), ['troll']);
    check('  avec son fil', w2.run('baitTargets.troll.thread.length'), 2);
    w2.run('baitTargets.troll.lastAt = Date.now() - HAND.IDLE_MS');
    await w2.line('Troll', '@moi re');
    check('une heure sans un mot : rendu, rien ne part', [w2.calls.length, 'troll' in w2.store.csg_hand], [0, false]);
    const old = { csg_engine: { xaiOAuth: OAUTH }, csg_hand: { vieux: { name: 'Vieux', channel: 'kick/x', at: 1, lastAt: 1, thread: [] } } };
    const w3 = boot(old);
    await settle();
    check('fiche perimee au demarrage : oubliee', w3.store.csg_hand, {});
  }

  console.log('\n--- bouton G d une ligne : Grok repond a ce message ---');
  {
    const w = await fresh();
    const g = (extra, sender) => w.send(Object.assign({ type: 'CSG_GROK_REPLY', id: 'L1', author: 'Bob', text: 't as vu le clutch', channel: 'kick/x' }, extra || {}), sender || CHAT);
    w.run('recentChat.push({ a: "Zed", t: "quelle manche", channel: "kick/x" })');
    check('clic : envoye, la replique revient au bouton', await g(), { ok: true, line: 'ok et' });
    check('  personne n a ete confie pour autant', w.run('Object.keys(baitTargets)'), []);
    const c = w.calls[0] || { body: {} };
    check('  grok-4.7, reflexion high, 90 s', [c.body.model, c.body.reasoning_effort, c.ms], ['grok-4.7', 'high', 90000]);
    const user = ((c.body.messages || []).slice(-1)[0] || {}).content || '';
    check('  il ecrit en ton nom, a ce message', /Tu es moi\. Tu reponds au message de Bob, en tant que viewer/.test(user), true);
    check('  le message et le chat autour', /t as vu le clutch/.test(user) && /quelle manche/.test(user), true);
    check('  tu as clique : pas de SKIP', /Pas de SKIP/.test(user), true);
    check('  reponse native a sa ligne', w.sent[0] && [w.sent[0].msg.text, w.sent[0].msg.replyToId, w.sent[0].msg.author, w.sent[0].opts.frameId], ['ok et', 'L1', 'Bob', 3]);
    check('  compte dans les plafonds', w.run('[baitMem.calls, baitMem.sends]'), [1, 1]);
    check('une page web ne peut pas le declencher', await g({}, { tab: { id: 9, url: 'https://evil.example/' } }), 'SANS REPONSE');
    check('ta propre ligne : refuse', (await g({ id: 'L2', author: 'moi' })).ok, false);
    w.reply = 'SKIP';
    check('rien de naturel : le bouton le dit', (await g({ id: 'L3' })).ok, false);
    check('  rien envoye', w.sent.length, 1);
    w.reply = 'ok et';
    w.tabReply = { ok: false, err: 'tu ecrivais' };
    check('tu ecrivais : pas envoye', await g({ id: 'L4' }), { ok: false, err: 'tu ecrivais' });
    check('  rien compte', w.run('baitMem.sends'), 1);
    w.tabReply = { ok: true };
    w.run('baitMem.sends = HAND.SEND_MAX');
    check('plafond de l heure : refuse sans appel', [(await g({ id: 'L5' })).ok, w.calls.length], [false, 3]);
    w.run('baitMem.sends = 0');
    w.store.csg_engine = {};
    check('SuperGrok deconnecte', await g({ id: 'L6' }), { ok: false, err: 'SuperGrok deconnecte' });
    w.store.csg_engine = { xaiOAuth: OAUTH };
    w.run('applySettings')({ simulation: true });
    check('ancien reglage simulation : ignore, ca part', [(await g({ id: 'L7' })).ok, w.calls.length], [true, 4]);
  }

  console.log('\n--- pas de capture de style personnel ---');
  {
    const w = await fresh();
    w.run('MINE.SAVE_MS = 0');
    const mine = (text, sender) => w.send({ type: 'CSG_MY_LINE', text, channel: 'kick/x' }, sender || CHAT);
    await mine('wsh jsp frr');
    await mine('wsh jsp frr');
    await mine('@bob mdr t es serieux');
    await mine('x');
    await mine('pas moi', { tab: { id: 9, url: 'https://evil.example/' } });
    await settle();
    check('tes lignes ne sont pas collectees', w.run('myLines.length'), 0);
    check('  rien sur disque', (w.store.csg_my_lines || []).length, 0);

    const r = await w.send({ type: 'CSG_GROK_REPLY', id: 'S1', author: 'Bob', text: 'tu joues quoi', channel: 'kick/x' }, CHAT);
    check('  une replique est partie', r && r.ok, true);
    const user = ((w.calls[0] && w.calls[0].body.messages.slice(-1)[0]) || {}).content || '';
    check('aucun message personnel dans la demande', !/- wsh jsp frr/.test(user) && !/Mesures sur ses messages/.test(user), true);
    check('consigne de style : humour, aucun tic invente', /humour/.test(user) && /aucun tic invente/.test(user), true);

    const clean = w.run('cleanBaitLine');
    check('replique nettoyee', clean('Tu forces.', 'x'), 'Tu forces.');

    const w2 = boot(w.store);
    await settle();
    check('aucune ligne restauree a la relance', w2.run('myLines.length'), 0);
  }

  console.log('\n--- long fil : il relit tout ce que la personne a dit avant ---');
  {
    const w = await fresh();
    w.run('MINE.SAVE_MS = 0; FIL.SAVE_MS = 0');
    const cap = async (author, text, extra) => {
      await w.send(Object.assign({ type: 'CSG_CAPTURE', id: 'f-' + author + '-' + text.replace(/\W+/g, ''), author, text, channel: 'kick/x' }, extra || {}), CHAT);
    };
    const mine = (text, to) => w.send({ type: 'CSG_MY_LINE', text, to, channel: 'kick/x' }, CHAT);
    const ask = (text, id) => w.send({ type: 'CSG_GROK_REPLY', id: id || 'F9', author: 'Bob', text, channel: 'kick/x' }, CHAT);
    const promptOf = (i) => ((w.calls[i] && w.calls[i].body.messages.slice(-1)[0]) || {}).content || '';
    const pause = () => new Promise((r) => setTimeout(r, 3));

    // Un long fil : Bob, toi, Bob... plus un autre qui parle à côté et un autre salon.
    await cap('Bob', 'apex est washed');
    await cap('Zed', 'quelle manche');
    await pause();
    await mine('nan il est juste en forme', 'Bob');
    await pause();
    await cap('Bob', 'en forme lol il a 0.8 de kd', { replyTo: 'moi', replyQuote: 'nan il est juste en forme' });
    await cap('Bob', 'meme pas sur lan', { channel: 'kick/y' });
    await pause();
    await cap('Bob', 'et il a rate la finale');

    const r1 = await ask('et il a rate la finale');
    check('clic : envoye', r1 && r1.ok, true);
    const p1 = promptOf(0);
    const th = p1.slice(p1.indexOf('Fil complet'), p1.indexOf('Message de Bob'));
    const at = (s) => th.indexOf(s);
    check('fil complet avec Bob dans la demande', /Fil complet avec Bob/.test(p1), true);
    check('  ses messages d avant, dans l ordre', at('apex est washed') > -1 && at('apex est washed') < at('en forme lol il a 0.8 de kd'), true);
    check('  la citation de ses reponses', /en forme lol il a 0\.8 de kd\s+\(en reponse a : "nan il est juste en forme"\)/.test(p1), true);
    check('  pas ce que dit un autre', /\[Zed\][^\n]*\n/.test(p1.slice(p1.indexOf('Fil complet'), p1.indexOf('Message de Bob'))), false);
    check('  pas un autre salon', /meme pas sur lan/.test(p1), false);
    check('  la ligne cliquee n est pas repetee dans le fil', th.split('et il a rate la finale').length - 1, 0);
    check('  consigne : relire tout le fil, rester coherent', /Relis le fil fourni/.test((w.calls[0].body.messages[0] || {}).content || ''), true);

    // Ce que Grok a répondu fait partie du fil, à sa place.
    await cap('Bob', 'et ton avis sur ropz');
    await ask('et ton avis sur ropz', 'F10');
    const p2 = promptOf(1);
    check('la reponse precedente de Grok est dans le fil', /\[moi \(toi\)\] ok et/.test(p2), true);
    check('  apres ses anciens messages', p2.indexOf('apex est washed') < p2.indexOf('[moi (toi)] ok et'), true);

    // Chaque source seule suffit : le journal (ftLog) sans la fenetre glissante ni le suivi.
    const w0 = await fresh();
    for (const x of ['un', 'deux', 'trois']) await w0.send({ type: 'CSG_CAPTURE', id: 'j-' + x, author: 'Bob', text: 'ligne ' + x, channel: 'kick/x' }, CHAT);
    w0.run('recentChat.length = 0; authorHistory.clear()');
    await w0.send({ type: 'CSG_GROK_REPLY', id: 'J', author: 'Bob', text: 'ligne quatre', channel: 'kick/x' }, CHAT);
    const pj = ((w0.calls[0] && w0.calls[0].body.messages.slice(-1)[0]) || {}).content || '';
    check('journal seul : ses lignes d avant sont relues', ['ligne un', 'ligne deux', 'ligne trois'].every((s) => pj.indexOf(s) !== -1), true);

    // Le journal tourne : le suivi de Bob garde ses lignes depuis ta réponse.
    w.run('ftLog.length = 0; recentChat.length = 0; authorHistory.clear()');
    await cap('Bob', 'attends ecoute');
    await cap('Bob', 'ropz est meilleur que lui');
    w.run('ftLog.length = 0; recentChat.length = 0; authorHistory.clear()');
    await ask('ropz est meilleur que lui', 'F11');
    const p3 = promptOf(2);
    check('journal vide : ses lignes suivies restent', /attends ecoute/.test(p3), true);
    check('  et les reponses de Grok dans le fil', /\[moi \(toi\)\] ok et/.test(p3), true);

    // Une relance ne perd rien.
    const w2 = boot(w.store);
    await settle();
    check('relance : le suivi de Bob est relu', w2.run('convo.bob.msgs.length') > 0, true);
    check('  et ce que Grok lui a dit', w2.run('baitMem.sent.length'), 3);

    // Beaucoup de messages : les plus récents, et il sait qu'il y en a d'autres.
    const w3 = await fresh();
    for (let i = 0; i < 75; i++) await w3.send({ type: 'CSG_CAPTURE', id: 'n' + i, author: 'Bob', text: 'message numero ' + i, channel: 'kick/x' }, CHAT);
    await w3.send({ type: 'CSG_GROK_REPLY', id: 'N', author: 'Bob', text: 'dernier mot', channel: 'kick/x' }, CHAT);
    const p4 = ((w3.calls[0] && w3.calls[0].body.messages.slice(-1)[0]) || {}).content || '';
    check('75 messages : les 60 plus recents', [/message numero 74/.test(p4), /message numero 15(?!\d)/.test(p4), /message numero 14(?!\d)/.test(p4)], [true, true, false]);
    check('  et il sait que d autres sont plus anciens', /15 messages plus anciens non montres/.test(p4), true);

    // Plus de 5 personnes suivies : la plus ancienne est oubliée.
    const w4 = await fresh();
    w4.run('MINE.SAVE_MS = 0; FIL.SAVE_MS = 0');
    for (const n of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
      await w4.send({ type: 'CSG_MY_LINE', text: 'salut ' + n + ' toi', to: n, channel: 'kick/x' }, CHAT);
      await new Promise((r) => setTimeout(r, 2));
    }
    check('5 personnes suivies au plus', w4.run('Object.keys(convo).sort()'), ['p2', 'p3', 'p4', 'p5', 'p6']);
    check('  toi-meme jamais', w4.run('(trackConvo("moi", "kick/x"), "moi" in convo)'), false);
  }

  console.log('\n--- garde-fous dans le source ---');
  const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const bait = src.slice(src.indexOf('async function runBait'), src.indexOf('const CHAT_MSG'));
  check('runBait ne mute personne', /addMute\(|setMute|CSG_LOCAL_MUTE/.test(bait), false);
  const chatMsg = src.slice(src.indexOf('const CHAT_MSG'), src.indexOf('};', src.indexOf('const CHAT_MSG')));
  check('le clic vient du chat (CHAT_MSG)', /CSG_HAND_SET/.test(chatMsg), true);
  const dualMsg = src.slice(src.indexOf('const DUAL_ORIGIN_MSG'), src.indexOf('};', src.indexOf('const DUAL_ORIGIN_MSG')));
  check('Arreter vient du popup ou du chat', /CSG_HAND_STOP/.test(dualMsg), true);
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  check('bouton sur la carte du viewer', /csg-hand-btn[\s\S]{0,200}onHandClick/.test(content) && /type: 'CSG_HAND_SET'/.test(content), true);
  check('content.js refuse un autre salon', /CSG_BAIT_SEND[\s\S]{0,400}autre salon/.test(content), true);
  const sendSource = content.slice(content.indexOf('function sendBaitLine'), content.indexOf('const onContentMessage'));
  check('content.js attend que tu aies fini d ecrire', /composerDraft\(el\)/.test(sendSource) && /tu ecrivais/.test(sendSource), true);
  check('le bouton G et tes lignes viennent du chat (CHAT_MSG)', /CSG_GROK_REPLY/.test(chatMsg) && /CSG_MY_LINE/.test(chatMsg), true);
  check('bouton G pose a cote de la fleche Repondre', /function addGrokBtn[\s\S]{0,900}\.chat-line__icons/.test(content) && /CSG_GROK_REPLY/.test(content) && /CSG_REPLY_DRAFT_REQUEST/.test(content), true);
  check('  les lignes a toi n en ont pas', /function addGrokBtn[\s\S]{0,300}isOwnMessage\(el\)\) return/.test(content), true);
  check('reponse native, sinon @pseudo', /\.chat-line__reply-icon button/.test(content) && /openNativeReply\([\s\S]{0,200}'@' \+ author/.test(content), true);
  check('tes lignes partent au fond (CSG_MY_LINE)', /function noteMine[\s\S]{0,600}CSG_MY_LINE/.test(content), true);
  const css = fs.readFileSync(path.join(ROOT, 'content.css'), 'utf8');
  check('libelle G hors du texte de la ligne (::before)', /\.csg-grok-btn::before\s*\{\s*content: 'G'/.test(css), true);
  check('champ Ma facon d ecrire retire du popup', /id="myStyle"/.test(fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8')), false);

  console.log(fails ? '\n' + fails + ' ECHEC(S)\n' : '\ntout est vert\n');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
