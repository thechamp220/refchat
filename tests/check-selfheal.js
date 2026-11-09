'use strict';

// Auto-réparation du fond (background.js, selfHealIfStale).
//
// Reproduit le 2026-11-09 dans un Brave isolé : après une RELANCE de Brave, une
// extension non empaquetée garde son ancien service worker alors que le
// manifest chargé est plus récent. Le fond se recharge donc lui-même quand son
// CODE_VERSION est plus ancien que le manifest, deux fois au plus par version et
// par tranche de 10 minutes (clé csg_selfheal, partagée avec le popup).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { checker } = require('./bench');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const block = src.slice(src.indexOf('const SELF_HEAL'), src.indexOf('// Avant tout le reste'));

const T = checker();
const check = T.check;

function run(manifestV, codeV, stored) {
  const out = { reloads: 0, reads: 0, writes: [], notes: [] };
  const ctx = {
    Date,
    CODE_VERSION: codeV,
    diagNote: (...a) => out.notes.push(a.join(' ')),
    chrome: {
      runtime: { getManifest: () => ({ version: manifestV }), reload: () => { out.reloads += 1; } },
      storage: {
        local: {
          get: (d, cb) => { out.reads += 1; cb(Object.assign({}, d, stored ? { csg_selfheal: stored } : {})); },
          set: (o, cb) => { out.writes.push(o.csg_selfheal); if (cb) cb(); }
        }
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(block + '\nselfHealIfStale();\nthis.versionCmp = versionCmp;', ctx);
  out.versionCmp = ctx.versionCmp;
  return out;
}

console.log('\n--- fond à jour : rien, pas même une lecture');
let r = run('3.39.7', '3.39.7');
check('même version', [r.reloads, r.reads, r.writes.length], [0, 0, 0]);
r = run('3.39.6', '3.39.7');
check('manifest plus ancien que le code', [r.reloads, r.reads], [0, 0]);
r = run('0.0.0', '3.39.7');
check('banc de test (manifest 0.0.0)', [r.reloads, r.reads], [0, 0]);

console.log('\n--- fond périmé : il se recharge');
r = run('3.39.8', '3.39.7');
check('premier essai', r.reloads, 1);
check('essai noté AVANT le rechargement', [r.writes[0].want, r.writes[0].from, r.writes[0].n, r.writes[0].by], ['3.39.8', '3.39.7', 1, 'fond']);
r = run('3.39.10', '3.39.9');
check('3.39.10 est plus récent que 3.39.9', r.reloads, 1);
r = run('3.39.8', '3.39.7', { want: '3.39.8', at: Date.now() - 60000, n: 1, by: 'popup' });
check('second essai (après un essai du popup)', [r.reloads, r.writes[0].n], [1, 2]);

console.log('\n--- garde-fou : jamais de boucle');
r = run('3.39.8', '3.39.7', { want: '3.39.8', at: Date.now() - 60000, n: 2, by: 'fond' });
check('deux essais en 10 min : on s arrête', [r.reloads, r.writes.length], [0, 0]);
check('et le diagnostic le dit', /toujours ancien après 2 rechargements \(manifest v3\.39\.8\)/.test(r.notes.join(' ')), true);
r = run('3.39.8', '3.39.7', { want: '3.39.8', at: Date.now() - 11 * 60000, n: 2, by: 'fond' });
check('essais de plus de 10 min oubliés', [r.reloads, r.writes[0].n], [1, 1]);
r = run('3.39.9', '3.39.7', { want: '3.39.8', at: Date.now() - 60000, n: 2, by: 'fond' });
check('essais pour une autre version : ne comptent pas', [r.reloads, r.writes[0].n], [1, 1]);

console.log('\n--- place dans le fichier');
check('appelé avant les importScripts', src.indexOf('\nselfHealIfStale();') > 0 && src.indexOf('\nselfHealIfStale();') < src.indexOf('importScripts('), true);
const num = (s, k) => (s.match(new RegExp('const SELF_HEAL = \\{[^}]*' + k + ': ([^,}\\s]+)')) || [])[1];
for (const k of ['KEY', 'MAX', 'WINDOW_MS']) check('même garde-fou que le popup : ' + k, num(src, k), num(popup, k));

if (T.fails) process.exitCode = 1;
