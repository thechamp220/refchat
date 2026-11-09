'use strict';
// Copypasta : on masque sur la FORME, jamais sur le sens. Le vrai risque de ce
// filtre n'est pas de rater un pave, c'est de couper un message ecrit a la
// main : la moitie basse de ce fichier est donc la liste des messages qui
// doivent survivre, et elle pese plus lourd que la liste des paves.
globalThis.self = globalThis;
const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'keywords.js'));
const K = globalThis.CSG_KEYWORDS;

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

function pasta(name, text, want) {
  check(name, K.copypasta(text), want);
}

console.log('\n--- les formes qu on masque ---');
pasta('braille / ascii art', '⣿'.repeat(30), 'ascii art');
pasta('blocs pleins', '█▓▒░'.repeat(8), 'ascii art');
pasta(
  'police pleine chasse',
  'ＮＯＴＩＣＥ ＭＥ ＳＥＮＰＡＩ ＰＬＥＡＳＥ ＲＥＳＰＯＮＤ ＴＯ ＭＥ ＮＯＷ',
  'police deco'
);
pasta(
  'segment recopie dans le message',
  'vous connaissez le crosshair de zywoo ! vous connaissez le crosshair de zywoo !',
  'pave repete'
);
pasta(
  'martelement du meme jeton',
  'clap clap clap clap clap clap clap clap clap clap bravo les gars',
  'martelement'
);
pasta(
  'boucle de deux mots',
  'ratio ratio ratio ratio ratio ratio ratio ratio ratio ratio ratio ratio',
  'martelement'
);
pasta(
  'meme phrase recollée sans ponctuation',
  'vous connaissez le crosshair de zywoo vous connaissez le crosshair de zywoo',
  'pave repete'
);

console.log('\n--- ce qui doit passer : du chat ecrit a la main ---');
const wall =
  'je trouve que cette equipe a vraiment progresse depuis le debut de la saison, ' +
  'leur jeu sur inferno est beaucoup plus propre qu avant, les rotations arrivent ' +
  'au bon moment et le sniper trouve enfin ses angles, franchement si ils gardent ' +
  'ce niveau ils peuvent aller loin dans le tournoi et pourquoi pas viser une ' +
  'finale cette annee';
check('avis long (300+ car.)', wall.length >= 300, true);
pasta('avis long unique n est pas une pasta', wall, '');

const KEEP = [
  'gg wp les gars c etait un super match bien joue a tous',
  'quelqu un sait a quelle heure commence le match de vitality ce soir ?',
  'il a dit non non non non mais bon on verra bien',
  'le round eco a coute la game, ils avaient plus rien pour le dernier achat',
  'perso je pense que la map etait mauvaise pour eux des le depart du match',
  '→ inferno → mirage ← nuke',
  'ＧＧ ＷＰ',
  '\u{1F525}\u{1F525}\u{1F525}',
  'zywoo zywoo zywoo',
  'gg gg gg',
  'franchement le niveau de cette finale est incroyable, on voit que les deux ' +
    'equipes ont bosse leurs strats et chaque round se joue sur un detail, ' +
    'j espere que ca ira jusqu au dernier map point',
  'mais qu est ce qu il fait la !!! serieux !!!',
  'il a rate le flick. il a rate le spray aussi.',
  // Faux positifs vus en live : phrase courte repetee, begaiement, 5 claps.
  'c etait trop beau. c etait trop beau.',
  'c est c est c est c est c est c est vraiment pas possible',
  'clap clap clap clap clap bravo les gars trop fort ce round',
  'il a dit que c est pas ce qu on a vu sur le round de inferno'
];
for (const t of KEEP) pasta('garde : ' + t.slice(0, 46), t, '');

console.log('\n--- bornes ---');
pasta('trop court pour etre un pave', '⣿'.repeat(10), '');
pasta('vide', '', '');
pasta('null', null, '');
pasta(
  'long unique sans boucle',
  'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima ' +
    'mike november oscar papa quebec romeo sierra tango uniform victor whiskey ' +
    'xray yankee zulu nord sud est ouest centre milieu debut fin',
  ''
);

const fs = require('fs');
const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
check('chaine : seuil 72 car.', /MIN_LEN:\s*72/.test(src), true);
check('mur d emotes : 12 pas 8', /EMOTES:\s*12/.test(src), true);
check('msgText ne tronque plus a 300', /plain\.slice\(0,\s*800\)/.test(src), true);
check('mot banni : le mot entier', K.matchExtra('arrete de chokeur', ['chokeur']), 'chokeur');
check('mot banni : pas un bout de mot', K.matchExtra('contre le second', ['con']), '');
check('mot banni : phrase entiere', K.matchExtra('c est un sale rat', ['sale rat']), 'sale rat');

console.log(fails ? '\n' + fails + ' ECHEC(S)\n' : '\ntout est vert\n');
process.exit(fails ? 1 : 0);
