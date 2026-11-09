'use strict';

// Choix manuel du modele (clic sur une lane dans le popup).
//
// Ce que ce fichier protege :
//  - « je veux juste DeepSeek » veut dire AUCUN autre appel, sur aucun chemin
//    (lots de chat, profil d'auteur, relecture du journal) ;
//  - un id inconnu ne doit pas geler le jugement : on retombe sur le modele
//    par defaut (le premier de CHAIN qui a une cle), pas sur la chaine entiere ;
//  - le modele choisi en pause ne doit RIEN faire perdre : la file attend, elle
//    ne se vide pas en « ignores » (voir refchat-objectif-zero-ignore).

const { bench, booted, tick, X, GROK, seed, pump, checker, setSettings } = require('./bench');

const T = checker();
const check = T.check;
const settle = async () => {
  for (let i = 0; i < 12; i++) await tick();
};
const ids = (b) => b.run('openLanes')(X).map((l) => l.id).sort();

setTimeout(() => {
  console.log(' FAIL delai global depasse');
  process.exit(1);
}, 60000);

(async () => {
  console.log('\n=== check-pick : un seul modele, choisi a la main ===');

  console.log('\n--- rien de choisi : UN seul modele quand meme ---');
  {
    const b = bench();
    await booted(b);
    b.run('engineCache = ' + JSON.stringify(X));
    setSettings(b, { judge: true, enabled: true });
    // Un seul moteur : Grok 4.6 via SuperGrok. Le réglage de lane est ignoré.
    check('une seule lane ouverte', ids(b), [GROK]);
    check('soleLaneId la designe', b.run('soleLaneId')(X), GROK);
  }

  console.log('\n--- choix : gemini flash-lite et rien d autre ---');
  {
    const b = bench({ csg_engine: X });
    b.run('engineCache = ' + JSON.stringify(X));
    await booted(b);
    setSettings(b, { judge: true, enabled: true, lane: 'gemini-3.5-flash-lite' });
    check('choix sans cle correspondante retombe sur le moteur actif', [b.run('pickedLane'), b.run('soleLaneId')(X)], ['gemini-3.5-flash-lite', GROK]);
    check('une seule lane ouverte', ids(b), [GROK]);
    check('file vide : Grok payant ne part pas', b.run('freeLanes')(X).map((l) => l.id), []);

    seed(b, 6, (i) => (i === 1 ? 'toxique' : 'ligne propre ' + i), (i) => 'v' + i);
    check('file en attente : Grok seul', b.run('freeLanes')(X).map((l) => l.id), [GROK]);
    await pump(b, 50, X);
    await settle();
    const models = Array.from(new Set(b.api.calls.map((c) => c.lane)));
    check('tous les appels sur le modele choisi', models, [GROK]);
    check('la file est videe', b.run('auditQueue').length, 0);
    check('rien d ignore', b.run('skippedCount'), 0);
  }

  console.log('\n--- le choix ferme aussi les chemins hors lot ---');
  {
    const b = bench({ csg_engine: X });
    b.run('engineCache = ' + JSON.stringify(X));
    await booted(b);
    setSettings(b, { judge: true, enabled: true, lane: 'gemini-3.5-flash-lite' });
    check('deepLane rend null', b.run('deepLane')(X), null);
    check('pas de relecteur gratuit : Grok est payant', b.run('idleReader')(X), null);
    b.run(`
      rememberChat('troll', 'toxique un', { channel: 'sim' });
      rememberChat('troll', 'toxique deux', { channel: 'sim' });
    `);
    await b.run('runAuthorCheck')('troll', 2, '', { force: true });
    await settle();
    const authorModels = Array.from(new Set(b.api.authorCalls.map((c) => c.lane)));
    check('profil d auteur : sur Grok ou pas du tout', authorModels.filter((m) => m !== GROK), []);
  }

  console.log('\n--- statuts publies : la liste reste le tableau de bord ---');
  {
    const b = bench({ csg_engine: X });
    await booted(b);
    await settle();
    b.run('engineCache = ' + JSON.stringify(X));
    setSettings(b, { judge: true, enabled: true });
    const rows = b.run('laneStatuses')();
    const mine = rows.find((l) => l.id === GROK);
    check('le choisi est marque', [mine.picked, mine.status], [true, 'ready']);
    check('aucun autre marque', rows.filter((l) => l.picked).length, 1);
    check('la liste vivante contient toute la chaine', rows.map((l) => l.id), b.run('CHAIN').map((l) => l.id));
    check('les stats sont publiées', rows.every((l) => 'stats' in l), true);
  }

  console.log('\n--- id inconnu : modele par defaut, pas de gel ---');
  {
    const b = bench();
    await booted(b);
    b.run('engineCache = ' + JSON.stringify(X));
    setSettings(b, { judge: true, enabled: true, lane: 'modele-qui-nexiste-plus' });
    check('un id mort ne gele pas le juge', b.run('pickedLane'), '');
    check('un modele par defaut prend le relais', ids(b), [GROK]);
  }

  console.log('\n--- choix en pause : la file attend, elle ne se perd pas ---');
  {
    const b = bench({ csg_engine: X });
    await booted(b);
    await settle();
    b.run('engineCache = ' + JSON.stringify(X));
    setSettings(b, { judge: true, enabled: true });
    b.run('skipLane')(GROK, 600000, 'quota');
    check('aucune lane ouverte', ids(b), []);
    seed(b, 4, (i) => 'ligne ' + i, (i) => 'v' + i);
    await b.run('pumpAudit')();
    await settle();
    check('file intacte', b.run('auditQueue').length, 4);
    check('zero appel', b.api.calls.length, 0);
    check('zero ignore', b.run('skippedCount'), 0);
    check('zero sortie de file', b.run('droppedCount'), 0);
    const row = b.run('laneStatuses')().find((l) => l.id === GROK);
    check('le popup voit la limite', [row.picked, row.status], [true, 'limit']);
    b.run('modelSkipUntil')[GROK] = 0;
    await pump(b, 50, X);
    await settle();
    check('reprise : file videe', b.run('auditQueue').length, 0);
    check('reprise : toujours le meme modele', Array.from(new Set(b.api.calls.map((c) => c.lane))), [GROK]);
  }

  console.log(T.fails ? '\n' + T.fails + ' ECHEC(S)' : '\ntout est vert');
  process.exit(T.fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
