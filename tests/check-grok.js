'use strict';
// All regressions: mocked account calls, isolated temporary local servers.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const suites = fs.readdirSync(__dirname).filter(file => /^check-.*\.js$/.test(file) && file !== path.basename(__filename)).sort();
const syntax = require('../tools/check-syntax');
let failed = !syntax.checkSyntax();
// CODE_VERSION de background.js = manifest : sinon le popup crie « ancien code » à tort.
if (!syntax.checkVersions()) failed = true;
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== manifest.version) { failed = true; console.error('Versions package/manifeste incohérentes'); }
for (const file of [manifest.background.service_worker, manifest.action.default_popup,
  ...Object.values(manifest.icons || {}), ...Object.values(manifest.action.default_icon || {}),
  ...manifest.content_scripts.flatMap(x => [...(x.js || []), ...(x.css || [])])]) {
  if (!fs.existsSync(path.join(root, file))) { failed = true; console.error('Ressource manquante : ' + file); }
}
for (const match of fs.readFileSync(path.join(root, manifest.background.service_worker), 'utf8').matchAll(/\bimportScripts\(\s*['"]([^'"]+)['"]\s*\)/g)) {
  if (!fs.existsSync(path.join(root, match[1]))) { failed = true; console.error('Import manquant : ' + match[1]); }
}
for (const file of [manifest.action.default_popup, 'board.html']) {
  for (const match of fs.readFileSync(path.join(root, file), 'utf8').matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)) {
    if (!fs.existsSync(path.resolve(root, match[1]))) { failed = true; console.error('Ressource manquante : ' + match[1]); }
  }
}
for (const suite of suites) {
  const result = spawnSync(process.execPath, [path.join(__dirname, suite)], { cwd: root, encoding: 'utf8', timeout: 120000 });
  if (result.status === 0) console.log('OK  ' + suite);
  else { failed = true; console.error('ECHEC  ' + suite + '\n' + result.stdout + result.stderr + (result.error || '')); }
}
console.log('RefChat ' + manifest.version + ' : ' + (failed ? 'échec' : suites.length + ' suites OK, syntaxe et ressources OK'));
process.exitCode = failed ? 1 : 0;
