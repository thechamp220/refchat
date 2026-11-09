'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const legacy = '^(?=.{14,}$)(?:[^a-z]*[A-Z]){10,}[^a-z]*$';
if (process.argv.includes('--worker')) {
  require('../regex-rules');
  const src = fs.readFileSync(path.join(__dirname, '..', 'board.js'), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(src.slice(src.indexOf('function compileRegexPattern('), src.indexOf('function matchCustomRegex(')), ctx);
  const current = CSG_REGEX.DEFAULTS.find(r => r.id === 'reg_caps');
  const compilers = [
    () => CSG_REGEX.compile(current.pattern, ''),
    () => CSG_REGEX.compile(legacy, ''),
    () => CSG_REGEX.compile('/' + legacy + '/', ''),
    () => ctx.compileRegexPattern(legacy, ''),
    () => ctx.compileRegexPattern('/' + legacy + '/', '')
  ];
  for (const compile of compilers) {
    const re = compile();
    assert.equal(re.test('A'.repeat(500) + 'a'), false);
    assert.equal(re.test('A'.repeat(500)), true);
    assert.equal(re.test('A'.repeat(9) + '!!!!!'), false);
    assert.equal(re.test('A'.repeat(10) + '!!!!'), true);
    assert.equal(re.test('Bonjour le chat'), false);
  }
  console.log('OK regex: défaut, ancienne règle sauvegardée, tableau et limites');
} else {
  // Bound the regression itself: the pre-fix pattern must fail this test
  // without hanging the complete test runner.
  const r = spawnSync(process.execPath, [__filename, '--worker'], {timeout: 2500, encoding: 'utf8'});
  assert.equal(r.error, undefined, 'le filtre ne doit pas bloquer sur un message court');
  assert.equal(r.status, 0, r.stderr);
  process.stdout.write(r.stdout);
}
