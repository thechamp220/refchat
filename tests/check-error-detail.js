'use strict';

const { bench, booted, checker, seed, setSettings, X } = require('./bench');
const T = checker();

(async () => {
  const b = bench({ csg_engine: X });
  await booted(b);
  b.run('engineCache = ' + JSON.stringify(X));
  const lane = b.run('CHAIN').find((l) => l.key === 'xai');
  for (const [message, expected] of [
    ['llm_http_400 {"error":"unsupported parameter"}', 'HTTP 400'],
    ['llm_http_503 upstream unavailable', 'HTTP 503'],
    ['Failed to fetch', 'réseau'],
    ['Unexpected token in JSON', 'JSON invalide']
  ]) {
    b.run('noteLaneFail')(lane, message);
    const status = b.run('laneStatuses')().find((l) => l.id === lane.id);
    T.check(message + ' : cause visible', status.detail.includes(expected), true);
    T.check(message + ' : statut erreur', status.status, 'err');
  }
  T.check('ne publie pas le corps serveur', b.run('errHint')('llm_http_400 secret-server-body'), 'HTTP 400');
  b.run('noteLaneOk')(lane.id);
  T.check('succès efface le diagnostic', b.run('modelErrHint')[lane.id], undefined);
  setSettings(b, { pickedLane: lane.id });
  b.run('pickedLane = ' + JSON.stringify(lane.id));
  b.run('noteLaneFail')(lane, 'llm_http_503 upstream unavailable');
  b.run('rateLimited = true; cooldownUntil = Date.now() + 20000');
  const snap = b.run('snapshotAudit')();
  T.check('erreur HTTP : pas de faux quota', snap.rateLimited, false);
  T.check('erreur HTTP : état hors ligne', snap.state, 'offline');
  T.check('erreur HTTP : cause dans le bandeau', snap.label.includes('HTTP 503'), true);
  b.run('saveLaneSkip')();
  const restarted = bench(b.store);
  await booted(restarted);
  T.check('redémarrage : détail conservé', restarted.run('modelErrHint')[lane.id], 'HTTP 503');
  seed(b, 16, () => 'hello chat');
  b.run("lastAuditError = 'llm_http_503 upstream unavailable'");
  await b.run('pumpAudit')();
  T.check('pompe en pause : erreur conservée', b.run('lastAuditError'), 'llm_http_503 upstream unavailable');
  T.check('pompe en pause : pas de faux rate limit', b.run('rateLimited'), false);
  b.run('modelSkipUntil[' + JSON.stringify(lane.id) + '] = 0');
  b.run('noteLaneFail')(lane, 'llm_429');
  T.check('vrai quota toujours affiché', b.run('snapshotAudit')().rateLimited, true);
  if (T.fails) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
