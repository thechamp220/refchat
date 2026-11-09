'use strict';

// Contrat moteur multi-fournisseurs : SuperGrok (OAuth), clés API (Google, Z.ai,
// xAI) et endpoint OpenAI-compatible personnalisé.

const fs = require('node:fs');
const path = require('node:path');
const { bench, checker } = require('./bench');

const T = checker();
const check = T.check;
const b = bench();
const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

const chain = b.run('CHAIN');
check('chain multi-fournisseurs', chain.length >= 8, true);
check('Grok 4.6 en tete de CHAIN', chain[0].id, 'grok-4.6');
check('reflexion basse', chain[0].effort, 'low');
check('timeout porte a 30 secondes', chain[0].ms, 30000);
check('lane xAI', chain[0].key, 'xai');

const oauth = { access: 'oauth-ok', refresh: 'refresh', expires: Date.now() + 3600000 };
const cleaned = b.run('splitKeys')({
  googleKey: 'google-secret',
  glmKey: 'glm-secret',
  xaiKey: 'xai-secret',
  customUrl: 'https://openrouter.ai/api/v1',
  customModel: 'meta-llama/llama-3.3-70b-instruct',
  customKey: 'custom-secret',
  xaiOAuth: oauth
});
check('splitKeys conserve les cles multi-fournisseurs', [
  cleaned.googleKey,
  cleaned.glmKey,
  cleaned.xaiKey,
  cleaned.customUrl,
  cleaned.customModel,
  cleaned.customKey,
  cleaned.xaiOAuth.access
], [
  'google-secret',
  'glm-secret',
  'xai-secret',
  'https://openrouter.ai/api/v1',
  'meta-llama/llama-3.3-70b-instruct',
  'custom-secret',
  'oauth-ok'
]);
check('OAuth ouvre Grok', b.run('laneKey')(cleaned, chain[0]), 'oauth-ok');
check('cle xAI ouvre aussi Grok sans OAuth', b.run('laneKey')({ xaiKey: 'xai-secret' }, chain[0]), 'xai-secret');
const googleLane = chain.find((l) => l.key === 'google');
check('cle Google ouvre Gemini/Gemma', b.run('laneKey')(cleaned, googleLane), 'google-secret');
const customLane = chain.find((l) => l.key === 'custom');
check('endpoint custom ouvre custom-openai (meme sans cle pour Ollama)', b.run('laneKey')({ customUrl: 'http://localhost:11434/v1', customModel: 'llama3' }, customLane), 'local');

check('permission Google presente', manifest.host_permissions.some((p) => p.includes('googleapis.com')), true);
check('permission Z.ai presente', manifest.host_permissions.some((p) => p.includes('api.z.ai')), true);
check('permission xAI gardee', manifest.host_permissions.some((p) => p.includes('api.x.ai')), true);
const goLane = chain.find((l) => l.key === 'go');
check('lane OpenCode Go presente', goLane && goLane.id, 'deepseek-v4.1-flash');
check('OpenCode Go coupe le raisonnement', goLane && b.run('chatBody')(goLane, 's', 'u', 64).reasoning_effort, 'none');
check('splitKeys garde la cle OpenCode Go', b.run('splitKeys')({ goKey: 'sk-go-secret' }).goKey, 'sk-go-secret');
const oddGo = b.run('splitKeys')({ goKey: 'oc_go_Ab12Cd34Ef56', googleKey: 'AIza-google' });
check('cle Go sans sk- reste dans OpenCode', [oddGo.goKey, oddGo.googleKey], ['oc_go_Ab12Cd34Ef56', 'AIza-google']);
check('cle Go sans sk- pas prise pour Google', b.run('splitKeys')({ goKey: 'oc_go_Ab12Cd34Ef56' }).googleKey, '');
check('ancien apiKey sk- toujours range dans OpenCode', b.run('splitKeys')({ apiKey: 'sk-legacy' }).goKey, 'sk-legacy');
check('cle OpenCode Go ouvre DeepSeek', b.run('laneKey')({ goKey: 'sk-go-secret' }, goLane), 'sk-go-secret');
const haikuLane = chain.find((l) => l.id === 'claude-haiku-5-5');
check('lane Haiku 5.5 sur OpenCode Go', haikuLane && haikuLane.url === goLane.url && haikuLane.key, 'go');
check('cle OpenCode Go ouvre Haiku 5.5', b.run('laneKey')({ goKey: 'sk-go-secret' }, haikuLane), 'sk-go-secret');
check('Haiku 5.5 coupe sa reflexion cachee', b.run('chatBody')(haikuLane, 's', 'u', 64).reasoning_effort, 'none');
check('Haiku 5.5 sans reserve de reflexion', b.run('thinkBudget')(haikuLane, 12), 0);
check('Haiku 5.5 impose la longueur des tableaux', haikuLane.schema, true);
check('DeepSeek sans schema impose', !!goLane.schema, false);
check('tryLane passe le schema aux lanes schema', /lane\.schema \? batchResponseFormat\(items\.length\) : null/.test(src), true);
check('cle OpenCode Go compte comme cle', b.run('hasAnyKey')({ goKey: 'sk-go-secret' }), true);
check('en-tete x-opencode-session envoye', /headers\['x-opencode-session'\]/.test(src), true);
check('permission OpenCode presente', manifest.host_permissions.some((p) => p.includes('opencode.ai')), true);
check('trois reprises de lot', /attempt < 3/.test(src), true);
check('reprise MV3 persistante', /pause temporaire, reprise automatique/.test(src), true);

// Diagnostic envoyé à archive-server (GET /diag.json) : erreurs lisibles, jamais la clé.
b.run('engineCache.goKey = "sk-go-diag-secret"');
b.run('noteLaneFail')(haikuLane, 'llm_http_401 cle refusee', 20000);
const diag = b.run('safeDiag')();
check('diag : erreur de lane notee', diag.errs.some((e) => e.lane === 'claude-haiku-5-5' && /llm_http_401/.test(e.msg)), true);
check('diag : longueur de la cle sans la cle', [diag.goKey.len, JSON.stringify(diag).includes('sk-go-diag-secret')], [17, false]);
check('diag : etat de la lane Haiku', typeof diag.lanes['claude-haiku-5-5'].streak, 'number');
check('diag part avec la copie de la file', /diag: safeDiag\(\)/.test(src), true);

console.log(T.fails ? '\n' + T.fails + ' ECHEC(S)\n' : '\ntout est vert\n');
process.exit(T.fails ? 1 : 0);
