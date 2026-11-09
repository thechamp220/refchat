'use strict';

// Le journal ne gardait que 800 lignes : PERSIST_KEEP (800) etait plus petit
// que FT.MAX (4000), et loadFtLog ecrasait la RAM avec le disque a chaque
// reveil du service worker MV3. Sur 116330 messages analyses, l export en
// rendait 804. Les lignes qui sortent de la fenetre partent maintenant dans
// une archive append-only par blocs. Ce fichier verifie qu on ne perd plus
// rien : ordre conserve, bloc scelle jamais reecrit, survie au redemarrage,
// et quota plein qui ne mange pas le lot en cours.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function between(a, b) {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('bloc introuvable : ' + a);
  return src.slice(i, j);
}

// Faux chrome.storage.local. Le vrai accepte un objet de defauts OU un tableau
// de cles : readFtArchive utilise la forme tableau, il faut donc la supporter
// sinon le test validerait un appel que Chrome refuserait.
let store = {};
let failNextSet = false;
let writes = 0;

globalThis.chrome = {
  runtime: {
    lastError: null,
    onSuspend: { addListener() {} }
  },
  storage: {
    local: {
      get(what, cb) {
        const out = {};
        if (Array.isArray(what)) {
          for (const k of what) if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
        } else {
          for (const k of Object.keys(what)) {
            out[k] = JSON.parse(JSON.stringify(k in store ? store[k] : what[k]));
          }
        }
        cb(out);
      },
      set(obj, cb) {
        writes++;
        if (failNextSet) {
          failNextSet = false;
          chrome.runtime.lastError = { message: 'QUOTA_BYTES quota exceeded' };
          if (cb) cb();
          chrome.runtime.lastError = null;
          return;
        }
        for (const k of Object.keys(obj)) store[k] = JSON.parse(JSON.stringify(obj[k]));
        if (cb) cb();
      },
      remove(keys, cb) {
        for (const k of [].concat(keys)) delete store[k];
        if (cb) cb();
      }
    }
  }
};

const code = [
  between('const FT = {', '\nconst BEH = {'),
  between('// ------------------------------------------------------------ archive ft', '\nfunction loadFtLog()'),
  `Object.assign(globalThis, {
    FT, archiveFt, flushFtArchive, readFtArchive, clearFtArchive,
    queueLen: () => ftArchQueue.length,
    // Redemarrage MV3 : les variables JS repartent a zero, le magasin survit.
    restart: () => { ftArchQueue = []; ftArchTimer = null; ftArchIndex = null; }
  });`
].join('\n');

// eslint-disable-next-line no-eval
eval(code);
const { FT, archiveFt, flushFtArchive, readFtArchive, clearFtArchive, queueLen, restart } = globalThis;

// Blocs courts : on veut plusieurs blocs sans fabriquer 6000 lignes. 8 et non
// 5 pour que le seuil de flush immediat (CHUNK/4) vaille 2 : a 1, la moindre
// ligne partait en ecriture et le debounce n etait jamais teste.
FT.CHUNK = 8;

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (ok ? '' : '\n        obtenu  ' + JSON.stringify(got) + '\n        attendu ' + JSON.stringify(want)));
}

const row = (i) => ({ id: 'r' + i, text: 'msg ' + i, label: 'keep' });
const ids = (rows) => rows.map((r) => r.id);

function read() {
  let out = null;
  readFtArchive((rows) => {
    out = rows;
  });
  return out;
}

console.log('\n--- une ligne archivee se relit ---');
archiveFt([row(1)]);
check('rien en magasin avant le flush', store.csg_ft_arch, undefined);
flushFtArchive();
check('la ligne est relue', ids(read()), ['r1']);
check('la file est videe', queueLen(), 0);

console.log('\n--- l ordre survit au decoupage en blocs ---');
const many = [];
for (let i = 2; i <= 13; i++) many.push(row(i));
archiveFt(many);
flushFtArchive();
check('13 lignes relues dans l ordre', ids(read()), ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13']);
check('bloc 0 plein a CHUNK', store.csg_ftc_0.length, 8);
check('l index compte les blocs', store.csg_ft_arch.chunks, 2);
check('l index compte les lignes', store.csg_ft_arch.rows, 13);

console.log('\n--- un bloc scelle n est plus jamais reecrit ---');
const sealed = JSON.stringify(store.csg_ftc_0);
const before = writes;
archiveFt([row(14)]);
flushFtArchive();
check('bloc 0 intact', JSON.stringify(store.csg_ftc_0), sealed);
check('un seul write pour ajouter une ligne', writes - before <= 2, true);

console.log('\n--- redemarrage du service worker ---');
restart();
check('tout est encore la apres redemarrage', ids(read()).length, 14);
archiveFt([row(15)]);
flushFtArchive();
check('on repart du bon bloc, sans trou', ids(read()).length, 15);
check('sans doublon', new Set(ids(read())).size, 15);

console.log('\n--- quota plein : le lot n est pas perdu ---');
failNextSet = true;
archiveFt([row(16)]);
flushFtArchive();
// L assertion vient APRES le flush qui echoue, pas apres un second qui reussit.
check('la ligne reste en file', queueLen(), 1);
check('l archive n a pas compte la ligne', store.csg_ft_arch.rows, 15);
flushFtArchive();
check('elle passe au write suivant', ids(read()).length, 16);

console.log('\n--- purge ---');
clearFtArchive();
check('archive vide', read(), []);
check('plus aucun bloc en magasin', Object.keys(store).filter((k) => k.startsWith('csg_ftc_')), []);

console.log(fails ? '\n' + fails + ' echec(s)' : '\ntout est vert');
process.exit(fails ? 1 : 0);
