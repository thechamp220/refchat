'use strict';

// Objectif (2026-09-13) : un auteur flag est MUTE, on ne le revoit plus — sur
// une ligne nette ou sur l'ensemble de plusieurs lignes limites. Le message
// s'affiche pendant l'attente Google ; le flag mute tout de suite, sans
// confirmation 1.3. Le raisonnement des modeles reste coupe.
//
// Trois trous mesures avant ce fichier :
//  - un flag definitif du rapide (1.3 deja passe, ou sa file pleine) masquait
//    la ligne SANS muter l'auteur : il revenait au message suivant ;
//  - le profileur « plusieurs messages » demandait effort 'low' dans 352 tokens
//    a Muse Spark : 5 profils sur 6 revenaient coupes, zero verdict, zero mute ;
//  - le portillon Go comptait son attente dans la latence (popup : 225941 ms)
//    et le chien de garde de 14 s relancait des lots encore en attente.

const { bench, booted, tick, wait, E, X, GROK, lane, seed, pump, checker, setSettings } = require('./bench');

const T = checker();
const check = T.check;

const settle = async () => {
  for (let i = 0; i < 12; i++) await tick();
};
const DEEP = [];
const ENGINE = { csg_engine: X };
// Depuis la 3.22.0, UN SEUL modele juge : il faut le choisir AVANT que le worker
// demarre. Le chargement des reglages (loadPunishTarget) prend sa copie de la
// zone sync au tout debut ; un applySettings pose apres coup est efface une
// frame plus tard, sans un mot. D'ou le reglage passe a bench().
const only = (id, extra) => ({
  sync: { csg_settings: Object.assign({ judge: true, enabled: true, lane: id }, extra || {}) }
});

function closeLanes(b, ids) {
  const until = b.run('Date.now()') + 3600000;
  for (const id of ids) b.run('modelSkipUntil')[id] = until;
}
function openOnly(b, ids) {
  closeLanes(b, b.run('CHAIN').map((l) => l.id).filter((id) => ids.indexOf(id) === -1));
}
const item = (b, a, t, extra) => Object.assign({ a, t, id: a + '-' + Math.random().toString(36).slice(2, 7), ts: b.run('Date.now()'), channel: 'sim' }, extra || {});
const muted = (b, who) => !!b.run('mutedUsers')[who];

// Le banc « unref » ses minuteries : sans cette attache, Node sortirait en
// silence pendant qu'un appel attend au portillon, avant d'avoir tout verifie.
// Et un portillon qui ne rend jamais la main doit echouer, pas bloquer.
setTimeout(() => {
  console.log(' FAIL delai global depasse : un appel attend sans fin');
  process.exit(1);
}, 60000);

(async () => {
  console.log('\n=== check-mute : un auteur flag est mute ===');

  // ------------------------------------------------ flag net, 1.3 indisponible
  console.log('\n--- un flag du rapide, 1.3 ferme : l auteur est mute sur le coup ---');
  {
    const b = bench(ENGINE, only(GROK));
    await booted(b);
    await settle();
    b.run('engineCache = ' + JSON.stringify(X));
    closeLanes(b, DEEP);
    seed(b, 3, (i) => (i === 1 ? 'toxique' : 'ligne propre ' + i), (i) => (i === 1 ? 'troll' : 'viewer' + i));
    await pump(b, 50, X);
    await settle();
    check('troll mute', muted(b, 'troll'), true);
    check('personne d autre', Object.keys(b.run('mutedUsers')), ['troll']);
  }

  // ---------------------------------------- flag net, 1.3 ouvert : plus d'attente
  console.log('\n--- 1.3 ouvert : le flag du rapide mute tout de suite ---');
  {
    const b = bench(ENGINE);
    await booted(b);
    await settle();
    b.run('engineCache = ' + JSON.stringify(X));
    const fast = lane(b, GROK);
    await b.run('runLaneJob')(X, fast, [item(b, 'troll', 'toxique')]);
    await settle();
    check('troll mute sans attendre 1.3', muted(b, 'troll'), true);
    check('rien n attend 1.3', b.run('auditQueue').filter((x) => x.esc).length, 0);
  }

  // ---------------------------------------- le trou : verdict definitif du rapide
  console.log('\n--- verdict definitif du rapide (file 1.3 pleine, ou deja confirme) : MUTE ---');
  {
    const b = bench();
    await booted(b);
    b.run('engineCache = ' + JSON.stringify(E));
    const now = b.run('Date.now()');
    const q = b.run('auditQueue');
    const max = b.run('ESC.MAX_Q');
    for (let i = 0; i < max; i++) q.push({ a: 'x' + i, t: 'en attente', id: 'd' + i, tier: 'deep', esc: 1, ts: now });
    const fast = lane(b, 'glm-4.5-flash');
    const tox = b.run('verdictBit')(true);
    b.run('applyItemVerdict')(item(b, 'troll', 'toxique'), tox, 0.4, 5, fast);
    b.run('applyItemVerdict')(item(b, 'recidive', 'toxique', { esc: 1, fastScore: 0.94 }), tox, 0.4, 5, fast);
    await settle();
    check('file 1.3 pleine : l auteur est mute quand meme', muted(b, 'troll'), true);
    check('ligne deja confirmee une fois : mute aussi', muted(b, 'recidive'), true);
    check('rien de plus n a ete escalade', q.filter((x) => x.esc).length, max);
  }

  // ------------------------------------------------------- ne plus le revoir
  console.log('\n--- un auteur mute ne coute plus un appel ---');
  {
    const b = bench();
    seed(b, 4, (i) => 'ligne ' + i, (i) => (i % 2 ? 'troll' : 'viewer' + i));
    b.run('mutedUsers').troll = { at: b.run('Date.now()') };
    const batch = b.run('takeAuditBatch')(lane(b, 'glm-4.5-flash'));
    check('aucune ligne du mute ne part au modele', batch.some((x) => x.a === 'troll'), false);
    check('ses 2 lignes en file sont retirees', b.run('droppedCount'), 2);
  }

  // --------------------------------------------------- sur plusieurs messages
  // --------------------------------------------------- live : insulte nette
  console.log('\n--- flag du rapide mute, meme si 1.3 aurait blanchi ---');
  {
    const b = bench(ENGINE);
    b.run('engineCache = ' + JSON.stringify(E));
    b.api.verdict = (id, line) => (DEEP.indexOf(id) !== -1 ? false : /toxique/.test(line));
    const fast = lane(b, GROK);
    await b.run('runLaneJob')(X, fast, [item(b, 'limite', 'toxique')]);
    await settle();
    check('mute sur le flag du rapide', muted(b, 'limite'), true);
    check('1.3 n a rien a confirmer', b.run('auditQueue').filter((x) => x.esc).length, 0);
  }

  console.log('\n--- le profil auteur ne part plus tout seul ---');
  {
    const b = bench(ENGINE);
    b.run('engineCache = ' + JSON.stringify(E));
    b.api.author = () => 'toxic';
    const track = (who, t) => b.run('trackAuthor')(who, t, { ts: b.run('Date.now()') });
    track('suspect', 'zywoo overrated');
    b.run('noteBorderline')('suspect');
    await wait(250);
    await settle();
    check('1 seul message : pas de profil', b.api.authorCalls.length, 0);
    track('suspect', 'il sert a quoi lui');
    track('normal', 'rotate B');
    track('normal', 'gg wp');
    await wait(250);
    await settle();
    check('le 2e message ne lance plus le profil', b.api.authorCalls.length, 0);
    check('  personne mutee toute seule', muted(b, 'suspect'), false);
  }

  // ------------------------------------------------------ le profileur lit enfin
  console.log('\n--- profileur : raisonnement coupe, JSON court ---');
  {
    const b = bench(ENGINE, only('glm-4.5-flash'));
    b.api.author = () => 'toxic';
    openOnly(b, [GROK]);
    b.run('authorHistory').set('rageux', { msgs: [1, 2, 3, 4].map((i) => ({ t: 'm' + i, ts: b.run('Date.now()'), id: 'k' + i })), lastCheck: 0 });
    await b.run('runAuthorCheck')('rageux', undefined, '', { force: true });
    await settle();
    const c = b.api.authorCalls[0] || {};
    check('lane chat : reflexion basse', c.effort, 'low');
    check('  budget pour reflechir puis le JSON', c.maxOut, 64 + 1000 + 4 * 40);
    check('  rageux mute', muted(b, 'rageux'), true);
  }
  {
    const b = bench(ENGINE, only('glm-4.5-flash'));
    b.api.author = () => 'reasoning';
    openOnly(b, [GROK]);
    b.run('authorHistory').set('flou', { msgs: [1, 2, 3, 4].map((i) => ({ t: 'm' + i, ts: b.run('Date.now()'), id: 'f' + i })), lastCheck: 0 });
    await b.run('runAuthorCheck')('flou', undefined, '', { force: true });
    await settle();
    check('reponse coupee : personne n est mute sur du vide', muted(b, 'flou'), false);
  }

  // ------------------------------------------ les profils ne volent plus le portillon
  // Rejeu de salon_kick (Kick, 5,6 msg/s, ~200 auteurs qui repetent) : un
  // profil par auteur tenait les deux places du portillon Go, les lots expiraient
  // en 'go_gate' et plus aucune ligne n'etait jugee (file 178, 424 « en attente »).
  console.log('\n--- bouton : le profil part seulement a la demande ---');
  {
    const b = bench(ENGINE, only('glm-4.5-flash'));
    b.run('engineCache = ' + JSON.stringify(E));
    b.api.author = () => 'keep';
    openOnly(b, [GROK]);
    const track = (who, t) => b.run('trackAuthor')(who, t, { ts: b.run('Date.now()') });
    for (const who of ['a1', 'a2', 'a3']) for (let i = 0; i < 4; i++) track(who, who + ' spam ' + i);
    await wait(800);
    await settle();
    check('aucun profil automatique', b.api.authorCalls.length, 0);

    seed(b, b.run('AUDIT.HOLD_MAX'), (i) => 'ligne ' + i);
    for (let i = 0; i < 4; i++) track('spammeur', 'spam ' + i);
    await wait(400);
    await settle();
    check('lot en file : toujours rien tout seul', b.api.authorCalls.length, 0);
    b.run('auditQueue.length = 0');
    await b.run("runAuthorCheck('spammeur', 4, '', { force: true })");
    await settle();
    check('bouton : le profil part', b.api.authorCalls.map((c) => c.author), ['spammeur']);
  }

  // --------------------------------------------------------- chien de garde
  console.log('\n--- chien de garde : il ne tue plus un lot sain ---');
  {
    const b = bench();
    await booted(b);
    const ms = (l) => b.run('laneMs')(l);
    const staleMs = (l) => b.run('jobStaleMs')({ lane: l });
    const all = b.run('CHAIN');
    check('au-dela de portillon + appel, pour chaque lane', all.every((l) => staleMs(l) > 2 * ms(l)), true);
    const jobs = b.run('inflightJobs');
    const spec = lane(b, 'glm-4.5-flash');
    jobs.set('j1', { lane: spec, batch: [], startedAt: b.run('Date.now()') - 20000, jobId: 'j1' });
    await b.run('pumpAudit')();
    check('lot de 20 s sur une lane de ' + ms(spec) / 1000 + ' s : toujours en vol', jobs.has('j1'), true);
    jobs.get('j1').startedAt = b.run('Date.now()') - staleMs(spec) - 1000;
    await b.run('pumpAudit')();
    check('jugement coupe : aucun watchdog live ne tourne', jobs.has('j1'), true);
  }

  // ----------------------------------------------------- delais vs mesures
  console.log('\n--- delais : au moins 1,5x le pic mesure le 2026-09-10 ---');
  {
    const b = bench();
    const PEAK = {
      'glm-4.5-flash': 6925,
      'gemini-3.5-flash-lite': 2000
    };
    for (const id of Object.keys(PEAK)) check(id + ' : ' + lane(b, id).ms + ' ms', lane(b, id).ms >= 1.5 * PEAK[id], true);
  }

  console.log('\n--- pas de mute fantome : auteur ? et streamer ---');
  {
    const b = bench();
    check('addMute ? refuse', b.run('addMute')('?', 0.94, 'llm'), false);
    check('  pas d entree ?', !!b.run('mutedUsers')['?'], false);
    check('addMute vide refuse', b.run('addMute')('', 0.94, 'llm'), false);
    b.run('trackAuthor')('streamer_a', 'ntm fdp', { ts: b.run('Date.now()'), channel: 'twitch/streamer_a' });
    check('streamer du salon refuse', b.run('addMute')('streamer_a', 0.94, 'llm'), false);
    check('  streamer_a pas mute', muted(b, 'streamer_a'), false);
    check('un viewer se mute', b.run('addMute')('troll', 0.94, 'llm'), true);
    await settle();
    check('  troll mute', muted(b, 'troll'), true);
  }

  console.log('\n--- pardon des mutes faux positifs ---');
  {
    const b = bench();
    await settle();
    b.run(`
      mutedUsers['?'] = { at: 1, pct: 94, strikes: 'politique' };
      mutedUsers.streamer_a = { at: 1, channel: 'twitch/streamer_a' };
      mutedUsers.viewer_1 = { at: 1 };
      mutedUsers.viewer_2 = { at: 1 };
      mutedUsers.viewer_3 = { at: 1 };
      mutedUsers.viewer_4 = { at: 1 };
      mutedUsers.viewer_5 = { at: 1 };
      mutedUsers.viewer_6 = { at: 1 };
      mutedUsers.viewer_7 = { at: 1 };
      mutedUsers.viewer_8 = { at: 1 };
      mutedUsers.droite_rn = { at: 1, strikes: 'politique', perm: true };
      mutedUsers.gauche_lfi = { at: 1, strikes: 'politique', perm: true };
      mutedUsers.ghost = { at: 1, strikes: 'llm' };
      const row = (a, t, src, ch) => ({ author: a, text: t, label: 'mute', source: src, channel: ch || 'twitch/x' });
      ftLog.push(row('viewer_1', "mzizou c'est le mongolz ? xD", 'keyword', 'twitch/salon_1'));
      ftLog.push(row('viewer_2', 'bah ajoute fdp', 'keyword', 'twitch/salon_2'));
      ftLog.push(row('viewer_3', 'Ptn de clavier', 'keyword', 'twitch/salon_1'));
      ftLog.push(row('viewer_4', 'STREAMERTTTTTTTTTTTTTT', 'llm', 'twitch/streamerr_'));
      ftLog.push(row('viewer_5', 'Ou des animations quasiment nsfw a base de Loli', 'llm', 'twitch/salon_3'));
      ftLog.push(row('viewer_6', 'FEUR FEUR', 'llm', 'twitch/streamer_a'));
      ftLog.push(row('viewer_7', 'je te merde', 'recolle', 'twitch/streamer_a'));
      ftLog.push(row('viewer_8', 'je le dis un derniere fois Elise', 'idle_1.3', 'twitch/salon_4'));
      ftLog.push(row('droite_rn', 'bardella president vive le rn', 'politique'));
      ftLog.push(row('gauche_lfi', 'votez lfi palestine libre', 'politique'));
      pardonDone = true;
      pardonFalseMutes();
    `);
    await settle();
    check('? leve', !!b.run('mutedUsers')['?'], false);
    check('streamer leve', muted(b, 'streamer_a'), false);
    check('mongolz leve', muted(b, 'viewer_1'), false);
    check('ptn clavier leve', muted(b, 'viewer_3'), false);
    check('cheer leve', muted(b, 'viewer_4'), false);
    check('feur leve', muted(b, 'viewer_6'), false);
    check('idle banter leve', muted(b, 'viewer_8'), false);
    check('fdp garde', muted(b, 'viewer_2'), true);
    check('loli garde', muted(b, 'viewer_5'), true);
    check('je te merde garde', muted(b, 'viewer_7'), true);
    check('politique de droite gardee (neutre)', muted(b, 'droite_rn'), true);
    check('politique de gauche gardee', muted(b, 'gauche_lfi'), true);
    check('sans preuve dans le journal : leve', muted(b, 'ghost'), false);
    check('garde-fou : neutralite politique', b.run("rightPolOnly('je vote rn')"), false);
    check('garde-fou : insulte gardee', b.run("rightPolOnly('bardella va te faire enculer fdp')"), false);
    check('garde-fou : gauche gardee', b.run("rightPolOnly('trump facho')"), false);
  }

  console.log('\n--- jugement coupe : capture en file, zero appel ---');
  {
    const b = bench();
    b.run('engineCache = ' + JSON.stringify(E));
    await settle();
    b.run('applySettings({ judge: false, enabled: true, target: "author" })');
    seed(b, 4, (i) => 'toxique ' + i, (i) => 'troll' + i);
    await b.run('pumpAudit')();
    check('pause : file intacte', b.run('auditQueue').length, 4);
    check('pause : personne mutee', Object.keys(b.run('mutedUsers')).length, 0);
    check('pause : flag juge off', b.run('llmJudgeOn()'), false);
    check('pause : zero appel', b.api.calls.length, 0);
    b.run('applySettings({ judge: true })');
    check('ancien reglage on : flag juge reste off', b.run('llmJudgeOn()'), false);
    await settle();
    check('ancien reglage on : file intacte', b.run('auditQueue').length, 4);
    check('ancien reglage on : aucun mute', muted(b, 'troll0'), false);
  }

  console.log('\n--- file bornee ---');
  {
    const b = bench();
    await settle();
    b.run('applySettings({ judge: false })');
    check('QUEUE_MAX de securite', b.run('AUDIT.QUEUE_MAX'), 2000);
    b.run('AUDIT.QUEUE_MAX = 50');
    b.run(`
      droppedCount = 0;
      for (let i = 0; i < 75; i++) enqueueAudit('v' + i, 'ligne ' + i, { id: 'e' + i, channel: 'sim' });
    `);
    await b.run('pumpAudit')();
    check('la file reste au plafond', b.run('auditQueue').length, 50);
    check('les sorties sont comptees', b.run('droppedCount'), 25);
  }

  console.log('\n--- file et stats survivent au redemarrage ---');
  {
    const b = bench();
    await settle();
    b.run('applySettings({ judge: false })');
    b.run('engineCache = { goKey: "", googleKey: "", glmKey: "" }');
    b.run(`
      droppedCount = 0;
      acceptedCount = 7;
      rejectedCount = 3;
      auditJudged = 10;
      enqueueAudit('alice', 'hello persist', { id: 'p1', channel: 'sim' });
      persistQueueNow();
      lastSnapKey = '';
      doPublish();
    `);
    await settle();
    check('disque file', (b.store.csg_queue || []).length, 1);
    check('disque acceptes', b.store.csg_counts && b.store.csg_counts.accepted, 7);
    b.run(`
      auditQueue.splice(0, auditQueue.length);
      acceptedCount = 0;
      rejectedCount = 0;
      auditJudged = 0;
      enqueuedCount = 0;
      droppedCount = 0;
      // Worker neuf : il n'a encore rien relu.
      auditRestored = false;
    `);
    b.advance(400000);
    b.run('restoreAudit()');
    await settle();
    check('reveil : ancienne file migree', b.run('auditQueue').length, 0);
    check('reveil : capture en attente', b.run("ftLog.some((r) => r.id === 'p1' && r.label === 'pending')"), true);
    check('reveil pas droppee par l age', b.run('droppedCount'), 0);
    check('reveil acceptes', b.run('acceptedCount'), 7);
    check('reveil rejetes', b.run('rejectedCount'), 3);
    check('reveil analyses', b.run('auditJudged'), 10);
  }

  console.log('\n--- un lot en vol est sauve avec la file ---');
  {
    const b = bench();
    await settle();
    b.run(`
      auditQueue.splice(0, auditQueue.length);
      inflightJobs.set('j1', { lane: CHAIN[0], batch: [{ a: 'bob', t: 'en vol', id: 'f1', ts: Date.now() }] });
      persistQueueNow();
    `);
    await settle();
    check('lot en vol sur disque', (b.store.csg_queue || []).some((x) => x && x.id === 'f1'), true);
  }

  // « Masquer les mutés » coupé : c'est un reglage d'AFFICHAGE. Le mute est pose
  // quoi qu'il arrive — sinon l'utilisateur qui veut juste revoir le chat tel
  // quel perdait aussi le journal, les compteurs et la liste des mutés.
  console.log('\n--- masquer les mutes coupe : on punit quand meme ---');
  {
    const b = bench(ENGINE, only(GROK, { target: 'message' }));
    b.run('engineCache = ' + JSON.stringify(X));
    closeLanes(b, DEEP);
    await settle();
    check('drapeau d affichage coupe', b.run('hideMuted()'), false);
    seed(b, 3, (i) => (i === 1 ? 'toxique' : 'ligne propre ' + i), (i) => (i === 1 ? 'troll' : 'viewer' + i));
    await pump(b, 50, X);
    await settle();
    check('troll mute quand meme', muted(b, 'troll'), true);
    check('personne d autre', Object.keys(b.run('mutedUsers')), ['troll']);
    // ... et comme ses lignes restent visibles, elles continuent d'etre jugees
    // au lieu d'etre jetees de la file sans lecture.
    check(
      'sa ligne suivante entre en file',
      b.run('enqueueAudit')('troll', 'bonjour tout le monde', { channel: 'sim', id: 'aff1' }),
      true
    );
    setSettings(b, { judge: true, enabled: true, target: 'author', lane: GROK });
    check(
      'masquage recoche : sa ligne est jetee sans appel',
      b.run('enqueueAudit')('troll', 'bonjour tout le monde 2', { channel: 'sim', id: 'aff2' }),
      false
    );
  }

  console.log(T.fails ? '\n' + T.fails + ' ECHEC(S)' : '\ntout est vert');
  process.exit(T.fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
