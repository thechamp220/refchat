'use strict';

// Verification complete du journal.
//
// La relecture ordinaire ne regarde QUE les lignes jamais relues et jamais
// tranchees en local : les faux positifs de la liste locale et des mots appris
// n'etaient donc soumis a personne, jamais. Ce fichier verifie les deux moities
// du reglage : ce qu'il fait ENTRER dans la relecture, et ce qu'il DEFAIT quand
// un blocage local est dementi (mute leve, terme mis en cause, exemples du
// prompt rafraichis).

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function between(a, b) {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('bloc introuvable : ' + a);
  return src.slice(i, j);
}

// --- doublures ------------------------------------------------------------
const calls = { hide: [], unhide: [], mute: [], unmute: [], reveal: [], beh: [] };
globalThis.thresholdCache = 0.4;
globalThis.DEEP_LANE_ID = 'deep';
globalThis.clip = (s, n) => String(s || '').slice(0, n);
globalThis.keepBit = (tag) => ({ tag, score: 0, pol: false });
globalThis.persistFtSoon = () => {};
globalThis.publishAudit = () => {};
globalThis.reportMaybeCapture = () => {};
globalThis.broadcastLlmHide = (it) => calls.hide.push(it.t);
globalThis.broadcastLlmUnhide = (it) => calls.unhide.push(it.t);
globalThis.shouldMuteAuthor = () => true;
globalThis.addMute = (a) => calls.mute.push(a);
globalThis.removeMute = (k) => {
  calls.unmute.push(k);
  delete globalThis.mutedUsers[k];
};
globalThis.noteLearnReveal = (w) => calls.reveal.push(w);
globalThis.behLog = (k, o) => calls.beh.push(k + ':' + JSON.stringify(o));
globalThis.nickKey = (n) => String(n || '').trim().toLowerCase();
globalThis.mutedUsers = {};

const code = [
  'var fullAudit = false, revisedCount = 0, ftRev = 0, shotsCache = "", shotsCacheN = "", ftLog = [];',
  between('const IDLE = {', '\nlet lastWatchAt'),
  between('function siteOf(channel)', '\nfunction isSelf'),
  between('function idleSkipSource', '\n// Relecteur gratuit'),
  between('function shotsFromNegatives', '\nfunction authorVelocity'),
  'Object.assign(globalThis, { IDLE, idleSkipSource, idleCandidates, applyIdleVerdict, releaseAfterRevise,' +
    ' shotsFromNegatives, setFull: (v) => { fullAudit = v; }, setLog: (v) => { ftLog = v; }, getRev: () => ftRev });'
].join('\n');

// eslint-disable-next-line no-eval
eval(code);
const { idleCandidates, applyIdleVerdict, shotsFromNegatives, setFull, setLog, getRev } = globalThis;

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

const DAY = 86400000;
function row(o) {
  return Object.assign({ id: 'i' + Math.random(), author: 'bob', text: 'un message', label: 'mute', source: 'llm', score: 0.9, ts: Date.now() }, o);
}
function texts(rows) {
  return rows.map((r) => r.text).sort();
}

console.log('\n--- ce qui entre dans la relecture ---');
const log = [
  row({ text: 'jamais relu', source: 'llm', label: 'keep', reviewed: 0 }),
  row({ text: 'local liste', source: 'keyword', reviewed: 0 }),
  row({ text: 'local appris', source: 'appris', term: 'trouduc', reviewed: 0 }),
  row({ text: 'local harsh', source: 'harsh', reviewed: 0 }),
  row({ text: 'mot perso', source: 'extra', reviewed: 0 }),
  row({ text: 'politique', source: 'politique', reviewed: 0 }),
  row({ text: 'copypasta', source: 'copypasta', reviewed: 0 }),
  row({ text: 'relu hier', source: 'llm', reviewed: 1, reviewedAt: Date.now() - 2 * DAY }),
  row({ text: 'relu a l instant', source: 'llm', reviewed: 1, reviewedAt: Date.now() - 1000 }),
  row({ text: 'abandonne', source: 'perdu', label: 'dropped', reviewed: 0 })
];
setLog(log);

setFull(false);
check('normal : seules les lignes jamais relues et non locales', texts(idleCandidates(20)), ['jamais relu']);

setFull(true);
check(
  'complet : les verdicts locaux entrent, plus le 2e passage',
  texts(idleCandidates(20)),
  ['jamais relu', 'local appris', 'local harsh', 'local liste', 'relu hier']
);
check('complet : les mots de l utilisateur restent hors de portee', idleCandidates(20).some((r) => r.source === 'extra'), false);
check('complet : la politique reste hors de portee', idleCandidates(20).some((r) => r.source === 'politique'), false);
check('complet : le copypasta reste hors de portee', idleCandidates(20).some((r) => r.source === 'copypasta'), false);
check('complet : une ligne relue il y a moins d un jour attend', idleCandidates(20).some((r) => r.text === 'relu a l instant'), false);
check('complet : une ligne abandonnee ne revient pas', idleCandidates(20).some((r) => r.label === 'dropped'), false);

// Le rattrapage ne doit jamais retarder un premier jugement.
const first = idleCandidates(4);
check('les jamais-relues passent devant le 2e passage', first.some((r) => r.text === 'jamais relu'), true);
check('le lot respecte sa taille', first.length, 4);

console.log('\n--- ce que defait un blocage local dementi ---');
setFull(true);
globalThis.mutedUsers = { bob: { at: 1, pct: 95, strikes: 'appris' } };
const seul = row({ text: 'sa mere bosse a l hopital', source: 'appris', term: 'sa mere', label: 'mute' });
setLog([seul]);
calls.unhide.length = 0;
calls.unmute.length = 0;
calls.reveal.length = 0;
const act = applyIdleVerdict(seul, { tag: 'ok', score: 0.05, pol: false }, { id: 'gemma' });
check('verdict', act, 'revise');
check('la ligne repasse en keep', seul.label, 'keep');
check('la ligne est marquee relue', [seul.reviewed, typeof seul.reviewedAt], [1, 'number']);
check('le chat la reaffiche', calls.unhide.length, 1);
check('le mute de son auteur tombe', calls.unmute, ['bob']);
check('le terme appris est mis en cause', calls.reveal, ['sa mere']);

// Un auteur qui a d'autres lignes mutees reste muet : on defait UNE ligne.
globalThis.mutedUsers = { bob: { at: 1, pct: 95, strikes: 'liste' } };
const une = row({ text: 'premiere ligne', source: 'keyword', label: 'mute' });
const autre = row({ text: 'ferme ta gueule', source: 'keyword', label: 'mute' });
setLog([une, autre]);
calls.unmute.length = 0;
applyIdleVerdict(une, { tag: 'ok', score: 0.05, pol: false }, { id: 'gemma' });
check('auteur encore mute ailleurs -> on ne le libere pas', calls.unmute, []);

// Mute permanent (politique) : jamais leve automatiquement.
globalThis.mutedUsers = { bob: { at: 1, pct: 99, strikes: 'politique', perm: true } };
const perm = row({ text: 'ligne locale', source: 'vitality', label: 'mute' });
setLog([perm]);
calls.unmute.length = 0;
applyIdleVerdict(perm, { tag: 'ok', score: 0.05, pol: false }, { id: 'gemma' });
check('mute permanent conserve', calls.unmute, []);

console.log('\n--- hors verification complete, rien ne bouge en local ---');
setFull(false);
globalThis.mutedUsers = { bob: { at: 1, pct: 95, strikes: 'liste' } };
const garde = row({ text: 'ferme ta gueule', source: 'keyword', label: 'mute' });
setLog([garde]);
calls.unmute.length = 0;
applyIdleVerdict(garde, { tag: 'ok', score: 0.05, pol: false }, { id: 'gemma' });
check('un verdict local reste intact', [garde.label, garde.source], ['mute', 'keyword']);
check('et son auteur reste mute', calls.unmute, []);

console.log('\n--- un verdict local confirme garde sa provenance ---');
setFull(true);
const conf = row({ text: 'ferme ta gueule', source: 'keyword', label: 'mute' });
setLog([conf]);
applyIdleVerdict(conf, { tag: 'ok', score: 0.95, pol: false }, { id: 'gemma' });
check('confirme -> toujours mute', conf.label, 'mute');
check('confirme -> source conservee', conf.source, 'keyword');

console.log('\n--- les exemples du prompt suivent les corrections ---');
// Le cache ne tenait qu a la LONGUEUR du journal : une correction ne la change
// pas, donc le prompt citait encore en exemple le verdict qu on venait de
// corriger — l erreur se reinjectait dans le modele a chaque appel.
const a = row({ text: 'exemple corrige', source: 'keyword', label: 'mute' });
setLog([a]);
const before = shotsFromNegatives();
check('exemple present cote mute', before.indexOf('mute: "exemple corrige"') !== -1, true);
const rev = getRev();
applyIdleVerdict(a, { tag: 'ok', score: 0.05, pol: false }, { id: 'gemma' });
check('une correction incremente la revision du journal', getRev() > rev, true);
const after = shotsFromNegatives();
check('le cache est refait', after !== before, true);
check("l exemple a change de cote", after.indexOf('keep: "exemple corrige"') !== -1, true);

console.log(fails ? '\n' + fails + ' ECHEC(S)\n' : '\ntout est vert\n');
process.exit(fails ? 1 : 0);
