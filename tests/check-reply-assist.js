'use strict';

// Vrai worker MV3, reseau simule : brouillons seulement, jamais un envoi Twitch.
const fs = require('fs');
const path = require('path');
const assert = require('assert').strict;
const harness = fs.readFileSync(path.join(__dirname, 'check-bait.js'), 'utf8').split('(async () => {')[0];
const { boot, settle, OAUTH, PAGE } = new Function('require', '__dirname', harness + '\nreturn { boot, settle, OAUTH, PAGE };')(require, __dirname);
const CHAT = { tab: { id: 7, url: 'https://www.twitch.tv/streamer_fr' }, frameId: 3 };
let seq = 0;
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('  ok  ' + name); }
async function fresh(config) {
  const w = boot({ csg_engine: { xaiOAuth: OAUTH }, csg_reply_assist: config || {} });
  w.drafts = [];
  w.draftReply = { ok: true };
  w.readyReply = { ok: true };
  w.run('chrome.tabs.sendMessage = function(id,msg,opts,cb) { if(msg.type === "CSG_REPLY_DRAFT_READY") { if(cb)cb(__readyReply()); return; } if(msg.type === "CSG_REPLY_DRAFT") __draft(msg); else __send(id,msg,opts); if(cb) cb(__draftReply()); }');
  // The existing sandbox has no direct export; helpers enter through a function binding.
  w.run('globalThis.__draft = null; globalThis.__send = null; globalThis.__draftReply = null; globalThis.__readyReply = null');
  w.run('globalThis.__setDraftHooks = function(a,b,c,d) { __draft=a; __send=b; __draftReply=c; __readyReply=d; }')(
    (m) => w.drafts.push(JSON.parse(JSON.stringify(m))),
    (id, msg, opts) => { if (msg.type === 'CSG_BAIT_SEND') w.sent.push({ id, msg, opts }); },
    () => w.draftReply, () => w.readyReply);
  await settle();
  w.set = (patch, sender) => w.send(Object.assign({ type: 'CSG_REPLY_ASSIST_SET' }, patch), sender || PAGE);
  w.cap = async (extra, sender) => {
    const msg = Object.assign({ type: 'CSG_CAPTURE', id: 'draft-' + (++seq), author: 'Bob', text: '@moi joli clutch', channel: 'twitch/streamer_fr', ambienceEligible: true, capturedAt: Date.now() }, extra || {});
    await w.send(msg, sender || CHAT);
    await settle();
    return msg;
  };
  w.ask = (extra, sender) => w.send(Object.assign({ type: 'CSG_REPLY_DRAFT_REQUEST', id: 'manual-' + (++seq), author: 'Bob', text: 'joli clutch', channel: 'twitch/streamer_fr' }, extra || {}), sender || CHAT);
  return w;
}

(async () => {
  console.log('\n--- opt-in et origines ---');
  const off = await fresh();
  await off.cap();
  check('desactive par defaut, aucun appel', () => assert.equal(off.calls.length, 0));
  check('defaut explicite sans option de style', () => assert.deepEqual(JSON.parse(off.run('JSON.stringify(replyAssist)')), { enabled: false, learnStyle: false }));
  await off.set({ enabled: true }, CHAT);
  check('le chat ne peut pas activer le mode', () => assert.equal(off.run('replyAssist.enabled'), false));
  await off.set({ enabled: true }, { url: 'https://evil.example/' });
  check('une page web ne peut pas activer le mode', () => assert.equal(off.run('replyAssist.enabled'), false));
  const enabled = await off.set({ enabled: true });
  check('popup autorise, configuration persistee', () => assert.equal(enabled.ok && off.store.csg_reply_assist.enabled, true));
  const concurrent = await fresh();
  await Promise.all([concurrent.set({ enabled: true }), concurrent.set({ learnStyle: true })]);
  check('changements simultanes conservent les deux options', () => assert.deepEqual(concurrent.store.csg_reply_assist, { enabled: true, learnStyle: true }));
  const failedSave = await fresh();
  failedSave.run('globalThis.__saveBefore=chrome.storage.local.set; chrome.storage.local.set=function(o,cb) { if (o.csg_reply_assist) { chrome.runtime.lastError={message:"disk"}; if(cb)cb(); chrome.runtime.lastError=null; } else __saveBefore(o,cb); }');
  const failRes = await failedSave.set({ enabled: true });
  check('erreur storage refuse et restaure la configuration', () => { assert.equal(failRes.ok, false); assert.equal(failedSave.run('replyAssist.enabled'), false); });
  await off.ask({}, { url: 'https://evil.example/' });
  await off.send({ type: 'CSG_REPHRASE_DRAFT', text: 'mon texte' }, PAGE);
  check('generation et edition accessibles au chat seulement', () => assert.equal(off.calls.length, 0));

  console.log('\n--- captures fraiches et mentions strictes ---');
  const w = await fresh({ enabled: true });
  const line = await w.cap();
  check('une mention recue genere un brouillon', () => assert.equal(w.calls.length, 1));
  check('bon message de livraison, sans envoi', () => { assert.equal(w.drafts.length, 1); assert.equal(w.drafts[0].replyToId, line.id); assert.equal(w.drafts[0].text, 'ok et'); assert.equal(w.sent.length, 0); });
  await w.cap(line);
  check('replay ignore', () => assert.equal(w.calls.length, 1));
  const invalid = [
    { text: 'mention moi sans arobase' }, { text: '@moi2 ca va' }, { text: 'joli clutch', replyTo: 'Autre' },
    { author: 'moi' }, { ambienceEligible: false }, { capturedAt: Date.now() - 16000 },
    { capturedAt: Date.now() + 60000 }, { capturedAt: 0 }, { channel: 'twitch/autre' }, { channel: 'kick/streamer_fr' }, { id: '' }
  ];
  for (const item of invalid) await w.cap(item);
  await w.cap({}, { tab: { id: 7, url: 'https://evil.example/streamer_fr' } });
  check('rejets captures anciennes, futures, autres salons, soi et absence de mention', () => assert.equal(w.calls.length, 1));
  await w.cap({ text: 'joli clutch', replyTo: 'moi' });
  check('reponse native a soi admise', () => assert.equal(w.calls.length, 2));
  w.run('applySettings({enabled:false})');
  await w.cap();
  check('interrupteur general respecte', () => assert.equal(w.calls.length, 2));
  w.run('applySettings({enabled:true})');
  const reloaded = await fresh({ enabled: true });
  reloaded.store.csg_reply_draft_seen = w.store.csg_reply_draft_seen;
  reloaded.run('loadBaitState()');
  await settle();
  await reloaded.cap(line);
  check('replay reste ignore apres relecture disque', () => assert.equal(reloaded.calls.length, 0));
  const protectedReply = await fresh({ enabled: true });
  const archivedBefore = protectedReply.run('ftLog.length');
  await protectedReply.cap({ type: 'CSG_REPLY_ASSIST_CAPTURE', author: 'StreamerProtege' });
  check('reponse protegee atteint assistant sans archive de moderation', () => { assert.equal(protectedReply.calls.length, 1); assert.equal(protectedReply.drafts.length, 1); assert.equal(protectedReply.run('ftLog.length'), archivedBefore); assert.equal(protectedReply.sent.length, 0); });

  console.log('\n--- politique : information neutre, sans argumentaire cible ---');
  const pol = await fresh({ enabled: true });
  pol.reply = JSON.stringify({ kind: 'clarification', text: 'De quelles revendications parles-tu exactement ?' });
  await pol.cap({ text: '@moi les manifestations lyceennes et les casseurs' });
  check('politique utilise une seule generation neutre', () => assert.equal(pol.calls.length, 1));
  check('precision neutre proposee sans envoi en mode brouillons', () => { assert.equal(pol.drafts[0].text, 'De quelles revendications parles-tu exactement ?'); assert.equal(pol.sent.length, 0); });
  const manualPol = await pol.ask({ text: 'cette réforme et la politique' });
  check('clic politique propose aussi une precision neutre', () => assert.equal(manualPol.ok && manualPol.line.length > 0, true));
  check('accents et contexte ideologique reconnus', () => { assert.equal(pol.run('isPoliticalReply("ÉLECTIONS et députés")'), true); assert.equal(pol.run('isPoliticalReply("je suis de droite")'), true); assert.equal(pol.run('isPoliticalReply("pillages au PRADO et au stade VÉLODROME")'), true); });
  check('directions gaming et match de foot ne sont pas politiques', () => { assert.equal(pol.run('isPoliticalReply("gank à droite puis reviens")'), false); assert.equal(pol.run('isPoliticalReply("le match au Vélodrome est cool")'), false); });
  const old = await fresh();
  old.reply = JSON.stringify({ kind: 'fact', text: 'Une élection permet de choisir des représentants par un vote.' });
  await old.send({ type: 'CSG_GROK_REPLY', id: 'old-pol', author: 'Bob', text: 'parlons politique', channel: 'twitch/streamer_fr' }, CHAT);
  check('bouton direct autorise une information civique neutre', () => { assert.equal(old.calls.length, 1); assert.equal(old.sent.length, 1); });
  const output = await fresh({ enabled: true });
  output.reply = 'vote pour ce parti';
  await output.ask();
  check('sortie politique inattendue devient editeur vide', () => { assert.equal(output.drafts[0].political, true); assert.equal(output.drafts[0].text, ''); });

  console.log('\n--- contexte et fil du meme salon ---');
  const context = await fresh({ enabled: true });
  context.run('recentChat.push({a:"Autre",t:"CONTEXTE_AUTRE_SALON",channel:"twitch/autre"},{a:"Local",t:"CONTEXTE_SALON",channel:"twitch/streamer_fr"}); trackConvo("Bob","twitch/streamer_fr"); noteConvoCapture({author:"Bob",text:"ANCIENNE_LIGNE_DU_FIL",channel:"twitch/streamer_fr",id:"older"})');
  const whole = 'Debut du message. ' + 'Une explication complete. '.repeat(18) + 'FIN_IMPORTANTE_DU_MESSAGE';
  await context.ask({ text: whole, streamContext: { title: 'Le match', category: 'Jeux' } });
  const contextPrompt = context.calls[0].body.messages.slice(-1)[0].content;
  check('salon, fin du message et fil transmis', () => { assert.ok(contextPrompt.includes('chat Twitch de streamer_fr')); assert.ok(contextPrompt.includes(whole)); assert.ok(contextPrompt.includes('ANCIENNE_LIGNE_DU_FIL')); assert.ok(contextPrompt.includes('Le match')); });
  check('aucun contexte du salon voisin', () => { assert.ok(contextPrompt.includes('CONTEXTE_SALON')); assert.ok(!contextPrompt.includes('CONTEXTE_AUTRE_SALON')); });

  console.log('\n--- ancienne automatisation suspendue en mode brouillons ---');
  const targeted = await fresh({ enabled: true });
  await targeted.send({ type: 'CSG_HAND_SET', name: 'Bob', on: true, channel: 'twitch/streamer_fr' }, CHAT);
  await targeted.cap();
  check('personne deja confiee produit un seul brouillon', () => { assert.equal(targeted.calls.length, 1); assert.equal(targeted.drafts.length, 1); assert.equal(targeted.sent.length, 0); });
  await targeted.send({ type: 'CSG_GROK_REPLY', id: 'legacy', author: 'Bob', text: 'joli clutch', channel: 'twitch/streamer_fr' }, CHAT);
  check('ancien client G redirige vers le brouillon', () => { assert.equal(targeted.drafts.length, 2); assert.equal(targeted.sent.length, 0); });

  console.log('\n--- concurrence, arret et plafonds ---');
  const slow = await fresh({ enabled: true });
  let release;
  slow.reply = () => new Promise((resolve) => { release = () => resolve({ choices: [{ message: { content: 'joli timing' } }] }); });
  await slow.cap();
  await slow.cap();
  check('un seul appel a la fois', () => assert.equal(slow.calls.length, 1));
  await slow.set({ enabled: false });
  release();
  await settle();
  check('arret pendant generation annule la livraison', () => { assert.equal(slow.drafts.length, 0); assert.equal(slow.sent.length, 0); });
  const capped = await fresh({ enabled: true });
  capped.run('baitHour(); baitMem.calls = HAND.CALL_MAX');
  const capRes = await capped.ask();
  check('plafond d appels respecte', () => { assert.equal(capRes.ok, false); assert.equal(capped.calls.length, 0); });
  const refused = await fresh({ enabled: true });
  refused.draftReply = { ok: false, err: 'un brouillon est deja ouvert' };
  const refusedRes = await refused.ask();
  check('refus du panneau remonte au demandeur', () => assert.equal(refusedRes.err, 'un brouillon est deja ouvert'));
  const occupied = await fresh({ enabled: true });
  occupied.readyReply = { ok: false, err: 'un brouillon est deja ouvert' };
  const occupiedRes = await occupied.ask();
  check('panneau occupe : aucun appel modele avant refus', () => { assert.equal(occupiedRes.ok, false); assert.equal(occupied.calls.length, 0); assert.equal(occupied.drafts.length, 0); });

  console.log('\n--- edition isolee du texte personnel ---');
  const edit = await fresh({ enabled: true });
  edit.run('recentChat.push({a:"Bob",t:"CONTEXTE_ADVERSAIRE_SECRET",channel:"twitch/streamer_fr"})');
  edit.reply = 'Je condamne ces dégradations tout en distinguant les manifestants.';
  const source = 'Je condamne les degradations mais je distingue les manifestants.';
  const result = await edit.send({ type: 'CSG_REPHRASE_DRAFT', text: source, author: 'Bob', replyQuote: 'ARGUMENT_A_NE_PAS_TRANSMETTRE' }, CHAT);
  const req = edit.calls[0].body.messages;
  check('politique permise en edition fidele', () => assert.equal(result.ok, true));
  check('seul le texte fourni et les mesures de forme sont transmis', () => { const user = req[req.length - 1].content; assert.ok(user.includes(source)); assert.ok(!user.includes('Bob')); assert.ok(!user.includes('CONTEXTE_ADVERSAIRE_SECRET')); assert.ok(!user.includes('ARGUMENT_A_NE_PAS_TRANSMETTRE')); });
  check('prompt interdit ajout et persuasion ciblee', () => { assert.match(req[0].content, /N'ajoute aucun argument/); assert.match(req[0].content, /aucun contexte d'interlocuteur/i); assert.match(req[0].content, /accusation personnelle non etayee/); });
  check('reformulation ne livre ni panneau ni envoi', () => { assert.equal(edit.drafts.length, 0); assert.equal(edit.sent.length, 0); });
  const tooLong = await edit.send({ type: 'CSG_REPHRASE_DRAFT', text: 'x'.repeat(501) }, CHAT);
  check('limite 500 caracteres avant appel', () => { assert.equal(tooLong.ok, false); assert.equal(edit.calls.length, 1); });

  console.log('\n--- style sur option, statistiques seules ---');
  const style = await fresh({ enabled: true });
  style.run('MINE.SAVE_MS = 0');
  const mine = (text) => style.send({ type: 'CSG_MY_LINE', text, channel: 'twitch/streamer_fr' }, CHAT);
  await mine('message personnel non collecte');
  check('style coupe : aucune collecte', () => assert.equal(style.run('myLines.length'), 0));
  await style.set({ learnStyle: true });
  for (let i = 0; i < 7; i++) await mine('@Bob exemple personnel ' + i);
  check('moins de huit exemples : aucune injection', () => assert.equal(style.run('myStyleStats()'), null));
  await mine('@Bob exemple personnel sept');
  await mine('je suis de droite et je vote');
  style.run('noteGrokOut("replique deja generee")');
  await mine('replique deja generee');
  await mine('@Bob exemple personnel sept');
  await settle();
  check('seuil, doublons, politique et sorties Grok exclus', () => assert.equal(style.run('myLines.length'), 8));
  check('mentions retirees des exemples', () => assert.equal(style.run('myLines.some(m => /@/.test(m.t))'), false));
  check('statistiques publiees', () => assert.equal(style.store.csg_reply_style_stats.count, 8));
  const stylePrompt = style.run('myStyleBlock()');
  check('statistiques injectees sans exemples bruts', () => { assert.match(stylePrompt, /Mesures de forme uniquement/); assert.ok(!stylePrompt.includes('exemple personnel')); });
  await style.ask();
  check('les exemples de style ne fuient pas via le fil', () => assert.ok(!style.calls[0].body.messages.slice(-1)[0].content.includes('exemple personnel')));
  const saved = style.store.csg_my_lines;
  check('persistance bornee et nettoyee', () => { assert.equal(saved.length, 8); assert.ok(saved.every((m) => m.t.length <= 500)); });
  await style.set({ learnStyle: false });
  await mine('autre texte apres arret');
  check('couper conserve les donnees et cesse injection', () => { assert.equal(style.run('myLines.length'), 8); assert.equal(style.run('myStyleStats()'), null); });
  style.run('loadBaitState()');
  await settle();
  check('relance conserve les donnees meme option coupee', () => { assert.equal(style.run('myLines.length'), 8); assert.equal(style.run('myStyleStats()'), null); });
  await style.set({ learnStyle: true });
  check('reactivation retrouve les mesures', () => assert.equal(style.run('myStyleStats().count'), 8));
  check('adaptation deterministe seulement apres seuil', () => assert.equal(style.run('styleFit("TU FORCES.", myStyleStats())'), 'tu forces'));
  style.run('MINE.SAVE_MS = 60000');
  for (let i = 0; i < 410; i++) style.run('noteMyLine')('nouveau texte ' + i, 'twitch/streamer_fr');
  style.run('flushPendingState()');
  check('400 exemples au plus et flush au suspend', () => assert.equal(style.store.csg_my_lines.length, 400));

  console.log('\n' + checks + ' controles valides\n');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
