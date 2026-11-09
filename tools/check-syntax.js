'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function checkSyntax() {
  let failed = false;
  let count = 0;
  for (const dir of ['.', 'tools', 'archive-server', 'sync-server', 'tests']) {
    for (const file of fs.readdirSync(path.join(root, dir)).filter(name => /\.(?:m?js)$/.test(name)).sort()) {
      const target = path.join(root, dir, file);
      if (!fs.statSync(target).isFile()) continue;
      count++;
      const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8', timeout: 30000 });
      if (result.status !== 0) {
        failed = true;
        console.error('Syntaxe invalide : ' + path.relative(root, target) + '\n' + (result.stderr || result.error || 'échec'));
      }
    }
  }
  if (!failed) console.log('Syntaxe OK : ' + count + ' fichiers');
  return !failed;
}
// background.js porte sa propre version (CODE_VERSION) : le popup la compare au
// manifest pour repérer un ancien service worker resté en mémoire. Une montée de
// version qui oublierait background.js afficherait une fausse alerte.
function checkVersions() {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const manifest = JSON.parse(read('manifest.json')).version;
  const pkg = JSON.parse(read('package.json')).version;
  const m = read('background.js').match(/^const CODE_VERSION = '([^']+)';$/m);
  const bad = [];
  if (!m) bad.push('CODE_VERSION introuvable dans background.js');
  else if (m[1] !== manifest) bad.push('background.js CODE_VERSION ' + m[1] + ' au lieu de ' + manifest + ' (manifest.json)');
  if (pkg !== manifest) bad.push('package.json ' + pkg + ' au lieu de ' + manifest + ' (manifest.json)');
  for (const b of bad) console.error('Versions : ' + b);
  if (!bad.length) console.log('Versions OK : ' + manifest);
  return !bad.length;
}
module.exports = { checkSyntax, checkVersions };
if (require.main === module) process.exitCode = [checkSyntax(), checkVersions()].every(Boolean) ? 0 : 1;
