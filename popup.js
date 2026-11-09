'use strict';

// Popup volontairement court : santé de la chaîne, compteurs, interrupteurs,
// modèles, mots bannis. Tout ce qui demande de la place (mutés, journal,
// auteurs) vit dans board.html, ouvert en onglet.

const $ = (id) => document.getElementById(id);
let liveUi = { mode: 'off', ready: false, state: {}, active: [] };
let laneWanted = null;
let lanesHidden = true;

// 12 840, pas 12840 : un compteur se lit d'un coup d'œil ou pas du tout.
const NF = new Intl.NumberFormat('fr-FR');
const fmt = (n) => NF.format(Number(n) || 0);

function isRateLimited(audit) {
  if (!audit) return false;
  const picked = Array.isArray(audit.lanes) && audit.lanes.find((lane) => lane && lane.picked);
  if (picked) return picked.status === 'limit';
  if (audit.cooldownUntil && Date.now() < audit.cooldownUntil) return true;
  return !!audit.rateLimited;
}

// Version du code que le service worker exécute vraiment (champ `code` de
// CSG_AUDIT_STATS). null tant qu'il n'a pas répondu : la copie de storage ne
// compte pas, elle peut dater d'avant le rechargement.
let liveCode = null;

// -1, 0 ou 1, numéro par numéro (même règle que background.js).
function versionCmp(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Rend la version du manifest quand le fond exécute un code plus ancien, sinon ''.
// Vu le 2026-11-09 : après une relance, Brave relit le manifest (popup en v3.39.6)
// mais garde l'ancien service worker, et la correction ne tourne pas. Un fond
// sans champ `code` date d'avant la 3.39.6.
function staleWorker() {
  if (liveCode === null) return '';
  let want = '';
  try {
    want = chrome.runtime.getManifest().version;
  } catch (_) {
    return '';
  }
  if (!want) return '';
  return liveCode === '' || versionCmp(liveCode, want) < 0 ? want : '';
}

// Auto-réparation : le popup est relu sur le disque à chaque ouverture, il tourne
// donc sur le code neuf même quand Brave garde l'ancien fond. Il recharge alors
// l'extension, comme ↻ (vérifié dans un Brave isolé : le nouveau fond démarre).
// Garde-fou partagé avec le fond (csg_selfheal) : deux essais au plus par
// version et par tranche de 10 minutes, ensuite on demande ↻.
const SELF_HEAL = { KEY: 'csg_selfheal', MAX: 2, WINDOW_MS: 600000, DELAY_MS: 1200 };
let healState = null; // null | 'pending' | 'reload' | 'blocked'

function paintStale(want) {
  const el = $('status');
  const was = liveCode ? 'v' + liveCode : 'une version antérieure à la 3.39.6';
  el.className = 'status';
  el.title = '';
  if (healState === 'blocked') {
    el.textContent = 'Le fond de Refchat tourne toujours sur l’ancien code (' + was + ', popup v' + want +
      ') · dans brave://extensions, clique sur ↻ sous Refchat.';
    el.classList.add('bad');
    return 'bad';
  }
  el.textContent = 'Refchat se met à jour : son fond tournait encore sur l’ancien code (' + was +
    '). Rechargement automatique : le popup va se fermer, rouvre-le dans quelques secondes.';
  return 'warn';
}

function healStaleWorker(want) {
  if (healState) return;
  healState = 'pending';
  try {
    chrome.storage.local.get({ [SELF_HEAL.KEY]: null }, (v) => {
      const prev = v && v[SELF_HEAL.KEY];
      const now = Date.now();
      const same = !!prev && prev.want === want && now - (Number(prev.at) || 0) < SELF_HEAL.WINDOW_MS;
      const n = same ? Number(prev.n) || 0 : 0;
      if (n >= SELF_HEAL.MAX || typeof chrome.runtime.reload !== 'function') {
        healState = 'blocked';
        paintStale(want);
        return;
      }
      healState = 'reload';
      chrome.storage.local.set({ [SELF_HEAL.KEY]: { want, from: liveCode || '', at: now, n: n + 1, by: 'popup' } }, () => {
        // Le temps de lire le message : le popup se ferme avec le rechargement.
        setTimeout(() => {
          try {
            chrome.runtime.reload();
          } catch (_) {}
        }, SELF_HEAL.DELAY_MS);
      });
    });
  } catch (_) {
    healState = 'blocked';
  }
}

// Un crash du service worker ne se voyait nulle part : il faut avoir la console
// de chrome://extensions ouverte au bon moment. Tant qu'il est frais, il passe
// devant tout le reste — c'est l'explication de tous les autres symptomes.
// Renvoie la tonalité de la carte santé : ok | warn | bad.
function paintStatus(audit, hasKey, crash, why) {
  const el = $('status');
  el.className = 'status';
  el.title = '';
  // Passe avant tout : le reste de l'écran vient alors d'un autre code que celui-ci.
  const want = staleWorker();
  if (want) {
    healStaleWorker(want);
    return paintStale(want);
  }
  if ($('enabled').checked === false) {
    el.textContent = 'Capture désactivée · les captures restent analysables au clic.';
    return 'warn';
  }
  // La raison de capture passe AVANT l'etat des modeles : quand le content
  // script ne prend rien, les lanes restent au vert et les compteurs figes, ce
  // qui ressemble a « tout va bien » alors que rien n'entre. C'etait le seul
  // diagnostic de l'extension et il ne vivait que dans le HUD sur le stream —
  // personne d'autre n'interrogeait CSG_PAGE_STATS.
  if (why && why !== 'ok') {
    el.textContent = 'Rien n’est capturé — ' + why;
    el.title = why;
    // Filtre coupé à la main : un choix, pas une panne.
    if (/désactivé/.test(why)) return 'warn';
    el.classList.add('bad');
    return 'bad';
  }
  if (crash && Date.now() - crash.at < 3600000) {
    el.textContent = 'Planté (' + crash.where + ') : ' + crash.msg;
    el.title = crash.stack || crash.msg;
    el.classList.add('bad');
    return 'bad';
  }
  if (!hasKey) {
    el.textContent = why === 'ok'
      ? 'Capture active · connecte SuperGrok ou une clé API (ou analyse locale au clic).'
      : 'Connecte SuperGrok ou une clé API (ou analyse locale au clic).';
    el.classList.add('ok');
    return 'warn';
  }
  if (audit && audit.bulk && audit.bulk.running) {
    const done = Number(audit.bulk.peopleDone) || 0;
    const total = Number(audit.bulk.peopleTotal) || Number(audit.bulk.total) || 0;
    const err = audit.bulk.err ? ' · ' + audit.bulk.err : '';
    el.textContent = 'Analyse ' + done + '/' + total + ' personnes' + (audit.bulk.current ? ' · ' + audit.bulk.current : '') + err;
    el.classList.add(audit.bulk.err ? 'bad' : 'ok');
    return audit.bulk.err ? 'bad' : 'ok';
  }
  const picked = audit && Array.isArray(audit.lanes) && audit.lanes.find((lane) => lane && lane.picked);
  if (picked && (picked.status === 'err' || picked.status === 'limit' || picked.status === 'nokey')) {
    el.textContent = !picked.label && !picked.detail && audit && audit.label
      ? audit.label
      : (picked.label || picked.id || 'Modèle') + ' · ' + (picked.detail || picked.status);
    el.title = (audit && audit.lastError) || picked.detail || '';
    el.classList.add('bad');
    return 'bad';
  }
  if (audit && audit.bulk && audit.bulk.err) {
    el.textContent = audit.bulk.err;
    el.classList.add('bad');
    return 'bad';
  }
  if (liveUi.mode !== 'off' && liveUi.state && liveUi.state.err) {
    el.textContent = 'IA en direct · ' + liveUi.state.err;
    el.classList.add('bad');
    return 'bad';
  }
  if (liveUi.mode === 'on') {
    el.textContent = 'IA en direct · file de personnes au fil du chat';
    el.classList.add('ok');
    return 'ok';
  }
  if (audit && audit.judge === false) {
    el.textContent = (why === 'ok' ? 'Capture seule' : 'Captures conservées') + ' · ' + fmt(audit.waiting != null ? audit.waiting : audit.queue) + ' à analyser au clic';
    el.title = 'Aucun jugement automatique pendant le chat.';
    el.classList.add('ok');
    return 'warn';
  }
  const state = (audit && audit.state) || 'idle';
  if (isRateLimited(audit)) {
    // Un seul modele juge : « toutes les lanes » n'avait plus de sens.
    el.textContent = 'Rate limit sur le modèle choisi';
    el.classList.add('bad');
    return 'bad';
  }
  if (state === 'offline') {
    el.textContent = audit.label || audit.lastError || 'Clé refusée / hors ligne';
    el.classList.add('bad');
    return 'bad';
  }
  const label = (audit && audit.label) || 'prêt';
  el.textContent = label === 'prêt'
    ? 'Prêt'
    : (state === 'running' || state === 'queued' ? 'Filtre · ' : 'Prêt · ') + label;
  el.classList.add('ok');
  return 'ok';
}

function paintLed(audit, hasKey) {
  const led = $('led');
  led.className = 'led';
  if (!hasKey) {
    led.classList.add('off');
    led.title = 'Mode local (aucune clé IA active)';
    return;
  }
  const picked = audit && Array.isArray(audit.lanes) && audit.lanes.find((lane) => lane && lane.picked);
  if (picked && (picked.status === 'err' || picked.status === 'limit' || picked.status === 'nokey')) {
    led.classList.add('red');
    led.title = picked.detail || 'Erreur modèle';
    return;
  }
  if (audit && audit.bulk && audit.bulk.err && !audit.bulk.running) {
    led.classList.add('red');
    led.title = audit.bulk.err;
    return;
  }
  if (liveUi.mode !== 'off') {
    led.classList.add(liveUi.state && liveUi.state.err ? 'red' : 'green');
    led.title = liveUi.state && liveUi.state.err ? liveUi.state.err : 'IA en direct active';
    return;
  }
  if (audit && audit.judge === false) {
    led.classList.add('gold');
    led.title = 'Jugement coupé';
    return;
  }
  if (isRateLimited(audit) || (picked && (picked.status === 'err' || picked.status === 'nokey'))) {
    led.classList.add('red');
    led.title = isRateLimited(audit) ? 'Rate limit' : picked.detail || 'Erreur modèle';
    return;
  }
  led.classList.add('green');
  led.title = 'OK';
}

// --- Chaîne capture → modèles → réponses --------------------------------------
// La phrase d'état ne dit que la PIRE panne. Les trois maillons disent où
// chacune se loge, en même temps : capture morte ET quota, par exemple.
function setStep(id, tone, value, title) {
  const li = $(id);
  if (!li) return;
  li.className = 'step' + (tone ? ' ' + tone : '');
  const v = li.querySelector('.v');
  if (!v) return;
  v.textContent = value;
  v.title = title || value;
}

function shortChan(c) {
  const s = String(c || '');
  const i = s.indexOf('/');
  return i > 0 ? s.slice(i + 1) : s;
}

function shortModel(lane) {
  const name = String((lane && (lane.label || lane.id)) || '');
  return name.replace(/\s*\([^)]*\)/g, '').replace(/ non-thinking.*$/i, '');
}

function paintChain(audit, hasKey, why, page) {
  const a = audit || {};

  if ($('enabled').checked === false) {
    setStep('stepCap', 'warn', 'filtre coupé', 'La capture est désactivée dans les réglages.');
  } else if (why === 'ok') {
    const p = page || {};
    const bits = [p.channel || 'chat capté', fmt(p.captured) + ' messages lus'];
    if (p.pageBlocked) bits.push(fmt(p.pageBlocked) + ' masqués');
    setStep('stepCap', 'ok', shortChan(p.channel) || 'captée', bits.join(' · '));
  } else if (why) {
    const off = /désactivé/.test(why);
    const short = off ? 'filtre coupé' : /pas de chat/.test(why) ? 'pas de chat' : /pas un live/.test(why) ? 'pas un live' : why;
    setStep('stepCap', off ? 'warn' : 'bad', short, why);
  } else {
    setStep('stepCap', '', 'aucun chat ici', 'L’onglet actif n’est pas un chat Twitch ou Kick.');
  }

  const lanes = Array.isArray(a.lanes) ? a.lanes : [];
  // Un seul modele juge : l'etape parle de LUI, pas d'un total de lanes. Un
  // « 3 / 10 dispo » serait faux — les neuf autres ne jugent rien.
  const picked = lanes.find((l) => l && l.picked) || null;
  const label = picked ? picked.label || picked.id : '';
  if (!hasKey) setStep('stepLlm', 'warn', 'mode local');
  else if (picked && (picked.status === 'err' || picked.status === 'limit' || picked.status === 'nokey')) {
    setStep('stepLlm', 'bad', shortModel(picked) + ' · ' + (picked.detail || picked.status), label);
  } else if (liveUi.mode !== 'off') setStep('stepLlm', 'ok', 'sur le direct');
  else if (a.judge === false) setStep('stepLlm', 'warn', 'au clic uniquement');
  else if (a.state === 'offline') setStep('stepLlm', 'bad', 'hors ligne', a.lastError || '');
  else if (!lanes.length) setStep('stepLlm', '', '…');
  else if (!picked) setStep('stepLlm', 'bad', 'Modèle indisponible', 'Vérifie ta clé API ou connexion.');
  else if (picked.status === 'ready' || picked.status === 'busy') setStep('stepLlm', 'ok', shortModel(picked) + ' · ' + (picked.detail || 'prêt'), label);
  else setStep('stepLlm', 'bad', shortModel(picked) + ' · ' + (picked.detail || picked.status), label);

  const skipped = Number(a.skipped) || 0;
  if (liveUi.mode !== 'off' && liveUi.state && liveUi.state.err) {
    setStep('stepOut', 'bad', 'erreur direct', liveUi.state.err);
  } else if (liveUi.mode !== 'off' && liveUi.state && liveUi.state.seen > 0) {
    setStep('stepOut', 'ok', 'direct lisible');
  } else if (skipped) {
    setStep('stepOut', 'warn', fmt(skipped) + ' ignoré' + (skipped > 1 ? 's' : ''), 'Ces lignes n’ont pas été lues : ni acceptées ni rejetées.');
  } else if (Number(a.judged) > 0) {
    setStep('stepOut', 'ok', 'lisibles');
  } else {
    setStep('stepOut', '', 'aucun lot');
  }
}

const FALLBACK_LANES = [
  { id: 'glm-4.5-flash', label: 'GLM 4.5 Flash (Z.ai)', tier: 'fast' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', tier: 'fast' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', tier: 'fast' },
  { id: 'gemma-4-26b-a4b-it', label: 'Gemma 4 26B', tier: 'fast' },
  { id: 'gemma-4-31b-it', label: 'Gemma 4 31B', tier: 'fast' },
  { id: 'grok-4.6', label: 'Grok 4.6 (xAI)', tier: 'fast' },
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek v4.1 Flash (OpenCode Go)', tier: 'fast' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (OpenCode Go)', tier: 'fast' },
  { id: 'custom-openai', label: 'API Compatible OpenAI', tier: 'fast' }
];

function compact(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return Math.round(v / 1000) + ' k';
  if (v >= 1000) return (v / 1000).toFixed(1).replace('.', ',') + ' k';
  return String(v);
}

function secs(ms) {
  const v = Number(ms) || 0;
  if (v < 1000) return v + ' ms';
  return (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace('.', ',') + ' s';
}

// Un seul modele juge le chat. La deroulante liste toute la chaine, y compris
// les lanes sans cle (dites comme telles) : choisir l'une d'elles est un choix
// legitime — la cle s'ajoute juste apres, dans le meme popup.
function paintLanePick(rows) {
  const sel = $('laneSel');
  if (!sel || !sel.dataset || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  const live = rows.find((l) => l.picked);
  const want = (live && live.id) || laneWanted;
  // On ne reconstruit les options que si la liste ou l'etat des cles change :
  // reecrire un <select> a chaque tick de 1,5 s fermerait le menu ouvert.
  const sig = rows.map((l) => l.id + (l.status === 'nokey' ? '!' : '')).join('|');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.textContent = '';
    for (const l of rows) {
      const o = document.createElement('option');
      o.value = l.id;
      o.textContent = (l.label || l.id) + (l.status === 'nokey' ? ' · pas de clé' : '');
      sel.appendChild(o);
    }
  }
  if (want && !rows.some((l) => l.id === want)) {
    // Id enregistre qui n'est plus dans la chaine : on le montre au lieu de
    // laisser le <select> designer silencieusement un autre modele.
    const o = document.createElement('option');
    o.value = want;
    o.textContent = want + ' · inconnu';
    sel.appendChild(o);
  }
  if (document.activeElement !== sel && want && sel.value !== want) sel.value = want;
}

function paintLanes(audit) {
  const list = $('lanes');
  if (!list || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  const live = !!(audit && Array.isArray(audit.lanes) && audit.lanes.length);
  let rows = live
    ? audit.lanes
    : FALLBACK_LANES.map((l) => Object.assign({ status: 'nokey', detail: '…' }, l));
  const extraGrok = [
    { id: 'grok-4.6', label: 'Grok 4.6 (xAI)', tier: 'fast', status: 'nokey', detail: '…' }
  ];
  for (const g of extraGrok) {
    if (!rows.some((l) => l && l.id === g.id)) rows = rows.concat([g]);
  }
  paintLanePick(rows);
  list.textContent = '';
  // Plié : la déroulante reste à jour, mais on ne fabrique pas les lignes —
  // elles se rebâtissent toutes les 1,5 s pour rien si personne ne les lit.
  if (lanesHidden) { paintLaneSum(rows, live); return; }
  for (const lane of rows) {
    const li = document.createElement('li');
    // La liste n'est plus un choix : c'est le tableau de bord. Elle garde le
    // statut et les stats de TOUS les modeles ; celui qui juge porte `picked`.
    li.className = 'lane ' + (lane.status || 'ready') + (lane.picked ? ' picked' : '');
    if (lane.picked) li.title = 'C’est ce modèle qui juge le chat';

    const dot = document.createElement('span');
    dot.className = 'dot';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = lane.label || lane.id;
    name.title = (lane.label || lane.id) + (lane.label ? ' — ' + lane.id : '');

    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = lane.detail || lane.status || '';
    st.title = st.textContent;

    // Deuxième ligne sur toute la largeur : la colonne statut tronquait les
    // noms de modèles quand la perf y vivait.
    const meta = document.createElement('span');
    meta.className = 'meta';
    const role = document.createElement('small');
    // « profond » et pas « relecture » : ces lanes confirment les flags en direct,
    // la relecture automatique hors live n'existe plus.
    role.textContent = [
      lane.tier === 'deep' ? 'profond' : lane.tier === 'fast' ? 'rapide' : '',
      lane.paid ? 'payant' : lane.free ? 'gratuit' : ''
    ]
      .filter(Boolean)
      .join(' · ');
    meta.appendChild(role);

    // Perf mesurée : c est ce chiffre qui dit si un relais gratuit vaut le coup.
    const s = lane.stats;
    if (s && s.calls) {
      const fail = Math.round((s.fails / s.calls) * 100);
      const perf = document.createElement('small');
      perf.className = 'perf';
      perf.textContent = (s.avgMs ? secs(s.avgMs) : '—') + ' · ' + compact(s.calls) + ' appels';
      if (fail) {
        const em = document.createElement('em');
        em.textContent = ' · ' + fail + ' % échecs';
        if (fail >= 10) em.className = 'hi';
        perf.appendChild(em);
      }
      perf.title = (s.avgMs ? s.avgMs + ' ms en moyenne' : 'latence inconnue') + ' · ' + s.calls + ' appels · ' + s.fails + ' échecs';
      meta.appendChild(perf);
    }

    li.appendChild(dot);
    li.appendChild(name);
    li.appendChild(st);
    li.appendChild(meta);
    list.appendChild(li);
  }

  paintLaneSum(rows, live);
}

// Le nom du juge et son état : c'est ce qui reste visible quand les stats sont
// pliées, sinon le pli ferait disparaître l'info utile avec le diagnostic.
function paintLaneSum(rows, live) {
  const sum = $('laneSum');
  if (!sum || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  sum.textContent = '';
  if (!live) return;
  // Le nom est déjà dans la déroulante juste au-dessus : ici, seulement l'état.
  const picked = rows.find((l) => l.picked);
  const st = picked ? picked.status || 'ready' : '';
  sum.title = picked ? picked.label || picked.id : 'Un seul modèle juge le chat — choisis-le dans la liste';
  sum.className = st === 'ready' || st === 'busy' ? 'ok' : st === 'limit' || st === 'err' ? 'bad' : '';
  sum.textContent = picked ? 'État : ' + (picked.detail || st) : 'Aucun modèle choisi';
}

function paintCounters(audit) {
  const a = audit || {};
  const accepted = Number(a.accepted) || 0;
  const rejected = Number(a.rejected) || 0;
  const waiting = Number(a.waiting != null ? a.waiting : a.queue) || 0;
  const captured = Number(a.ftTotal != null ? a.ftTotal : a.ftStored) || 0;
  const judged = Number(a.judged) || 0;
  const capEl = $('nCaptured');
  if (capEl) capEl.textContent = fmt(captured);
  // Ancien id : popup.html en cache apres upgrade — ne pas planter.
  const judgedEl = $('nJudged');
  if (judgedEl) judgedEl.textContent = fmt(judged);
  $('nWaiting').textContent = fmt(waiting);
  $('nAccepted').textContent = fmt(accepted);
  $('nRejected').textContent = fmt(rejected);

  const decided = accepted + rejected;
  const split = $('split');
  if (split) {
    const acc = split.querySelector('.acc');
    const wait = split.querySelector('.wait');
    const rej = split.querySelector('.rej');
    if (acc) {
      acc.style.flex = accepted + ' 1 0';
      acc.style.display = accepted ? '' : 'none';
    }
    if (wait) {
      wait.style.flex = waiting + ' 1 0';
      wait.style.display = waiting ? '' : 'none';
    }
    if (rej) {
      rej.style.flex = rejected + ' 1 0';
      rej.style.display = rejected ? '' : 'none';
    }
  }
  const note = $('rejectRate');
  if (note) {
    const bits = [];
    if (judged) bits.push(fmt(judged) + ' analysés');
    if (decided) {
      bits.push(
        ((rejected / decided) * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' % rejetés'
      );
    }
    if (waiting) bits.push(fmt(waiting) + ' en file');
    note.textContent = bits.join(' · ');
  }

  const waitCard = $('nWaiting') && $('nWaiting').closest('.stat');
  if (waitCard) waitCard.classList.toggle('warn', waiting > 0);

  const skipEl = $('nSkipped');
  if (!skipEl) return;
  const skipped = Number(a.skipped) || 0;
  skipEl.textContent = fmt(skipped);
  const card = skipEl.closest('.stat');
  if (card) card.classList.toggle('warn', skipped > 0);
}

function paintAll(audit, hasKey, crash, why, page) {
  const tone = paintStatus(audit, hasKey, crash, why);
  const health = $('health');
  if (health) health.className = 'card health ' + tone;
  paintLed(audit, hasKey);
  paintChain(audit, hasKey, why, page);
  paintLanes(audit);
  paintCounters(audit);
  paintAnalyze(audit, hasKey);
  lastAudit = audit;
}

function paintAnalyze(audit, hasKey) {
  const button = $('analyzeCaptured');
  const status = $('analyzeStatus');
  if (!button || !status) return;
  const a = audit || {};
  const bulk = a.bulk || {};
  const stop = $('stopAnalyze');
  const progress = $('analyzeProgress');
  if (stop) {
    stop.hidden = !bulk.running && !bulk.stopping;
    // Caché, il restait cliquable par le clavier et par click() : un arrêt à
    // vide enregistrait « interrompu à la demande » sur un journal vide.
    stop.disabled = !bulk.running || !!bulk.stopping;
    stop.textContent = bulk.stopping ? 'Arrêt en cours…' : 'Arrêter l’analyse';
  }
  if (progress) {
    const total = Number(bulk.peopleTotal) || 0;
    progress.hidden = !total || (!bulk.running && !bulk.stopping);
    progress.value = total ? Math.min(100, 100 * (Number(bulk.peopleDone) || 0) / total) : 0;
  }
  const waiting = Number(a.waiting != null ? a.waiting : a.queue) || 0;
  status.classList.remove('bad');
  button.classList.toggle('running', !!bulk.running);
  if (bulk.stopping) {
    button.disabled = true;
    button.textContent = 'Arrêt en cours…';
    status.textContent = 'L’appel est annulé. Les captures non traitées restent en attente.';
    return;
  }
  if (bulk.running) {
    const done = Number(bulk.peopleDone) || 0;
    const total = Number(bulk.peopleTotal) || Number(bulk.total) || 0;
    button.disabled = true;
    button.textContent = 'Analyse en cours… ' + fmt(done) + ' / ' + fmt(total);
    status.textContent = bulk.err
      ? bulk.err
      : waiting
        ? fmt(waiting) + ' message' + (waiting > 1 ? 's' : '') + ' encore dans cette analyse.'
        : 'Plus rien en attente.';
    if (bulk.err) status.classList.add('bad');
    return;
  }
  if (bulk.err) {
    button.disabled = !hasKey || waiting < 1;
    button.textContent = waiting > 0 ? 'Réessayer l’analyse' : 'Aucun message en attente';
    status.textContent = bulk.err;
    status.classList.add('bad');
    return;
  }
  button.disabled = waiting < 1;
  button.textContent = waiting > 0
    ? (codexBridgeEnabled ? 'SuperGrok : analyser ' : 'Analyser ') + fmt(waiting) + ' message' + (waiting > 1 ? 's' : '')
    : 'Aucun message en attente';
  status.textContent = codexBridgeEnabled
    ? 'Codex juge les captures toutes les 5 min sans mute automatique. Ce bouton lance SuperGrok manuellement.'
    : !hasKey
      ? 'Mode local sans clé API (mots bannis & dictionnaire) · ajoute une clé ou SuperGrok pour l’analyse IA.'
      : liveUi.mode !== 'off'
        ? 'Le direct traite les nouveaux messages. Ce bouton reprend les captures en attente.'
      : waiting > 0
        ? 'L’analyse démarre uniquement quand tu cliques ici.'
        : 'Toutes les captures du journal courant sont traitées.';
}

function liveMessage(type, extra, done) {
  chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), (res) => {
    const err = chrome.runtime.lastError;
    if (err || !res || !res.ok) {
      $('liveStatus').textContent = err ? err.message : (res && res.err) || 'Service direct indisponible.';
      $('liveStatus').classList.add('bad');
      if (done) done(false);
      return;
    }
    paintLive(res);
    if (done) done(true);
  });
}

function paintLive(status) {
  liveUi = status || { mode: 'off', ready: false, state: {}, active: [] };
  const mode = $('liveMode');
  mode.value = liveUi.mode === 'on' ? 'on' : 'off';
  const line = $('liveStatus');
  line.classList.toggle('bad', !!liveUi.err);
  if (liveUi.mode === 'on') {
    line.textContent = liveUi.running
      ? 'On · ' + (liveUi.current || 'analyse en cours')
      : 'On · file de personnes, les nouveaux messages partent tout seuls' +
        (liveUi.waiting ? ' · ' + fmt(liveUi.waiting) + ' en attente' : '');
    if (liveUi.err) line.textContent += ' · ' + liveUi.err;
  } else {
    line.textContent = 'Analyse individuelle arrêtée · analyse au clic disponible.';
  }
  line.title = '';
  if (lastAudit) paintAll(lastAudit, typedHasKey(), lastCrash, lastWhy, lastPage);
}

function refreshLiveMode() { liveMessage('CSG_LIVE_STATUS'); }

$('liveMode').addEventListener('change', (e) => {
  const mode = e.target.value;
  e.target.disabled = true;
  liveMessage('CSG_LIVE_SET_MODE', { mode }, (ok) => {
    e.target.disabled = false;
    // Un échec (filtre coupé, worker muet) a déjà écrit la cause. Relire le
    // statut juste après la remplaçait par « arrêtée » et le select restait sur On.
    if (ok) refreshLiveMode();
    else e.target.value = 'off';
  });
});

function typedHasKey() {
  if (window.__xaiOAuthHas) return true;
  if (typeof $ !== 'function') return false;
  for (const id of ['goKey', 'googleKey', 'glmKey', 'xaiKey']) {
    const el = $(id);
    if (el && String(el.value || '').trim()) return true;
  }
  const cu = $('customUrl');
  const cm = $('customModel');
  if (cu && cm && String(cu.value || '').trim() && String(cm.value || '').trim()) return true;
  return false;
}

// Demande au content script de l'onglet actif pourquoi il capture ou non. Pas
// de reponse (onglet sans chat, script pas injecte) = on ne dit rien plutot que
// d'inventer une raison.
let lastWhy = '';
let lastPage = null;
let lastCrash = null;
let refreshEpoch = 0;
function askWhy(done) {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const id = tabs && tabs[0] && tabs[0].id;
      if (chrome.runtime.lastError || id == null) return done('', null);
      chrome.tabs.sendMessage(id, { type: 'CSG_PAGE_STATS' }, (r) => {
        if (chrome.runtime.lastError || !r) return done('', null);
        done(String(r.why || ''), r);
      });
    });
  } catch (_) {
    done('', null);
  }
}

function refreshLive() {
  const epoch = ++refreshEpoch;
  chrome.storage.local.get({ csg_engine: {}, csg_audit: null, csg_crash: [] }, (v) => {
    if (epoch !== refreshEpoch) return;
    const crash = Array.isArray(v.csg_crash) && v.csg_crash.length ? v.csg_crash[0] : null;
    const eng = v.csg_engine || {};
    const hasCfgKey = !!(eng && (
      String(eng.googleKey || '').trim() ||
      String(eng.glmKey || '').trim() ||
      String(eng.goKey || '').trim() ||
      String(eng.xaiKey || '').trim() ||
      (String(eng.customUrl || '').trim() && String(eng.customModel || '').trim())
    ));
    // load oauth status
    chrome.runtime.sendMessage({ type: 'CSG_XAI_OAUTH_STATUS' }, (st) => {
      const failed = !!chrome.runtime.lastError;
      if (epoch !== refreshEpoch) return;
      if (failed) st = null;
      const hasOAuth = !!(st && st.has);
      const hasAny = hasOAuth || hasCfgKey;
      askWhy((why, page) => {
        if (epoch !== refreshEpoch) return;
        window.__xaiOAuthHas = hasAny;
        lastCrash = crash;
        lastWhy = why || '';
        lastPage = page || null;
        paintAll(v.csg_audit, hasAny, lastCrash, lastWhy, lastPage);
        paintXaiOAuth(st);
      });
    });
  });
}

// Sans filtre, les réglages visuels n'ont aucun effet.
function syncDim() {
  const on = $('enabled').checked;
  $('blankMute').disabled = !$('hideMuted').checked;
  for (const id of ['hideMuted', 'blankMute']) {
    const row = $(id).closest('.toggle, .scope-row');
    if (row) row.classList.toggle('off', !on || (id === 'blankMute' && $('blankMute').disabled));
  }
  if (lastAudit) paintAll(lastAudit, typedHasKey(), lastCrash, lastWhy, lastPage);
}

let lastAudit = null;
let ambienceError = '';

function paintAmbienceStatus() {
  $('ambienceStatus').textContent = !$('enabled').checked
    ? 'En pause · filtre désactivé.'
    : !$('ambiencePause').checked ? 'Désactivée.'
    : ambienceError ? 'Dernière erreur · ' + ambienceError
    : 'Active · analyse du chat regardé, toutes les 15 s si assez de messages.';
}

function updatePopupReportsBadge() {
  chrome.storage.local.get({ csg_reports: {} }, ({ csg_reports }) => {
    const reps = csg_reports || {};
    const todo = Object.values(reps).filter((r) => r && !r.done).length;
    const badge = $('popupRepBadge');
    if (badge) {
      badge.textContent = String(todo);
      badge.classList.toggle('hidden', todo <= 0);
      badge.classList.toggle('warn', todo > 0);
    }
  });
}

function loadSettings() {
  chrome.storage.sync.get({ csg_settings: {} }, ({ csg_settings }) => {
    $('enabled').checked = csg_settings.enabled !== false;
    $('hideMuted').checked = csg_settings.target !== 'message';
    $('blankMute').checked = csg_settings.blankMute === true;
    $('ambiencePause').checked = csg_settings.ambiencePause !== false;
    if ($('soundAlert')) $('soundAlert').checked = csg_settings.soundAlert === true;
    if ($('streamerMode')) $('streamerMode').checked = csg_settings.streamerMode === true;
    paintAmbienceStatus();
    if (document.activeElement !== $('extraWords')) {
      $('extraWords').value = csg_settings.extraWords || '';
      updateExtraWordsCount(csg_settings.extraWords);
    }
    syncDim();
    paintBaitStatus();
  });
  chrome.storage.local.get({ csg_muted: {}, csg_whitelist: {} }, ({ csg_muted, csg_whitelist }) => {
    const n = Object.keys(csg_muted || {}).length;
    if ($('quickMuteCount')) $('quickMuteCount').textContent = n === 1 ? '1 pseudo muté' : n + ' pseudos mutés';
    const w = Object.keys(csg_whitelist || {}).length;
    if ($('quickWhitelistCount')) $('quickWhitelistCount').textContent = w === 1 ? '1 protégé' : w + ' protégés';
  });
  updatePopupReportsBadge();
  refreshLive();
  chrome.storage.local.get({ csg_ambience_error: '' }, (v) => {
    ambienceError = String(v.csg_ambience_error || '');
    paintAmbienceStatus();
  });
}

function patchSettings(partial) {
  // Serialize the read + write: rapid toggles must keep each other's fields.
  if (!patchSettings.queue) patchSettings.queue = [];
  patchSettings.queue.push(Object.assign({}, partial));
  if (patchSettings.busy) return;
  const next = () => {
    if (!patchSettings.queue.length) { patchSettings.busy = false; return; }
    patchSettings.busy = true;
    const patch = Object.assign({}, ...patchSettings.queue.splice(0));
    try {
      chrome.storage.sync.get({ csg_settings: {} }, (v) => {
        if (chrome.runtime.lastError) { next(); return; }
        try {
          chrome.storage.sync.set({ csg_settings: Object.assign({}, v.csg_settings, patch) }, next);
        } catch (_) { next(); }
      });
    } catch (_) { next(); }
  };
  next();
}

$('ambiencePause').addEventListener('change', (e) => {
  paintAmbienceStatus();
  patchSettings({ ambiencePause: e.target.checked });
});

if ($('soundAlert')) {
  $('soundAlert').addEventListener('change', (e) => {
    patchSettings({ soundAlert: e.target.checked });
    try {
      localStorage.setItem('csg_sound_alert', e.target.checked ? '1' : '0');
    } catch (_) {}
    chrome.storage.local.set({ csg_sound_alert: e.target.checked });
  });
}

if ($('streamerMode')) {
  $('streamerMode').addEventListener('change', (e) => {
    patchSettings({ streamerMode: e.target.checked });
    try {
      localStorage.setItem('csg_streamer_mode', e.target.checked ? '1' : '0');
    } catch (_) {}
    chrome.storage.local.set({ csg_streamer_mode: e.target.checked });
  });
}

if ($('copyMutesBtn')) {
  $('copyMutesBtn').addEventListener('click', async () => {
    chrome.storage.local.get({ csg_muted: {} }, async ({ csg_muted }) => {
      const keys = Object.keys(csg_muted || {});
      if (!keys.length) {
        if ($('copyMutesBtn')) $('copyMutesBtn').textContent = 'Aucun muté';
        setTimeout(() => { if ($('copyMutesBtn')) $('copyMutesBtn').textContent = 'Copier les mutés'; }, 1500);
        return;
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(keys.join('\n'));
          if ($('copyMutesBtn')) $('copyMutesBtn').textContent = 'Copié ✓';
        }
      } catch (_) {
        if ($('copyMutesBtn')) $('copyMutesBtn').textContent = 'Erreur copie';
      }
      setTimeout(() => { if ($('copyMutesBtn')) $('copyMutesBtn').textContent = 'Mutés'; }, 1500);
    });
  });
}

if ($('copyWhitelistBtn')) {
  $('copyWhitelistBtn').addEventListener('click', () => {
    chrome.storage.local.get({ csg_whitelist: {} }, async ({ csg_whitelist }) => {
      const keys = Object.keys(csg_whitelist || {}).sort();
      if (!keys.length) {
        if ($('copyWhitelistBtn')) $('copyWhitelistBtn').textContent = 'Aucun protégé';
        setTimeout(() => { if ($('copyWhitelistBtn')) $('copyWhitelistBtn').textContent = 'Whitelist'; }, 1500);
        return;
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(keys.join('\n'));
          if ($('copyWhitelistBtn')) $('copyWhitelistBtn').textContent = 'Copié ✓';
        }
      } catch (_) {
        if ($('copyWhitelistBtn')) $('copyWhitelistBtn').textContent = 'Erreur copie';
      }
      setTimeout(() => { if ($('copyWhitelistBtn')) $('copyWhitelistBtn').textContent = 'Whitelist'; }, 1500);
    });
  });
}

const quickInput = $('quickMuteInput');
const quickBtn = $('quickMuteBtn');
const quickUnmuteBtn = $('quickUnmuteBtn');
const quickWlBtn = $('quickWhitelistBtn');
const quickAuthorBtn = $('quickAuthorBtn');
const quickFeedback = $('quickMuteFeedback');

function handleQuickMute() {
  if (!quickInput) return;
  const author = quickInput.value.trim().toLowerCase();
  if (!author) return;
  if (quickBtn) quickBtn.disabled = true;
  chrome.runtime.sendMessage({
    type: 'CSG_LOCAL_MUTE',
    author,
    score: 1,
    reason: 'manuel',
    channel: '',
    perm: true
  }, (res) => {
    if (quickBtn) quickBtn.disabled = false;
    if (res && res.applied === false) {
      if (quickFeedback) {
        quickFeedback.textContent = '⚠ Impossible de muter ' + author + ' (whitelist ou déjà muté).';
        quickFeedback.classList.remove('hidden');
        setTimeout(() => { if (quickFeedback) quickFeedback.classList.add('hidden'); }, 3000);
      }
      return;
    }
    quickInput.value = '';
    if (quickFeedback) {
      quickFeedback.textContent = '✓ ' + author + ' muté définitivement';
      quickFeedback.classList.remove('hidden');
      setTimeout(() => { if (quickFeedback) quickFeedback.classList.add('hidden'); }, 2500);
    }
    chrome.storage.local.get({ csg_muted: {} }, ({ csg_muted }) => {
      const n = Object.keys(csg_muted || {}).length;
      if ($('quickMuteCount')) $('quickMuteCount').textContent = n === 1 ? '1 pseudo muté' : n + ' pseudos mutés';
    });
  });
}

function handleQuickUnmute() {
  if (!quickInput) return;
  const author = quickInput.value.trim().toLowerCase();
  if (!author) return;
  if (quickUnmuteBtn) quickUnmuteBtn.disabled = true;
  chrome.storage.local.get({ csg_muted: {} }, ({ csg_muted }) => {
    const wasMuted = !!(csg_muted && csg_muted[author]);
    chrome.runtime.sendMessage({
      type: 'CSG_MUTE_REMOVE',
      key: author
    }, () => {
      if (quickUnmuteBtn) quickUnmuteBtn.disabled = false;
      quickInput.value = '';
      if (quickFeedback) {
        quickFeedback.textContent = wasMuted
          ? '✓ ' + author + ' démuté'
          : 'ℹ ' + author + ' n’était pas muté';
        quickFeedback.classList.remove('hidden');
        setTimeout(() => { if (quickFeedback) quickFeedback.classList.add('hidden'); }, 2500);
      }
      chrome.storage.local.get({ csg_muted: {} }, ({ csg_muted: updatedMuted }) => {
        const n = Object.keys(updatedMuted || {}).length;
        if ($('quickMuteCount')) $('quickMuteCount').textContent = n === 1 ? '1 pseudo muté' : n + ' pseudos mutés';
      });
    });
  });
}

function handleQuickWhitelist() {
  if (!quickInput) return;
  const author = quickInput.value.trim().toLowerCase();
  if (!author) return;
  if (quickWlBtn) quickWlBtn.disabled = true;
  chrome.storage.local.get({ csg_whitelist: {} }, ({ csg_whitelist }) => {
    const isWl = !!(csg_whitelist && csg_whitelist[author]);
    chrome.runtime.sendMessage({
      type: 'CSG_WHITELIST',
      names: [author],
      on: !isWl
    }, (res) => {
      if (quickWlBtn) quickWlBtn.disabled = false;
      quickInput.value = '';
      if (quickFeedback) {
        quickFeedback.textContent = isWl
          ? '✓ ' + author + ' retiré de la whitelist'
          : '✓ ' + author + ' ajouté à la whitelist (protégé)';
        quickFeedback.classList.remove('hidden');
        setTimeout(() => { if (quickFeedback) quickFeedback.classList.add('hidden'); }, 2500);
      }
      if (quickWlBtn) quickWlBtn.textContent = 'Protéger';
      chrome.storage.local.get({ csg_muted: {}, csg_whitelist: {} }, ({ csg_muted, csg_whitelist: updatedWl }) => {
        const n = Object.keys(csg_muted || {}).length;
        if ($('quickMuteCount')) $('quickMuteCount').textContent = n === 1 ? '1 pseudo muté' : n + ' pseudos mutés';
        const w = Object.keys(updatedWl || {}).length;
        if ($('quickWhitelistCount')) $('quickWhitelistCount').textContent = w === 1 ? '1 protégé' : w + ' protégés';
      });
    });
  });
}

function handleQuickAuthor() {
  if (!quickInput) return;
  const author = quickInput.value.trim().toLowerCase();
  if (!author) {
    if (quickFeedback) {
      quickFeedback.textContent = 'Indique un pseudo pour ouvrir son dossier';
      quickFeedback.classList.remove('hidden');
      if (typeof setTimeout === 'function') setTimeout(() => { if (quickFeedback) quickFeedback.classList.add('hidden'); }, 2000);
    }
    return;
  }
  const url = 'board.html#author?author=' + encodeURIComponent(author);
  const fullUrl = (chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL(url) : url;
  if (chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({ url: fullUrl });
  }
}

function updateQuickPreview() {
  if (!quickInput || !quickFeedback) return;
  const author = quickInput.value.trim().toLowerCase();
  if (!author) {
    quickFeedback.textContent = '';
    quickFeedback.classList.add('hidden');
    if (quickWlBtn) quickWlBtn.textContent = 'Protéger';
    return;
  }
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({ csg_muted: {}, csg_whitelist: {}, csg_author_notes: {}, csg_reports: {} }, (data) => {
      if (quickInput.value.trim().toLowerCase() !== author) return;
      const isMuted = !!(data.csg_muted && data.csg_muted[author]);
      const isWl = !!(data.csg_whitelist && data.csg_whitelist[author]);
      const note = data.csg_author_notes && data.csg_author_notes[author];
      const hasRep = data.csg_reports && Object.values(data.csg_reports).some((r) => r && !r.done && String(r.author || '').toLowerCase() === author);

      const parts = ['@' + author];
      if (isWl) parts.push('WHITELISTÉ');
      else if (isMuted) parts.push('MUTÉ');
      else parts.push('non sanctionné');

      if (hasRep) parts.push('⚠ signalement actif');
      if (note && note.text) parts.push('📝 ' + note.text);

      quickFeedback.textContent = parts.join(' · ');
      quickFeedback.classList.remove('hidden');

      if (quickWlBtn) quickWlBtn.textContent = isWl ? 'Déprotéger' : 'Protéger';
    });
  }
}

if (quickBtn) quickBtn.addEventListener('click', handleQuickMute);
if (quickUnmuteBtn) quickUnmuteBtn.addEventListener('click', handleQuickUnmute);
if (quickWlBtn) quickWlBtn.addEventListener('click', handleQuickWhitelist);
if (quickAuthorBtn) quickAuthorBtn.addEventListener('click', handleQuickAuthor);
if (quickInput) {
  quickInput.addEventListener('input', updateQuickPreview);
  quickInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleQuickMute();
    }
  });
}

let baitStatusCache = null;
let handCache = {};

// Personnes confiées à Grok, chacune avec son « Arrêter ».
function paintHandList(hand) {
  if (hand) handCache = hand;
  const list = $('handList');
  if (!list) return;
  const keys = Object.keys(handCache || {});
  list.textContent = '';
  for (const k of keys) {
    const t = handCache[k] || {};
    const row = document.createElement('div');
    row.className = 'live-event';
    const who = document.createElement('b');
    who.textContent = t.name || k;
    const where = document.createElement('small');
    const n = Array.isArray(t.thread) ? t.thread.filter((m) => m && m.w === 'moi').length : 0;
    where.textContent = (t.channel || '') + (n ? ' · ' + n + ' réponse' + (n > 1 ? 's' : '') : '');
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = 'Arrêter';
    stop.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CSG_HAND_STOP', key: k }));
    row.append(who, where, stop);
    list.appendChild(row);
  }
  if ($('handStopAll')) $('handStopAll').hidden = keys.length === 0;
  paintBaitStatus();
}

if ($('handStopAll')) {
  $('handStopAll').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CSG_HAND_STOP', all: true }));
}

function paintBaitStatus(st) {
  const el = $('baitStatus');
  if (!el) return;
  if (st) baitStatusCache = st;
  const cur = st || baitStatusCache;
  // Le bouton G d'une ligne marche sans personne confiée : son dernier état
  // reste affiché dix minutes.
  const recent = cur && cur.kind && cur.kind !== 'off' && Date.now() - (cur.at || 0) < 10 * 60 * 1000;
  if (!Object.keys(handCache || {}).length && !recent) {
    el.textContent = 'Bouton G à côté de la flèche Répondre, ou « Grok lui répond » sur la carte d’un viewer.';
    return;
  }
  const kind = cur && cur.kind;
  const detail = (cur && cur.detail) || '';
  if (kind === 'think') el.textContent = 'Il réfléchit' + (detail ? ' · ' + detail : '') + '…';
  else if (kind === 'sent') el.textContent = 'Envoyé · ' + detail;
  else if (kind === 'skip') el.textContent = 'Rien à répondre' + (detail ? ' · ' + detail : '');
  else if (kind === 'cap') el.textContent = 'Plafond de l’heure atteint.';
  else if (kind === 'wait') el.textContent = 'Tu écrivais, rien n’est parti.';
  else if (kind === 'err') el.textContent = 'Pas envoyé' + (detail ? ' · ' + detail : '');
  else el.textContent = 'Grok attend ses messages. 30 réponses par heure au plus.';
}

chrome.storage.local.get({ csg_bait_status: null, csg_hand: {} }, (v) => {
  baitStatusCache = v.csg_bait_status;
  paintHandList(v.csg_hand || {});
});

function activeReplyChannel(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return '';
    const site = /^(?:www\.|m\.)?twitch\.tv$/i.test(u.hostname) ? 'twitch'
      : /^(?:www\.)?kick\.com$/i.test(u.hostname) ? 'kick' : '';
    const parts = u.pathname.split('/').filter(Boolean);
    const slug = site === 'twitch' && /^(?:popout|embed)$/.test(parts[0]) ? parts[1] : parts[0];
    if (/^(?:directory|settings|subscriptions|downloads|search|videos|clips|dashboard|moderator|following|browse|category|categories)$/i.test(slug || '')) return '';
    return site && /^[a-z0-9_]+$/i.test(slug || '') ? site + '/' + slug.toLowerCase() : '';
  } catch (_) { return ''; }
}
if ($('autoReplyStart')) $('autoReplyStart').addEventListener('click', () => {
  const button = $('autoReplyStart');
  const feedback = $('autoReplyFeedback');
  const name = String($('autoReplyNick').value || '').trim().replace(/^@/, '');
  if (!/^[a-z0-9_]{3,25}$/i.test(name)) { feedback.textContent = 'Entre le pseudo de la personne.'; return; }
  button.disabled = true;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const err = chrome.runtime.lastError;
    const channel = !err && activeReplyChannel(tabs && tabs[0] && tabs[0].url);
    if (!channel) { button.disabled = false; feedback.textContent = 'Ouvre d’abord le chat Twitch ou Kick concerné.'; return; }
    chrome.runtime.sendMessage({ type: 'CSG_AUTO_REPLY_START', name, channel }, (res) => {
      const error = chrome.runtime.lastError;
      button.disabled = false;
      feedback.textContent = !error && res && res.ok
        ? 'Auto-réponse active pour @' + name + ' · Arrêter disponible ici et dans le chat.'
        : (res && res.err) || 'Activation impossible : recharge l’extension.';
    });
  });
});

let replyAssistConfig = { enabled: false, learnStyle: false };
let replyStyleStats = { count: 0 };
function paintReplyAssist(config, stats) {
  if (config) replyAssistConfig = config;
  if (stats) replyStyleStats = stats;
  if ($('replyAssistOn')) $('replyAssistOn').checked = replyAssistConfig.enabled === true;
  if ($('replyStyleOn')) $('replyStyleOn').checked = replyAssistConfig.learnStyle === true;
  const count = Math.max(0, Number(replyStyleStats.count) || 0);
  if ($('replyStyleStatus')) $('replyStyleStatus').textContent = replyAssistConfig.learnStyle
    ? count + ' messages retenus · ' + (count >= 8 ? 'style utilisé.' : '8 nécessaires pour adapter le style.')
    : 'Apprentissage désactivé. Exemples conservés localement.';
}
chrome.storage.local.get({ csg_reply_assist: null, csg_reply_style_stats: null }, (v) => {
  paintReplyAssist(v.csg_reply_assist, v.csg_reply_style_stats);
});
for (const [id, key] of [['replyAssistOn', 'enabled'], ['replyStyleOn', 'learnStyle']]) {
  const input = $(id);
  if (!input) continue;
  input.addEventListener('change', () => {
    input.disabled = true;
    chrome.runtime.sendMessage({ type: 'CSG_REPLY_ASSIST_SET', [key]: input.checked }, (res) => {
      const error = chrome.runtime.lastError;
      input.disabled = false;
      if (error || !res || !res.ok) {
        paintReplyAssist();
        if ($('replyStyleStatus')) $('replyStyleStatus').textContent = 'Réglage non enregistré : recharge l’extension.';
      } else paintReplyAssist(res.config, res.stats);
    });
  });
}

$('enabled').addEventListener('change', (e) => {
  syncDim();
  paintAmbienceStatus();
  patchSettings({ enabled: e.target.checked });
});
// Purement visuel : `target` ne decide plus si l'auteur est mute (il l'est
// toujours), seulement si ses lignes sont masquees a l'ecran.
$('hideMuted').addEventListener('change', (e) => {
  syncDim();
  patchSettings({ target: e.target.checked ? 'author' : 'message' });
});
$('blankMute').addEventListener('change', (e) => patchSettings({ blankMute: e.target.checked }));

function bindEye(inputId, eyeId) {
  const eye = $(eyeId);
  const input = $(inputId);
  if (!eye || !input) return;
  eye.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.classList.toggle('on', show);
    eye.title = show ? 'Masquer la clé' : 'Afficher la clé';
  });
}
bindEye('cloudToken', 'cloudTokenEye');
bindEye('codexBridgeToken', 'codexBridgeTokenEye');
bindEye('googleKey', 'googleKeyEye');
bindEye('glmKey', 'glmKeyEye');
bindEye('goKey', 'goKeyEye');
bindEye('xaiKey', 'xaiKeyEye');
bindEye('customKey', 'customKeyEye');

function loadEngineKeys() {
  chrome.storage.local.get({ csg_engine: {} }, ({ csg_engine }) => {
    const eng = csg_engine || {};
    for (const id of ['goKey', 'googleKey', 'glmKey', 'xaiKey', 'customUrl', 'customModel', 'customKey']) {
      const el = $(id);
      if (el && document.activeElement !== el) el.value = eng[id] || '';
    }
  });
  chrome.storage.sync.get({ csg_settings: {} }, ({ csg_settings }) => {
    if (csg_settings && csg_settings.lane) laneWanted = csg_settings.lane;
  });
}

let engineKeyT = null;
function saveEngineKeys() {
  chrome.storage.local.get({ csg_engine: {} }, ({ csg_engine }) => {
    const next = Object.assign({}, csg_engine || {});
    for (const id of ['goKey', 'googleKey', 'glmKey', 'xaiKey', 'customUrl', 'customModel', 'customKey']) {
      const el = $(id);
      if (el) next[id] = String(el.value || '').trim();
    }
    chrome.storage.local.set({ csg_engine: next }, () => refreshLive());
  });
}
for (const id of ['goKey', 'googleKey', 'glmKey', 'xaiKey', 'customUrl', 'customModel', 'customKey']) {
  const el = $(id);
  if (el) {
    el.addEventListener('input', () => {
      clearTimeout(engineKeyT);
      engineKeyT = setTimeout(saveEngineKeys, 300);
    });
  }
}
if ($('laneSel')) {
  $('laneSel').addEventListener('change', (e) => {
    laneWanted = e.target.value;
    patchSettings({ lane: e.target.value });
  });
}
if ($('lanesToggle')) {
  $('lanesToggle').addEventListener('click', () => {
    lanesHidden = !lanesHidden;
    $('lanesToggle').setAttribute('aria-expanded', lanesHidden ? 'false' : 'true');
    if ($('lanes')) $('lanes').hidden = lanesHidden;
    if (lastAudit) paintLanes(lastAudit);
  });
}

function updateExtraWordsCount(val) {
  const el = $('extraWordsCount');
  if (!el) return;
  // Même découpage que keywords.js EXTRA_SPLIT : virgule, point-virgule, retour ligne.
  const words = String(val || '').split(/[,;\n\r]+/).map((w) => w.trim()).filter(Boolean);
  let kept = 0;
  let short = 0;
  for (const w of words) {
    if (w.length < 3) short++;
    else kept++;
  }
  const n = Math.min(kept, 200);
  let text = n <= 1 ? n + ' mot' : n + ' mots';
  if (short) text += ' · ' + (short === 1 ? '1 trop court' : short + ' trop courts');
  if (kept > 200) text += ' · 200 max';
  el.textContent = text;
}

let extraT = null;
$('extraWords').addEventListener('input', (e) => {
  updateExtraWordsCount(e.target.value);
  clearTimeout(extraT);
  extraT = setTimeout(() => patchSettings({ extraWords: e.target.value || '' }), 350);
});

// xAI SuperGrok OAuth (no API key)
const xaiBtn = $('xaiOAuthBtn');
const xaiLogoutBtn = $('xaiOAuthLogout');
const xaiStatusEl = $('xaiOAuthStatus');

function paintXaiOAuth(st) {
  const has = !!(st && st.has);
  const pending = !!(st && st.pending);
  if (xaiBtn) xaiBtn.style.display = has ? 'none' : '';
  if (xaiLogoutBtn) xaiLogoutBtn.style.display = has ? '' : 'none';
  if (xaiStatusEl) {
    if (has) {
      xaiStatusEl.textContent = st.err ? 'Connexion conservée · ' + st.err : '✓ Abonnement SuperGrok connecté (pas de clé API)';
      xaiStatusEl.style.color = st.err ? 'var(--warn)' : 'var(--ok)';
    } else if (st && st.invalid) {
      xaiStatusEl.textContent = 'Session SuperGrok expirée — reconnecte ton compte.';
      xaiStatusEl.style.color = 'var(--bad)';
    } else if (st && st.err) {
      xaiStatusEl.textContent = 'Erreur xAI : ' + st.err;
      xaiStatusEl.style.color = 'var(--bad)';
    } else if (pending) {
      xaiStatusEl.textContent =
        'En attente d’approbation' +
        (st.code ? ' — code ' + st.code : '') +
        (st.url ? ' — ouvre le lien ci-dessous' : '');
      xaiStatusEl.style.color = 'var(--warn)';
    } else {
      xaiStatusEl.textContent = 'Sans clé ni abonnement : analyse locale (mots bannis & dictionnaire).';
      xaiStatusEl.style.color = '';
    }
  }
  const link = $('xaiOAuthLink');
  if (link) {
    if (pending && st.url) {
      link.href = st.url;
      link.style.display = '';
      link.textContent = st.code ? 'Ouvrir x.ai — code ' + st.code : 'Ouvrir la page x.ai';
    } else {
      link.style.display = 'none';
      link.removeAttribute('href');
    }
  }
  window.__xaiOAuthHas = has || (typeof typedHasKey === 'function' ? typedHasKey() : false);
}

if (xaiBtn) {
  xaiBtn.addEventListener('click', () => {
    xaiBtn.disabled = true;
    if (xaiStatusEl) xaiStatusEl.textContent = 'Demande du code x.ai…';
    chrome.runtime.sendMessage({ type: 'CSG_XAI_OAUTH_START' }, (res) => {
      xaiBtn.disabled = false;
      const err = chrome.runtime.lastError;
      if (err) {
        if (xaiStatusEl) xaiStatusEl.textContent = 'Erreur SW : ' + String(err.message || err).slice(0, 160);
        return;
      }
      if (res && res.ok && res.url) {
        // Le service worker ouvre déjà l'onglet. Le rouvrir ici doublait la page.
        paintXaiOAuth({ has: false, pending: true, code: res.code || '', url: res.url });
      } else {
        if (xaiStatusEl) {
          xaiStatusEl.textContent = 'Erreur : ' + ((res && res.err) || 'pas de réponse du worker');
          xaiStatusEl.style.color = 'var(--bad)';
        }
      }
    });
  });
}

if (xaiLogoutBtn) {
  xaiLogoutBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CSG_XAI_OAUTH_LOGOUT' }, () => {
      paintXaiOAuth({ has: false });
      refreshLive();
    });
  });
}

$('stopAnalyze').addEventListener('click', () => {
  const button = $('stopAnalyze');
  button.disabled = true;
  button.textContent = 'Arrêt en cours…';
  chrome.runtime.sendMessage({ type: 'CSG_AUDIT_ALL_STOP' }, (res) => {
    const err = chrome.runtime.lastError;
    if (err || !res || !res.ok) {
      $('analyzeStatus').textContent = err ? err.message : 'Arrêt non confirmé · réessaie.';
      $('analyzeStatus').classList.add('bad');
      button.disabled = false;
      button.textContent = 'Réessayer l’arrêt';
      return;
    }
    refreshLive();
  });
});

$('openBoard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('board.html') });
});

if (typeof document.querySelectorAll === 'function') {
  document.querySelectorAll('.board-jump').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tab = btn.dataset ? btn.dataset.tab : (btn.getAttribute && btn.getAttribute('data-tab'));
      const targetUrl = tab ? chrome.runtime.getURL('board.html#' + tab) : chrome.runtime.getURL('board.html');
      chrome.tabs.create({ url: targetUrl });
    });
  });
}

if ($('quickMuteCount')) {
  $('quickMuteCount').style.cursor = 'pointer';
  $('quickMuteCount').title = 'Consulter les mutés dans le tableau';
  $('quickMuteCount').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('board.html#mutes') });
  });
}
if ($('quickWhitelistCount')) {
  $('quickWhitelistCount').style.cursor = 'pointer';
  $('quickWhitelistCount').title = 'Consulter la whitelist dans le tableau';
  $('quickWhitelistCount').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('board.html#mutes') });
  });
}

function setupTallyShortcuts() {
  const tallyShortcuts = [
    { sel: '.stat.total', tab: 'log' },
    { sel: '.stat.bad', tab: 'log', verdict: 'mute' },
    { sel: '.stat.ok', tab: 'log', verdict: 'keep' },
    { sel: '.stat.wait', page: 'queue.html', title: 'Voir les messages en attente, en direct' },
    { sel: '.stat.skip', tab: 'log', verdict: 'skip' }
  ];
  const verdictLabel = { mute: 'rejetés', keep: 'acceptés', pending: 'en attente', skip: 'ignorés' };
  tallyShortcuts.forEach(({ sel, tab, verdict, page, title }) => {
    const el = document.querySelector ? document.querySelector(sel) : null;
    if (el && page) {
      el.style.cursor = 'pointer';
      el.title = title;
      el.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL(page) }));
      return;
    }
    if (el) {
      el.style.cursor = 'pointer';
      el.title = verdict
        ? 'Ouvrir le journal filtré sur les messages ' + (verdictLabel[verdict] || verdict)
        : 'Ouvrir le journal des captures';
      el.addEventListener('click', () => {
        let url = 'board.html#' + tab;
        if (verdict) url += '?verdict=' + encodeURIComponent(verdict);
        chrome.tabs.create({ url: chrome.runtime.getURL(url) });
      });
    }
  });
}
setupTallyShortcuts();

$('analyzeCaptured').addEventListener('click', () => {
  const button = $('analyzeCaptured');
  const status = $('analyzeStatus');
  button.disabled = true;
  button.textContent = 'Démarrage…';
  status.classList.remove('bad');
  chrome.runtime.sendMessage({ type: 'CSG_AUDIT_ALL_START' }, (res) => {
    const err = chrome.runtime.lastError;
    if (err || !res || !res.ok) {
      status.textContent = err ? err.message : (res && res.err) || 'Impossible de lancer l’analyse.';
      status.classList.add('bad');
      button.disabled = false;
      button.textContent = 'Réessayer l’analyse';
      return;
    }
    button.classList.add('running');
    button.textContent = 'Analyse en cours…';
    status.textContent = fmt(res.planned) + (Number(res.planned) === 1 ? ' message pris en charge.' : ' messages pris en charge.');
    refreshLive();
  });
});

function paintCloudStatus(st) {
  const el = $('cloudStatus');
  el.className = 'cloud-status';
  if (!st) {
    el.textContent = $('cloudOn').checked ? 'Pas encore synchronisé' : 'Sync coupée';
    return;
  }
  const when = st.at ? new Date(st.at).toLocaleTimeString() : '';
  if (st.ok) {
    el.classList.add('ok');
    el.textContent = (st.dir === 'pull' ? 'Récupéré' : 'Envoyé') + (st.why ? ' · ' + st.why : '') + (when ? ' · ' + when : '');
  } else {
    el.classList.add('bad');
    el.textContent = (st.err || 'échec') + (when ? ' · ' + when : '');
  }
}

function loadCloud() {
  chrome.storage.local.get({ csg_cloud: {}, csg_cloud_status: null }, (v) => {
    const c = v.csg_cloud || {};
    $('cloudOn').checked = c.on === true;
    if (document.activeElement !== $('cloudUrl')) $('cloudUrl').value = c.url || '';
    if (document.activeElement !== $('cloudToken')) $('cloudToken').value = c.token || '';
    paintCloudStatus(v.csg_cloud_status);
  });
}

let cloudT = null;
function saveCloud() {
  const api = typeof CSG_CLOUD !== 'undefined' ? CSG_CLOUD : null;
  const url = api ? api.normalizeUrl($('cloudUrl').value) : $('cloudUrl').value.trim();
  chrome.storage.local.set({
    csg_cloud: { on: $('cloudOn').checked, url: url, token: $('cloudToken').value.trim() }
  });
}

function saveCloudSoon() {
  clearTimeout(cloudT);
  cloudT = setTimeout(saveCloud, 250);
}

function paintCodexBridgeStatus(st) {
  const el = $('codexBridgeStatus');
  el.className = 'cloud-status';
  if (!st) {
    el.textContent = $('codexBridgeOn').checked ? 'Jeton requis · relais local' : 'Relais local désactivé';
    return;
  }
  const when = st.at ? new Date(st.at).toLocaleTimeString() : '';
  if (st.ok) {
    el.classList.add('ok');
    el.textContent = 'Envoyé · ' + (Number(st.n) || 0) + ' messages' + (when ? ' · ' + when : '');
  } else {
    el.classList.add('bad');
    el.textContent = (st.err || 'échec du relais local') + (when ? ' · ' + when : '');
  }
}

let codexBridgeEnabled = false;
function loadCodexBridge() {
  chrome.storage.local.get({ csg_codex_bridge: {}, csg_codex_bridge_status: null }, (v) => {
    const c = v.csg_codex_bridge || {};
    codexBridgeEnabled = c.on === true && !!String(c.token || '').trim();
    $('codexBridgeOn').checked = c.on === true;
    if (document.activeElement !== $('codexBridgeToken')) $('codexBridgeToken').value = c.token || '';
    paintCodexBridgeStatus(v.csg_codex_bridge_status);
    paintAnalyze(lastAudit, typedHasKey());
  });
}

function saveCodexBridge(cb) {
  chrome.storage.local.set({
    csg_codex_bridge: { on: $('codexBridgeOn').checked, token: $('codexBridgeToken').value.trim() }
  }, cb);
}

let codexBridgeSaveT = null;
function saveCodexBridgeSoon() {
  clearTimeout(codexBridgeSaveT);
  codexBridgeSaveT = setTimeout(() => saveCodexBridge(), 250);
}

function pushCodexBridgeNow() {
  saveCodexBridge(() => {
    $('codexBridgeStatus').textContent = 'Envoi…';
    $('codexBridgeStatus').className = 'cloud-status';
    chrome.runtime.sendMessage({ type: 'CSG_CODEX_BRIDGE_PUSH' }, (res) => {
      if (chrome.runtime.lastError) {
        paintCodexBridgeStatus({ ok: false, err: chrome.runtime.lastError.message, at: Date.now() });
        return;
      }
      paintCodexBridgeStatus(Object.assign({ at: Date.now() }, res || { ok: false, err: 'pas de réponse' }));
    });
  });
}

async function ensureCloudOrigin() {
  const api = typeof CSG_CLOUD !== 'undefined' ? CSG_CLOUD : null;
  const pattern = api ? api.originPattern($('cloudUrl').value) : '';
  if (!pattern) return { ok: false, err: 'URL invalide' };
  if (!chrome.permissions || !chrome.permissions.request) return { ok: true };
  const have = await new Promise((r) => chrome.permissions.contains({ origins: [pattern] }, r));
  if (have) return { ok: true };
  const ok = await new Promise((r) => chrome.permissions.request({ origins: [pattern] }, r));
  return ok ? { ok: true } : { ok: false, err: 'permission refusée' };
}

async function runCloud(dir) {
  saveCloud();
  const perm = await ensureCloudOrigin();
  if (!perm.ok) {
    paintCloudStatus({ ok: false, err: perm.err, at: Date.now() });
    return;
  }
  $('cloudStatus').textContent = dir === 'pull' ? 'Récupération…' : 'Envoi…';
  $('cloudStatus').className = 'cloud-status';
  chrome.runtime.sendMessage({ type: 'CSG_CLOUD_SYNC', dir: dir }, (res) => {
    if (chrome.runtime.lastError) {
      paintCloudStatus({ ok: false, err: chrome.runtime.lastError.message, at: Date.now() });
      return;
    }
    paintCloudStatus(Object.assign({ dir: dir, at: Date.now() }, res || { ok: false, err: 'pas de réponse' }));
  });
}

$('cloudOn').addEventListener('change', () => {
  saveCloud();
  paintCloudStatus(null);
});
$('codexBridgeOn').addEventListener('change', () => {
  saveCodexBridge();
  codexBridgeEnabled = $('codexBridgeOn').checked && !!String($('codexBridgeToken').value || '').trim();
  paintCodexBridgeStatus(null);
  if (lastAudit) paintAnalyze(lastAudit, typedHasKey());
});
$('codexBridgeToken').addEventListener('input', saveCodexBridgeSoon);
$('codexBridgePush').addEventListener('click', pushCodexBridgeNow);
$('cloudUrl').addEventListener('input', saveCloudSoon);
$('cloudToken').addEventListener('input', saveCloudSoon);
$('cloudPush').addEventListener('click', () => runCloud('push'));
$('cloudPull').addEventListener('click', () => runCloud('pull'));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.csg_settings) { loadSettings(); loadEngineKeys(); }
  if (area !== 'local') return;
  if (changes.csg_reply_assist || changes.csg_reply_style_stats) paintReplyAssist(
    changes.csg_reply_assist && changes.csg_reply_assist.newValue,
    changes.csg_reply_style_stats && changes.csg_reply_style_stats.newValue);
  if (changes.csg_ambience_error) {
    ambienceError = String(changes.csg_ambience_error.newValue || '');
    paintAmbienceStatus();
  }
  if (changes.csg_audit || changes.csg_engine) {
    if (changes.csg_engine) loadEngineKeys();
    refreshLive();
  }
  if (changes.csg_bait_status) paintBaitStatus(changes.csg_bait_status.newValue);
  if (changes.csg_hand) paintHandList(changes.csg_hand.newValue || {});
  if (changes.csg_live_mode || changes.csg_live_state || changes.csg_live_muted) refreshLiveMode();
  if (changes.csg_cloud_status) paintCloudStatus(changes.csg_cloud_status.newValue);
  if (changes.csg_codex_bridge_status) paintCodexBridgeStatus(changes.csg_codex_bridge_status.newValue);
  if (changes.csg_codex_bridge) loadCodexBridge();
  if (changes.csg_muted) {
    const n = Object.keys(changes.csg_muted.newValue || {}).length;
    if ($('quickMuteCount')) $('quickMuteCount').textContent = n === 1 ? '1 pseudo muté' : n + ' pseudos mutés';
  }
  if (changes.csg_whitelist) {
    const w = Object.keys(changes.csg_whitelist.newValue || {}).length;
    if ($('quickWhitelistCount')) $('quickWhitelistCount').textContent = w === 1 ? '1 protégé' : w + ' protégés';
  }
  if (changes.csg_sound_alert) {
    if ($('soundAlert')) $('soundAlert').checked = !!changes.csg_sound_alert.newValue;
  }
  if (changes.csg_streamer_mode) {
    if ($('streamerMode')) $('streamerMode').checked = !!changes.csg_streamer_mode.newValue;
  }
  if (changes.csg_reports) {
    updatePopupReportsBadge();
  }
});

try {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
} catch (_) {}

loadSettings();
loadEngineKeys();
refreshLiveMode();
loadCloud();
loadCodexBridge();

setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  chrome.runtime.sendMessage({ type: 'CSG_AUDIT_STATS' }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) return;
    liveCode = typeof res.code === 'string' ? res.code : '';
    // Même raison de capture et même plantage que le dernier refreshLive :
    // sans eux, « Rien n'est capturé » et « Planté » s'effaçaient au premier
    // tick, 1,5 s après l'ouverture — exactement la panne qu'ils signalent.
    paintAll(res, typedHasKey(), lastCrash, lastWhy, lastPage);
  });
}, 1500);
