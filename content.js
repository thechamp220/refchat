'use strict';

(() => {
  const CSG_VER = 263;
  if (window.__csgVer === CSG_VER) return;
  if (typeof window.__csgTeardown === 'function') window.__csgTeardown();
  if (window.__csgObserver) {
    try {
      window.__csgObserver.disconnect();
    } catch (_) {}
  }
  if (window.__csgCardObserver) {
    try {
      clearTimeout(window.__csgCardObserver._t);
      window.__csgCardObserver.disconnect();
    } catch (_) {}
    window.__csgCardObserver = null;
  }
  if (window.__csgTick) clearInterval(window.__csgTick);
  window.__csgVer = CSG_VER;
  window.__csgLoaded = true;

  // --- Contexte d'extension invalide -----------------------------------------
  // Recharger l'extension (ou la mettre a jour) coupe le pont avec le content
  // script DEJA en place dans les onglets ouverts. Le script, lui, continue de
  // tourner : son setInterval de 1,5 s, son MutationObserver, ses callbacks. Et
  // tout appel chrome.* leve alors « Extension context invalidated ».
  //
  // Resultat : un zombie qui hurle en boucle dans la console, qui continue de
  // marquer les lignes du chat comme vues (data-csg) alors qu'il ne peut plus
  // rien envoyer, et dont les exceptions non attrapees cassent act() en plein
  // milieu. Il faut qu'il se taise et se demonte tout seul.
  //
  // chrome.runtime.id passe a undefined des que le contexte est invalide : c'est
  // le seul test fiable, et il ne leve pas.
  let ctxGone = false;
  let tornDown = false;
  const contentCleanups = [];
  window.__csgTeardown = teardown;

  function ctxDead() {
    if (ctxGone) return true;
    try {
      if (chrome.runtime && chrome.runtime.id && window.__csgVer === CSG_VER) return false;
    } catch (_) {}
    ctxGone = true;
    return true;
  }

  function teardown() {
    if (tornDown) return;
    tornDown = true;
    ctxGone = true;
    for (const cleanup of contentCleanups.splice(0)) {
      try { cleanup(); } catch (_) {}
    }
    // A delayed callback from the old instance must not stop its replacement.
    if (window.__csgVer !== CSG_VER) return;
    try {
      if (window.__csgObserver) window.__csgObserver.disconnect();
    } catch (_) {}
    try {
      if (window.__csgTick) clearInterval(window.__csgTick);
    } catch (_) {}
    try {
      if (window.__csgCardObserver) {
        clearTimeout(window.__csgCardObserver._t);
        window.__csgCardObserver.disconnect();
      }
    } catch (_) {}
    window.__csgCardObserver = null;
    window.__csgTick = null;
    observedRoot = null;
    mutBuf = [];
    if (mutFlushT) {
      clearTimeout(mutFlushT);
      mutFlushT = 0;
    }
  }

  // Tout appel chrome.* passe par la : contexte mort = on ne tente meme pas.
  function safe(fn) {
    if (ctxDead()) return false;
    try {
      fn();
      return true;
    } catch (e) {
      if (/context invalidated|Extension context/i.test(String((e && e.message) || e))) teardown();
      return false;
    }
  }

  // --- Envois fiables vers le service worker --------------------------------
  // Un service worker MV3 endormi fait echouer sendMessage sans bruit : le
  // callback ne recoit qu un lastError, que les appelants avalaient. Une
  // capture perdue = une ligne jamais jugee. On garde donc les messages non
  // acquittes dans une file rejouee au tic suivant, avec un plafond.
  const OUTBOX = { RETRY_MS: 2500, MAX_TRIES: 4, MAX: 200 };
  const outbox = [];
  let outboxTimer = null;
  contentCleanups.push(() => {
    clearTimeout(outboxTimer);
    outboxTimer = null;
    outbox.length = 0;
  });

  function scheduleOutbox() {
    if (outboxTimer || ctxDead() || !outbox.length) return;
    outboxTimer = setTimeout(flushOutbox, OUTBOX.RETRY_MS);
  }

  function requeue(item) {
    if (ctxDead() || item.noRetry) {
      if (item.onDrop) item.onDrop();
      return;
    }
    item.tries += 1;
    if (item.tries > OUTBOX.MAX_TRIES) {
      if (item.onDrop) item.onDrop();
      return;
    }
    outbox.push(item);
    if (outbox.length > OUTBOX.MAX) {
      const dropped = outbox.shift();
      // Une eviction par plafond est aussi definitive qu'un epuisement des
      // essais : rendre la ligne au rescan au lieu de la laisser marquee vue.
      try {
        if (dropped && dropped.onDrop) dropped.onDrop();
      } catch (_) {}
    }
    scheduleOutbox();
  }

  function deliver(item) {
    if (ctxDead()) return;
    try {
      chrome.runtime.sendMessage(item.msg, (res) => {
        if (chrome.runtime.lastError) return requeue(item);
        // Le fond repond toujours {ok:...} aux messages qui en attendent un ;
        // une reponse absente est un envoi reste silencieusement perdu.
        if (item.expectReply && (res === undefined || res === null)) return requeue(item);
        if (item.onReply) item.onReply(res);
      });
    } catch (_) {
      requeue(item);
    }
  }

  function flushOutbox() {
    outboxTimer = null;
    if (ctxDead() || !outbox.length) return;
    const batch = outbox.splice(0, outbox.length);
    for (const item of batch) deliver(item);
    if (outbox.length) scheduleOutbox();
  }

  // Envoie un message au fond, avec reessai si le worker etait endormi.
  // onReply(res) n est appele qu une fois la reponse obtenue ; onDrop() est
  // appele si les reessais sont epuises.
  function sendBg(msg, opts) {
    if (ctxDead()) return false;
    const o = opts || {};
    deliver({
      msg,
      expectReply: !!o.expectReply,
      noRetry: !!o.noRetry,
      onReply: o.onReply || null,
      onDrop: o.onDrop || null,
      tries: 0
    });
    return true;
  }

  function listenStorage(callback) {
    const listener = (changes, area) => {
      if (ctxDead()) return teardown();
      callback(changes, area);
    };
    chrome.storage.onChanged.addListener(listener);
    contentCleanups.push(() => chrome.storage.onChanged.removeListener(listener));
  }

  const LINE_SEL = [
    '.chat-line__message',
    '[data-a-target="chat-line-message"]',
    '[data-test-selector="chat-line-message"]',
    '.seventv-chat-message',
    '.ffz--chat-line',
    '.vod-message',
    '.video-chat__message',
    // Kick : liste virtualisée, une ligne = une row [data-index] du chatroom.
    '[data-testid="chatroom-messages"] [data-index]',
    '#chatroom-messages [data-index]'
  ].join(',');

  const AUTHOR_SEL = [
    '[data-a-target="chat-message-username"]',
    '[data-a-target="chat-username"]',
    '[data-a-target="chat-name"]',
    '.chat-author__display-name',
    '.chat-line__username',
    '.seventv-chat-user-username',
    '.seventv-chat-user',
    // Kick : le pseudo est un <button> cliquable, pas un <span>.
    'button[data-prevent-expand="true"]',
    '[data-testid="chat-entry-username"]'
  ].join(',');

  const FRAG_SEL = [
    '.text-fragment',
    '.mention-fragment',
    '.seventv-chat-message-body',
    '.seventv-chat-message-text',
    // Kick : le corps du message porte une classe Tailwind arbitraire.
    'span[class*="leading-["]'
  ].join(',');

  const REPLY_SEL =
    '[class*="reply" i], [data-a-target*="reply" i], [data-test-selector*="reply" i], .seventv-reply-part, .seventv-chat-reply, .ffz--fix-reply-line';

  const DEFAULTS = {
    ambiencePause: true,
    enabled: true,
    mode: 'block',
    // cs2 = seulement les lives dont le jeu affiche est Counter-Strike ;
    // all = n'importe quel chat Twitch/Kick.
    scope: 'cs2',
    judge: true,
    extraWords: '',
    showHud: false,
    notify: true,
    target: 'author',
    learn: true,
    // Reponse Twitch/Kick : cacher l'apercu du message d'origine sur TOUTES les
    // reponses, pas seulement quand la citation est sale. Choix de confort, pas
    // de moderation — la coupe automatique reste active quoi qu'il arrive.
    hideQuote: false,
    hideCopypasta: true,
    llmOnly: true,
    // Auteur déjà muet : pseudo barré et message caché. Coché, la ligne
    // disparaît entièrement (pseudo compris).
    blankMute: false
  };

  // Reglages retires du popup : ils ne sont plus negociables. Appliques APRES le
  // merge avec le storage, sinon une valeur restee en sync (ecrite du temps ou la
  // case existait) continuerait de les ecraser en silence — c'est exactement ce
  // qui gardait `llmOnly` a true alors que le defaut disait false.
  // `scope` reste libre : CS2 seulement ou tous les streams (popup).
  const FORCED = {
    // C'est le modele qui decide, jamais une correspondance de chaine.
    llmOnly: true,
    // Copypasta : du bruit. La ligne tombe, l'auteur n'est jamais mute.
    hideCopypasta: true,
    // Coupes a vie : aucun trafic reseau hors du chat qu'on regarde.
    // L'apprentissage automatique reste coupe dans le fond, mais les termes
    // ajoutes manuellement s'appliquent localement, sans trafic reseau.
    learn: true,
    bg: false,
    fullAudit: false,
    // Plus de case pour les couper : des toasts systeme qu'on ne peut plus
    // eteindre sont pires que pas de toast du tout.
    notify: false,
    showHud: false,
    hideQuote: false
  };
  let settings = Object.assign({}, DEFAULTS, FORCED);
  let modelReady = false;
  let mutedUsers = {};
  let liveMutedUsers = {};
  const releasedMutes = new Set();
  let lastAudit = null;
  let bertStatus = {};
  let hudEl = null;
  let pageBlocked = 0;
  let capturedCount = 0;
  let lastSeen = null;
  let lastWhy = 'init';
  let lastChannel = '';
  let observedRoot = null;
  let mutBuf = [];
  let mutFlushT = 0;

  // --- Contexte court : recollage inter-messages et rafales -----------------
  // analyze() ne voit qu'une ligne. « ta » puis « gueule » en deux envois, ou
  // cinq viewers qui tapent le meme jeton sur un joueur, sont invisibles par
  // construction. On garde par auteur ses 3 dernieres lignes courtes (20 s) et
  // par salon le nombre d'auteurs distincts ayant envoye la meme ligne (30 s).
  const JOIN = { KEEP: 3, WINDOW_MS: 20000, MAX_TOKENS: 4, MAX_AUTHORS: 400 };
  const BURST = { WINDOW_MS: 30000, MIN: 3, MAX_KEYS: 300 };
  // Celebration collective (gg / wp / pog / 🔥 en fin de match) : une rafale
  // attendue, jamais un dogpile. Elle ne part pas au modele, sinon chaque fin
  // de map remplit la file de « gg ».
  const BURST_SKIP_RE = /^(?:(?:gg+|wp+|gg wp|ggwp|glhf|hf|gl|w|pog\w*|hype|ez|❤️?|🔥|👍|🙌|💪)[!.]*\s*)+$/i;
  const authorTail = new Map();
  const burstSeen = new Map();

  // --- Copypasta : la part qui demande une memoire -------------------------
  // copypasta() de keywords.js juge la forme d'un message isole. Ce qui lui
  // echappe, c'est le pave ordinaire QUE TOUT LE MONDE recopie. Un doublon
  // court (hype de 50 car.) n'est pas un collage : deux viewers tapent la
  // meme reaction. On attend 72 car. et soit le meme auteur (2e envoi), soit
  // 3 auteurs distincts. A partir du 3e on replie aussi les lignes deja a l'ecran.
  const PASTA = { WINDOW_MS: 600000, MIN_LEN: 72, MAX_KEYS: 200, CHAIN: 3, EMOTES: 12 };
  const pastaSeen = new Map();
  // Emotes rendues en <img> : leur texte est vide, donc un mur d'emotes arrive
  // ici comme un message vide. Il faut les compter dans le DOM ou nulle part.
  const EMOTE_SEL =
    'img.chat-image, .chat-line__message--emote, .seventv-chat-emote, ' +
    'img[data-emote-name], [data-emote-name] img, .emote-container img, img[alt][src*="emote"]';
  const EMOTE_SKIP_SEL =
    '.chat-badge, .badge, .seventv-chat-user, [data-testid^="identity-badge-"]';

  function notePasta(text, el) {
    const key = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
    if (key.length < PASTA.MIN_LEN) return null;
    const now = Date.now();
    let arr = pastaSeen.get(key);
    if (!arr) {
      arr = [];
      pastaSeen.set(key, arr);
      if (pastaSeen.size > PASTA.MAX_KEYS) pastaSeen.delete(pastaSeen.keys().next().value);
    }
    while (arr.length && now - arr[0].at > PASTA.WINDOW_MS) arr.shift();
    const a = tailKey(el && el.dataset && el.dataset.csgName);
    arr.push({ at: now, el, a });
    return arr;
  }

  function emoteCount(el) {
    try {
      const imgs = el.querySelectorAll(EMOTE_SEL);
      let n = 0;
      for (const img of imgs) {
        if (img.closest && img.closest(EMOTE_SKIP_SEL)) continue;
        n++;
      }
      return n;
    } catch (_) {
      return 0;
    }
  }

  // Renvoie la raison du masquage, ou ''. Enregistre TOUJOURS la ligne assez
  // longue : c'est ce qui permet de reconnaitre le collage suivant.
  function pastaReason(el, text) {
    const chain = notePasta(text, el);
    const shape = window.CSG_KEYWORDS.copypasta ? window.CSG_KEYWORDS.copypasta(text) : '';
    if (shape) return shape;
    const em = emoteCount(el);
    if (em >= PASTA.EMOTES && text.replace(/\s+/g, '').length <= em * 2) return 'mur d emotes';
    if (!chain || chain.length < 2) return '';
    const sameAuthor = chain.length >= 2 && chain.every((p) => p.a && p.a === chain[0].a);
    // 2 auteurs distincts : hype parallele, on attend le 3e. 2e envoi du meme
    // auteur = collage. 3e occurrence = on replie toute la chaine.
    if (chain.length < PASTA.CHAIN && !sameAuthor) return '';
    if (chain.length >= PASTA.CHAIN) {
      for (const p of chain) {
        if (p.el && p.el !== el && p.el.isConnected) act(p.el, 0.9, 'copypasta');
      }
    }
    return 'copie';
  }

  function tailKey(name) {
    return String(name || '').trim().toLowerCase();
  }

  function rememberTail(name, text, el) {
    const k = tailKey(name);
    if (!k) return;
    let arr = authorTail.get(k);
    if (!arr) {
      arr = [];
      authorTail.set(k, arr);
      if (authorTail.size > JOIN.MAX_AUTHORS) authorTail.delete(authorTail.keys().next().value);
    }
    arr.push({ t: text, at: Date.now(), el });
    while (arr.length > JOIN.KEEP) arr.shift();
  }

  // Recolle les dernieres lignes courtes du meme auteur et re-juge le tout. Ne
  // peut qu'AJOUTER une correspondance : lignes <= 4 jetons, fenetre de 20 s,
  // et la 1re personne garde les memes garde-fous que sur une ligne isolee.
  function joinedVerdict(name, text) {
    const k = tailKey(name);
    const arr = k && authorTail.get(k);
    if (!arr || !arr.length) return null;
    if (text.split(/\s+/).length > JOIN.MAX_TOKENS) return null;
    const now = Date.now();
    const parts = [];
    for (const m of arr) {
      if (now - m.at > JOIN.WINDOW_MS || m.t.split(/\s+/).length > JOIN.MAX_TOKENS) {
        parts.length = 0;
        continue;
      }
      parts.push(m);
    }
    if (!parts.length) return null;
    const joined = parts.map((m) => m.t).join(' ') + ' ' + text;
    const v = window.CSG_KEYWORDS.analyze(joined);
    if (!(v.heavy || v.harsh || v.vitalityHate)) return null;
    return { joined, parts };
  }

  // Nombre d'auteurs distincts ayant envoye cette meme ligne dans la fenetre.
  function noteBurst(name, text) {
    const key = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!key) return 0;
    const now = Date.now();
    let arr = burstSeen.get(key);
    if (!arr) {
      arr = [];
      burstSeen.set(key, arr);
      if (burstSeen.size > BURST.MAX_KEYS) burstSeen.delete(burstSeen.keys().next().value);
    }
    arr.push({ at: now, a: tailKey(name) || '?' });
    while (arr.length && now - arr[0].at > BURST.WINDOW_MS) arr.shift();
    return new Set(arr.map((x) => x.a)).size;
  }

  let whitelist = {};
  // Personnes confiées à Grok (csg_hand, tenu par le worker).
  let handTargets = {};

  safe(() =>
    chrome.storage.local.get({ csg_muted: {}, csg_live_muted: {}, csg_whitelist: {}, csg_hand: {} }, ({ csg_muted, csg_live_muted, csg_whitelist, csg_hand }) => {
      mutedUsers = csg_muted || {};
      liveMutedUsers = csg_live_muted || {};
      whitelist = csg_whitelist && typeof csg_whitelist === 'object' ? csg_whitelist : {};
      handTargets = csg_hand && typeof csg_hand === 'object' ? csg_hand : {};
      unhideWhitelisted();
      retroHideMuted();
      paintViewerCards();
    })
  );

  function applyMuteSync(muted) {
    const next = muted || {};
    for (const k of Object.keys(mutedUsers)) {
      if (!next[k]) releasedMutes.add(k);
    }
    for (const k of Object.keys(next)) releasedMutes.delete(k);
    mutedUsers = next;
    retroHideMuted();
  }

  function applyLiveMuteSync(muted) {
    liveMutedUsers = muted && typeof muted === 'object' ? muted : {};
    retroHideMuted();
  }

  // Les reglages arrivent en async. Tant qu'ils ne sont pas la, `settings` vaut
  // DEFAULTS : les lignes du debut etaient jugees avec un jeu de reglages, les
  // suivantes avec un autre. Sur un F5 ca donnait quelques coupes pendant la
  // fenetre de chargement puis plus rien du tout. flushPending attend ce drapeau.
  let settingsReady = false;
  // Fail-open : si storage.sync ne rappelle jamais (contexte d'extension
  // invalide apres un rechargement de l'extension, quota, profil casse), le
  // drapeau doit tomber quand meme. Sinon flushPending se reprogramme a l'infini
  // et PLUS AUCUNE ligne n'est jugee — pire que le bug qu'il corrige.
  const markSettingsReady = () => {
    settingsReady = true;
  };
  const settingsReadyTimer = setTimeout(markSettingsReady, 1500);
  contentCleanups.push(() => clearTimeout(settingsReadyTimer));
  try {
    chrome.storage.sync.get('csg_settings', ({ csg_settings }) => {
      if (chrome.runtime.lastError) return markSettingsReady();
      if (csg_settings) {
        settings = Object.assign({}, DEFAULTS, csg_settings, FORCED);
        if (settings.mode === 'hide') settings.mode = 'block';
      }
      markSettingsReady();
      // Le chargement des mutés peut avoir masqué des lignes avec les défauts
      // (masquage allumé, pause active) avant que le storage ne réponde.
      restyleAll();
      retroHideMuted();
      paintAmbiencePause();
    });
  } catch (_) {
    markSettingsReady();
  }

  // Liste apprise par le deep sur la base de verdicts. Elle vit dans
  // storage.local (et non sync) : elle est machine-locale, peut grossir, et ne
  // doit pas consommer le quota de sync partage avec les reglages.
  let activeReports = {};
  let authorNotes = {};
  safe(() =>
    chrome.storage.local.get({ csg_reports: {}, csg_author_notes: {} }, (v) => {
      activeReports = v && v.csg_reports && typeof v.csg_reports === 'object' ? v.csg_reports : {};
      authorNotes = v && v.csg_author_notes && typeof v.csg_author_notes === 'object' ? v.csg_author_notes : {};
      paintViewerCards();
    })
  );
  let regexRules = null;
  let learnedWords = [];
  function pageRegex(text) {
    const api = window.CSG_REGEX;
    return api ? api.match(text, regexRules) : null;
  }
  safe(() =>
    chrome.storage.sync.get({ csg_regex_rules: [] }, ({ csg_regex_rules }) => {
      regexRules = Array.isArray(csg_regex_rules) ? csg_regex_rules : [];
    })
  );
  safe(() =>
    chrome.storage.local.get({ csg_learned: [] }, ({ csg_learned }) => {
      learnedWords = (Array.isArray(csg_learned) ? csg_learned : []).map((r) => r && r.w).filter(Boolean);
    })
  );

  safe(() =>
    listenStorage((changes, area) => {
      if (area === 'sync' && changes.csg_settings) {
        settings = Object.assign({}, DEFAULTS, changes.csg_settings.newValue || {}, FORCED);
        if (settings.mode === 'hide') settings.mode = 'block';
        whyCache = '';
        restyleAll();
        retroHideMuted();
        paintHud();
      }
      if (area === 'sync' && changes.csg_regex_rules) {
        const v = changes.csg_regex_rules.newValue;
        regexRules = Array.isArray(v) ? v : [];
      }
      if (area === 'local' && changes.csg_reports) {
        const v = changes.csg_reports.newValue;
        activeReports = v && typeof v === 'object' ? v : {};
        paintViewerCards();
      }
      if (area === 'local' && changes.csg_author_notes) {
        const v = changes.csg_author_notes.newValue;
        authorNotes = v && typeof v === 'object' ? v : {};
        paintViewerCards();
      }
      if (area === 'local' && changes.csg_learned) {
        const v = changes.csg_learned.newValue;
        learnedWords = (Array.isArray(v) ? v : []).map((r) => r && r.w).filter(Boolean);
      }
      if (area === 'local' && changes.csg_model_status) {
        const v = changes.csg_model_status.newValue || {};
        modelReady = v.status === 'ready';
        bertStatus = v;
        paintHud();
      }
      if (area === 'local' && changes.csg_muted) {
        applyMuteSync(changes.csg_muted.newValue);
      }
      if (area === 'local' && changes.csg_live_muted) {
        applyLiveMuteSync(changes.csg_live_muted.newValue);
      }
      if (area === 'local' && changes.csg_whitelist) {
        const v = changes.csg_whitelist.newValue;
        whitelist = v && typeof v === 'object' ? v : {};
        unhideWhitelisted();
        paintViewerCards();
      }
      if (area === 'local' && changes.csg_hand) {
        const v = changes.csg_hand.newValue;
        handTargets = v && typeof v === 'object' ? v : {};
        paintViewerCards();
      }
      if (area === 'local' && changes.csg_audit) {
        lastAudit = changes.csg_audit.newValue || null;
        paintHud();
      }
    })
  );

  function rootDocs() {
    const out = [document];
    try {
      if (window.top && window.top.document && window.top.document !== document) {
        out.push(window.top.document);
      }
    } catch (_) {}
    return out;
  }

  function isWatchUrl(href) {
    return /\/videos\/\d+|\/clip\/|\/clips\/|\/v\/\d+|\/embed\/|\/popout\//i.test(href || '');
  }

  function channelFromDom() {
    const skip = {
      directory: 1,
      videos: 1,
      drops: 1,
      inventory: 1,
      settings: 1,
      subscriptions: 1,
      search: 1,
      p: 1,
      moderator: 1,
      dashboard: 1,
      downloads: 1,
      clips: 1
    };
    for (const doc of rootDocs()) {
      const nodes = doc.querySelectorAll(
        [
          '[data-a-target="watch-mode-to-home"]',
          '[data-a-target="video-info-username"]',
          'a[data-a-target="player-info-channel"]',
          '.channel-info-content a[href^="/"]',
          'a[data-test-selector="stream-info-card-component__title"]'
        ].join(',')
      );
      for (const a of nodes) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/^\/([^/?#]+)/);
        if (m && m[1] && !skip[m[1].toLowerCase()]) {
          try {
            return decodeURIComponent(m[1]).toLowerCase();
          } catch (_) {}
        }
      }
    }
    return '';
  }

  // Préfixe plateforme : « twitch/xxx » ou « kick/xxx ». Le background range le
  // chat, le journal et les mutes par ce libellé : on sait de quel chat vient
  // chaque message, et deux chaînes homonymes sur deux sites ne se mélangent plus.
  function siteTag() {
    return /(^|\.)kick\.com$/i.test(location.hostname) ? 'kick' : 'twitch';
  }

  function currentChannel() {
    const c = rawChannel();
    return c ? siteTag() + '/' + c : '';
  }

  // Uniquement les informations du stream, jamais les recommandations laterales.
  let streamContextCache = { channel: '', at: 0, value: {} };
  function currentStreamContext() {
    const channel = currentChannel();
    const now = Date.now();
    if (streamContextCache.channel === channel && now - streamContextCache.at < 3000) return streamContextCache.value;
    const value = { title: '', category: '' };
    for (const doc of rootDocs()) {
      const title = doc.querySelector('[data-a-target="stream-title"], [data-a-target="video-info-title"], [data-testid="stream-title"]');
      const category = doc.querySelector('[data-a-target="stream-game-link"], [data-a-target="video-info-game"], [data-testid="category-name"], [data-testid="stream-category"], .channel-info-content a[href*="/directory/category/"]');
      if (!value.title && title) value.title = String(title.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      if (!value.category && category) value.category = String(category.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    }
    streamContextCache = { channel, at: now, value };
    return value;
  }

  function rawChannel() {
    const fromDom = channelFromDom();
    if (fromDom) return fromDom;
    const hrefs = [];
    try {
      hrefs.push(location.href);
    } catch (_) {}
    try {
      if (window.top) hrefs.push(window.top.location.href);
    } catch (_) {}
    for (const href of hrefs) {
      try {
        const u = new URL(href);
        const path = u.pathname || '';
        const pop = path.match(/\/popout\/([^/]+)/i);
        if (pop) return decodeURIComponent(pop[1]).toLowerCase();
        const embed = path.match(/\/embed\/([^/]+)/i);
        if (embed) return decodeURIComponent(embed[1]).toLowerCase();
        const parts = path.split('/').filter(Boolean);
        if (!parts.length) continue;
        if (parts[0].toLowerCase() === 'videos' && parts[1]) return 'vod';
        const skip = {
          directory: 1,
          videos: 1,
          drops: 1,
          inventory: 1,
          settings: 1,
          subscriptions: 1,
          search: 1,
          p: 1,
          moderator: 1,
          dashboard: 1,
          downloads: 1,
          clips: 1,
          browse: 1,
          category: 1,
          categories: 1,
          following: 1
        };
        if (skip[parts[0].toLowerCase()]) continue;
        return decodeURIComponent(parts[0]).toLowerCase();
      } catch (_) {}
    }
    return '';
  }

  function hasChat() {
    return !!(
      document.querySelector('[data-a-target="chat-input"]') ||
      document.querySelector('[data-a-target="chat-send-button"]') ||
      document.querySelector('[data-test-selector="chat-scrollable-area__message-container"]') ||
      document.querySelector('.chat-scrollable-area__message-container') ||
      document.querySelector('.seventv-chat-list') ||
      document.querySelector('.video-chat') ||
      document.querySelector('.video-chat__message-list-wrapper') ||
      document.querySelector('[data-a-target="video-chat"]') ||
      document.querySelector('[class*="video-chat"]') ||
      document.querySelector('[data-testid="chatroom-messages"]') ||
      document.querySelector('[data-testid="chat-input"]') ||
      document.querySelector(LINE_SEL)
    );
  }

  // Jeu du stream courant uniquement — jamais toute la page (sidebar = piege).
  const CS2_RE = /counter[\s-]?strike|\bcs[\s-]?2\b|\bcs2\b|\bcs[\s:]?go\b/i;

  function pageLooksLikeCs2() {
    for (const doc of rootDocs()) {
      const boxes = doc.querySelectorAll(
        [
          '[data-a-target="stream-game-link"]',
          'a[data-a-target="stream-game-link"]',
          'a[data-a-target="video-info-game"]',
          '.channel-info-content a[href*="/directory/category/"]',
          '.channel-info-content a[href*="/directory/game/"]',
          '.about-section a[href*="/directory/category/"]',
          '[data-testid="category-name"]',
          '[data-testid="stream-category"]',
          'a[href^="/categories/"]'
        ].join(',')
      );
      for (const el of boxes) {
        const href = el.getAttribute && el.getAttribute('href');
        const txt = ((el.textContent || '') + ' ' + (href || '')).trim();
        if (txt && CS2_RE.test(txt)) return true;
      }
      // Kick : le libelle de categorie est parfois hors <a>.
      const kickCat = doc.querySelector('.stream-category, [class*="Category"]');
      if (kickCat && CS2_RE.test(kickCat.textContent || '')) return true;
    }
    return false;
  }

  function captureWhy() {
    if (!settings.enabled) return 'filtre désactivé dans le popup';
    // Un onglet en arrière-plan renvoyait 'onglet en arrière-plan', donc
    // flushPending jetait le lot sans le juger : rien n'était analysé tant que
    // le stream n'était pas l'onglet actif. Le MutationObserver, lui, continue
    // de recevoir les lignes en arrière-plan — il n'y a aucune raison de les
    // lâcher. On ne bloque plus là-dessus.
    if (!hasChat()) return 'pas de chat dans cette frame — ouvre le panneau Chat replay';
    const hrefs = [];
    try {
      hrefs.push(location.href);
    } catch (_) {}
    try {
      if (window.top) hrefs.push(window.top.location.href);
    } catch (_) {}
    if (!(hrefs.some(isWatchUrl) || currentChannel())) return 'pas un live / rediff Twitch ou Kick';
    // Capture TOUJOURS (tous les chats). La portee CS2 ne coupe plus la
    // capture : elle filtre seulement ce qui part au modele (voir wantsLlmQueue).
    return 'ok';
  }

  // File LLM : oui si jugement coupe (stockage pour plus tard), ou si le live
  // entre dans la portee (tous / CS2). Sinon journal seul, zero appel.
  function wantsLlmQueue() {
    if (settings.judge === false) return true;
    return settings.scope === 'all' || pageLooksLikeCs2();
  }

  function isChatFrame() {
    return hasChat();
  }

  const pending = new Set();
  let flushT = null;
  contentCleanups.push(() => {
    clearTimeout(flushT);
    flushT = null;
    pending.clear();
  });

  function isComposer(el) {
    if (!el || !el.closest) return true;
    return !!el.closest(
      '[data-a-target="chat-input"], [data-a-target="chat-input-container"], .chat-input, textarea, ' +
        '[contenteditable="true"], [data-testid="chat-input"], #csg-hud'
    );
  }

  function isChatLine(el) {
    if (!(el instanceof HTMLElement) || !el.matches || !el.matches(LINE_SEL)) return false;
    const inner = el.querySelector(LINE_SEL);
    if (inner) return false;
    // Kick range aussi ses séparateurs (« Nouveaux messages ») dans des rows
    // [data-index] : sans pseudo, ce n'est pas un message de viewer.
    if (el.hasAttribute('data-index') && !el.querySelector(AUTHOR_SEL)) return false;
    return true;
  }

  // Longueur du texte de Kick seul : l'étiquette « bloqué · … » qu'act() pose
  // dans la row la faisait passer pour recyclée au rescan suivant, qui la
  // démasquait et la recapturait toutes les ~4 s.
  function rowLen(el) {
    let n = (el.textContent || '').length;
    el.querySelectorAll('.csg-chip, .csg-blocked-label').forEach((x) => {
      n -= (x.textContent || '').length;
    });
    return String(n);
  }

  // Empreinte stable du message Kick : 7TV / badges / horodatage changent
  // textContent (donc rowLen) sans changer le message → unhide + recloison
  // en boucle, et le renderer Brave partait en 2 Go / 100 % CPU.
  function rowKey(el) {
    const a = String(
      chatName(el) ||
        el.getAttribute('data-a-user') ||
        el.getAttribute('data-user') ||
        ''
    );
    let t = '';
    try {
      const frags = el.querySelectorAll(
        '.text-fragment, .seventv-chat-message-body, .seventv-chat-message-text, span[class*="leading-["]'
      );
      t = Array.from(frags, (frag) => frag.textContent || '').join(' ');
    } catch (_) {}
    if (!t) t = el.textContent || '';
    return a + '|' + String(t).replace(/\s+/g, ' ').trim().slice(0, 800);
  }

  const liveLineAt = new WeakMap();
  const ambienceLineAt = new WeakMap();
  const ambienceRowKeys = new WeakMap();

  function queueLine(el, liveAt, ambienceAt) {
    // Fast path rescans : 1 lookup dataset avant les matches/selectors coûteux.
    // (En rescan, 95% des lignes sont déjà traitées → sortie quasi-immédiate.)
    if (!el || !el.dataset) return;
    if (el.dataset.csg) {
      // Kick recycle les noeuds de sa liste virtualisée : une row déjà traitée
      // peut se retrouver à porter un AUTRE message. Sans ce garde, le nouveau
      // texte héritait du verdict de l'ancien et restait masqué pour rien.
      // Twitch ne recycle pas : on ne paie le contrôle que sur les rows Kick.
      if (!el.hasAttribute('data-index')) return;
      const key = rowKey(el);
      if (el.dataset.csgKey === key || (!el.dataset.csgKey && el.dataset.csgLen === rowLen(el))) return;
      unhideLine(el);
      delete el.dataset.csg;
      delete el.dataset.csgKey;
      delete el.dataset.csgName;
      delete el.dataset.csgId;
      delete el.dataset.csgReply;
      delete el.dataset.csgReplyTo;
      delete el.dataset.csgReplyQuote;
      liveLineAt.delete(el);
      ambienceLineAt.delete(el);
    }
    if (el.id === 'csg-hud' || (el.closest && el.closest('#csg-hud'))) return;
    if (!isChatLine(el)) return;
    if (isComposer(el)) return;
    // Observer batches and backlog rescans can queue the same row before its
    // 80 ms flush. Keep its first observation time and live eligibility.
    if (pending.has(el)) return;
    liveLineAt.set(el, Number(liveAt) || 0);
    ambienceLineAt.set(el, typeof ambienceAt === 'number' ? ambienceAt : 0);
    if (typeof ambienceAt === 'number' && ambienceAt > 0 && settings.ambiencePause !== false && settings.enabled !== false) {
      const key = rowKey(el);
      if (ambienceRowKeys.get(el) !== key) {
        ambienceRowKeys.set(el, key);
        const reply = extractReply(el);
        const text = msgText(el) || Array.from(el.querySelectorAll('img[alt]')).map((img) => img.getAttribute('alt')).join(' ') || '[emotes seules]';
        sendBg({ type: 'CSG_AMBIENCE_CAPTURE', id: nextId(), author: chatName(el), text,
          capturedAt: ambienceAt, ambienceEligible: true, channel: currentChannel(), replyTo: reply.to, replyQuote: reply.quote });
      }
    }
    pending.add(el);
    if (!flushT) flushT = setTimeout(flushPending, 80);
  }

  function flushPending() {
    flushT = null;
    if (ctxDead()) return teardown();
    // Rien n'est marque vu ici : les lignes restent dans `pending` et repassent
    // au prochain tour, des que les reglages sont charges.
    if (!settingsReady) {
      flushT = setTimeout(flushPending, 50);
      return;
    }
    lastWhy = getWhy();
    lastChannel = currentChannel();
    if (lastWhy !== 'ok') {
      // Hors scope (pas un chat CS2 / filtre off) : on marque les lignes en
      // attente comme vues et on les drop. Avant, elles s'accumulaient dans
      // `pending` sans jamais être clearées → bombe de backlog (100s d'appels
      // LLM d'un coup) dès le retour sur un stream CS2.
      //
      // MAIS un onglet en arrière-plan n'est PAS un hors-scope : c'est le bon
      // chat, les lignes sont dans le DOM et encore à l'écran au retour. Les
      // marquer vues les perdait DÉFINITIVEMENT — queueLine sort dès qu'il voit
      // data-csg, donc le rescan du visibilitychange les sautait aussi. C'est ce
      // qui faisait des trous dans le journal. On les oublie sans les marquer :
      // le rescan les reprend, borné par ce que le chat a gardé en DOM.
      const bg = document.visibilityState === 'hidden';
      for (const el of pending) {
        try {
          if (!bg && el && el.dataset) el.dataset.csg = '1';
        } catch (_) {}
      }
      pending.clear();
      paintHud();
      flushT = setTimeout(flushPending, 2000);
      return;
    }
    const batch = Array.from(pending);
    pending.clear();
    for (const el of batch) {
      if (el.isConnected) handleLine(el);
    }
    paintHud();
  }

  function nextId() {
    return 'csg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function logCapture(payload) {
    const retry = () => {
      const el = lineById(payload.id);
      if (el && el.dataset.csgId === payload.id) delete el.dataset.csg;
    };
    sendBg(Object.assign({ type: 'CSG_CAPTURE' }, payload), {
      expectReply: true,
      onDrop: retry,
      onReply: (res) => { if (!res || res.ok !== true) retry(); }
    });
  }

  function capturePayload(el, author, text, id, extra) {
    const born = (el && liveLineAt.get(el)) || 0;
    const ambienceAt = (el && ambienceLineAt.get(el)) || 0;
    return Object.assign(
      {
        id: id || (el && el.dataset && el.dataset.csgId) || '',
        author: author || '',
        text,
        capturedAt: born || ambienceAt || Date.now(),
        liveEligible: born > 0,
        ambienceEligible: ambienceAt > 0,
        channel: lastChannel || currentChannel(),
        streamContext: currentStreamContext(),
        replyTo: (el && el.dataset && el.dataset.csgReplyTo) || '',
        replyQuote: (el && el.dataset && el.dataset.csgReplyQuote) || ''
      },
      extra || {}
    );
  }

  // Les auteurs protégés échappent au filtre, mais peuvent quand même te répondre.
  function captureProtectedReply(el) {
    if (!el || !el.dataset) return;
    const author = chatName(el);
    const text = msgText(el);
    if (!author || !text || isSelfName(author)) return;
    const autoTarget = !replyAssistEnabled && replyAutoTargets[String(author).toLowerCase()];
    if (!autoTarget && (!replyAssistEnabled || !ambienceLineAt.get(el))) return;
    const reply = extractReply(el);
    if (!el.dataset.csgId) el.dataset.csgId = nextId();
    sendBg(Object.assign({ type: 'CSG_REPLY_ASSIST_CAPTURE' }, capturePayload(el, author, text,
      el.dataset.csgId, { replyTo: reply.to, replyQuote: reply.quote })));
  }

  function enqueueLlm(author, text, id, el, extra) {
    if (!wantsLlmQueue()) return;
    const drop = () => {
      if (el && el.dataset) delete el.dataset.csg;
    };
    sendBg(
      Object.assign(
        {
          type: 'CSG_ENQUEUE',
          author: author || '',
          text,
          id,
          channel: lastChannel || currentChannel(),
          replyTo: (el && el.dataset && el.dataset.csgReplyTo) || '',
          replyQuote: (el && el.dataset && el.dataset.csgReplyQuote) || ''
        },
        extra || {}
      ),
      {
        expectReply: true,
        onReply: (res) => {
          if (!res || !res.ok) drop();
        },
        onDrop: drop
      }
    );
  }

  function handleLine(el) {
    if (!isChatLine(el)) return;
    if (isComposer(el)) return;
    if (isBroadcaster(el) || isOwnMessage(el)) {
      const author = chatName(el);
      if (author) el.dataset.csgName = author;
      unhideLine(el);
      el.dataset.csg = '1';
      el.dataset.csgKey = rowKey(el);
      el.dataset.csgLen = rowLen(el);
      // Le streamer n'est jamais filtré, mais s'il répond à un muté sa ligne
      // republie quand même le message coupé.
      maskReply(el);
      if (isOwnMessage(el)) noteMine(el);
      else { addGrokBtn(el); captureProtectedReply(el); }
      return;
    }
    if (el.dataset.csg) return;
    el.dataset.csg = '1';
    el.dataset.csgLen = rowLen(el);
    el.dataset.csgKey = rowKey(el);
    const reply = extractReply(el);
    const rawText = msgText(el);
    if (!rawText) {
      // React can attach the row before filling its message. Leave an empty
      // shell available for the later mutation instead of marking it captured.
      if (!emoteCount(el)) {
        delete el.dataset.csg;
        delete el.dataset.csgKey;
        return;
      }
      // Mur d'emotes : que des <img>, donc aucun texte. Sans ce cas la ligne
      // sortait ici et le mur restait entier a l'ecran.
      const who = chatName(el);
      if (who && (isSelfName(who) || isWhitelisted(who))) {
        el.dataset.csgName = who;
        unhideLine(el);
        return;
      }
      if (settings.hideCopypasta !== false && emoteCount(el) >= PASTA.EMOTES) {
        if (who) el.dataset.csgName = who;
        act(el, 0.9, 'copypasta');
      }
      return;
    }

    const author = chatName(el);
    if (author) el.dataset.csgName = author;
    if (isSelfName(author) || isWhitelisted(author)) {
      unhideLine(el);
      if (isSelfName(author)) noteMine(el);
      else { addGrokBtn(el); captureProtectedReply(el); }
      return;
    }
    if (reply.to) el.dataset.csgReplyTo = reply.to;
    if (reply.quote) el.dataset.csgReplyQuote = reply.quote;
    if (!reply.to && !reply.quote) el.dataset.csgReply = '0';
    else maskReply(el);
    const alreadyCounted = !!el.dataset.csgId;
    const id = el.dataset.csgId || nextId();
    el.dataset.csgId = id;
    addGrokBtn(el);

    if (!alreadyCounted) capturedCount += 1;
    lastSeen = { author: author || '?', text: rawText, at: Date.now() };

    if (hideMuted() && author && author !== '?' && mutedHere(author.toLowerCase())) {
      logCapture(capturePayload(el, author, rawText, id, { source: 'muted', label: 'mute', score: 1 }));
      act(el, 1, 'muet');
      return;
    }

    // Filtres locaux tout de suite (mots perso, liste, insulte lourde, copypasta,
    // insulte recollée). Le reste attend le clic : pas d'appel au juge ici.
    const extra = window.CSG_KEYWORDS.parseExtra(settings.extraWords);
    if (extra.length && window.CSG_KEYWORDS.hitExtra(rawText, extra)) {
      logCapture(capturePayload(el, author, rawText, id, { source: 'extra', label: 'mute', score: 1.01 }));
      act(el, 1.01, 'mot perso');
      return;
    }
    const rx = pageRegex(rawText);
    if (rx && rx.action === 'review') {
      logCapture(capturePayload(el, author, rawText, id, { source: 'regex', label: 'review', score: 0.7, why: rx.reason }));
      return;
    }
    if (rx) {
      logCapture(capturePayload(el, author, rawText, id, { source: 'regex', label: 'mute', score: 0.99, why: rx.reason }));
      act(el, 0.99, 'regex');
      return;
    }
    // Liste apprise : passe APRES les mots perso (l'utilisateur prime) et AVANT
    // analyze(), puisque par construction analyze() ne connait pas ces termes —
    // c'est precisement pour ca qu'ils ont ete appris.
    const learnHit =
      settings.learn !== false && learnedWords.length
        ? window.CSG_KEYWORDS.matchExtra(rawText, learnedWords)
        : '';
    if (learnHit) {
      // Le terme fautif est memorise sur la ligne : si l'utilisateur revele le
      // message, c'est lui qu'on accusera (voir toggleReveal).
      el.dataset.csgTerm = learnHit;
      // Le terme part AVEC la ligne : c est lui que la verification met en
      // cause si elle innocente le message (releaseAfterRevise cote fond).
      logCapture(capturePayload(el, author, rawText, id, { source: 'appris', label: 'mute', score: 0.95, term: learnHit }));
      act(el, 0.95, 'appris');
      return;
    }
    const verdict = window.CSG_KEYWORDS.analyze(rawText);
    // Horodatage / ligne sans auteur : pas un viewer. Envoyer ca au modele
    // remplissait le journal d auteurs « ? » et un seul mute les masquait tous.
    if (!author && (verdict.trivial || /^\d{1,2}:\d{2}(?::\d{2})?$/.test(rawText))) {
      logCapture(capturePayload(el, author, rawText, id, { source: 'trivial', label: 'keep' }));
      return;
    }
    // Recollage : juge AVANT d'inscrire la ligne dans sa propre queue.
    const joined = joinedVerdict(author, rawText);
    rememberTail(author, rawText, el);
    if (joined) {
      logCapture(capturePayload(el, author, rawText, id, { source: 'recolle', label: 'mute', score: 0.96, joined: joined.joined }));
      act(el, 0.96, 'recolle');
      // Les fragments precedents sont deja affiches : on les masque aussi.
      for (const p of joined.parts) {
        if (p.el && p.el.dataset && p.el.dataset.csgBlocked !== '1') act(p.el, 0.96, 'recolle');
      }
      return;
    }
    // Les quatre classes de mots-cles. En mode 100% LLM elles ne tranchent
    // plus : `kwHint` part au modele comme indice et la ligne suit le chemin
    // normal de la file. Sinon, ancien comportement — mute local immediat.
    const KW = [
      ['heavy', verdict.heavy, 0.99, 'liste locale', 'keyword'],
      ['harsh', verdict.harsh, 0.97, 'harsh', 'harsh'],
      ['vitality', verdict.vitalityHate, 0.98, 'vitality', 'vitality'],
      ['67', verdict.brainrot, 0.99, 'ref 67', '67']
    ];
    const kw = KW.find((k) => k[1]);
    const kwHint = kw ? kw[0] : '';
    // Insultes évidentes ou dures : mute préventif immédiat (0 ms) à l'écran,
    // puis le message est quand même transmis pour confirmation éventuelle.
    if (kw && (kw[0] === 'heavy' || kw[0] === 'harsh' || settings.llmOnly === false)) {
      logCapture(capturePayload(el, author, rawText, id, { source: kw[4], label: 'mute', score: kw[2] }));
      act(el, kw[2], kw[3]);
      return;
    }
    // Copypasta : du bruit, pas de la toxicite. On masque la ligne, on ne mute
    // pas l'auteur, et le fond ne la reapprend pas (voir idleSkipSource).
    if (settings.hideCopypasta !== false) {
      const why = pastaReason(el, rawText);
      if (why) {
        logCapture(capturePayload(el, author, rawText, id, { source: 'copypasta', label: 'mute', score: 0.9, why }));
        act(el, 0.9, 'copypasta');
        return;
      }
    }
    const burst = noteBurst(author, rawText);
    if (verdict.trivial || verdict.clean) {
      // Rafale : le meme jeton anodin par >= 3 auteurs en 30 s n'est plus anodin,
      // c'est un dogpile. Il part au modele avec son compte au lieu du keep sec
      // (c'etait la classe HARD_FN : jamais jugee par personne).
      if (burst >= BURST.MIN && !BURST_SKIP_RE.test(rawText)) {
        logCapture(capturePayload(el, author, rawText, id, { source: 'rafale', label: 'pending', hint: 'rafale', burst }));
        return;
      }
      // En 100% LLM on ne classe plus rien en anodin sans avis du modele : la
      // ligne tombe dans l'enqueue commun plus bas. C'est le gros du volume.
      if (settings.llmOnly === false) {
        logCapture(capturePayload(el, author, rawText, id, { source: verdict.trivial ? 'trivial' : 'clean', label: 'keep' }));
        return;
      }
    }

    const hint = kwHint || verdict.hint || '';
    logCapture(capturePayload(el, author, rawText, id, { source: 'pending', label: 'pending', hint, burst }));
  }

  // Un seul reglage, une seule question : les mutés sont-ils masqués a l'ecran ?
  // Il ne decide PLUS si l'auteur est mute — ça, c'est toujours oui : le journal,
  // les compteurs et la fiche de mute suivent leur cours quoi qu'il arrive.
  // Coupé, l'ecran est du chat vanilla ; recoché, tout se remasque sans rejuger.
  function hideMuted() {
    return settings.target !== 'message';
  }

  // Un mute vaut pour UN site (meme regle que muteSite/mutedOn dans background.js) :
  // un « bob » Kick n'est pas le « bob » Twitch. site '' = les deux ; un ancien
  // mute sans champ `site` prend le site de son canal.
  function muteSite(rec) {
    if (!rec) return '';
    if (typeof rec.site === 'string') return rec.site;
    const m = /^(kick|twitch)\//i.exec(String(rec.channel || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function mutedHere(key) {
    const rec = key ? mutedUsers[key] : null;
    const here = siteTag();
    if (rec) {
      if (rec.sites && typeof rec.sites === 'object' && (rec.sites.kick || rec.sites.twitch)) {
        if (!here || rec.sites[here]) return rec;
      } else {
        const s = muteSite(rec);
        if (!s || s === here) return rec;
      }
    }
    const channel = currentChannel();
    const live = channel && liveMutedUsers[channel + '\n' + key];
    return live && Number(live.expiresAt) > Date.now() &&
      Number(live.sessionUntil) > Date.now() ? live : null;
  }

  function muteAuthor(name, score, reason, manual) {
    const key = nick(name);
    if (!key || isSelfName(key) || isWhitelisted(key) || mutedHere(key)) return;
    const channel = currentChannel();
    const site = siteTag();
    const prev = mutedUsers[key];
    if (!prev) {
      mutedUsers[key] = {
        at: Date.now(),
        pct: Math.round((Number(score) || 1) * 100),
        strikes: reason || 'flou',
        channel,
        site
      };
    } else if (site === 'kick' || site === 'twitch') {
      const sites = {};
      if (prev.sites && typeof prev.sites === 'object') {
        if (prev.sites.kick) sites.kick = prev.sites.kick;
        if (prev.sites.twitch) sites.twitch = prev.sites.twitch;
      }
      const prevSite = muteSite(prev);
      if ((prevSite === 'kick' || prevSite === 'twitch') && !sites[prevSite]) {
        sites[prevSite] = { at: prev.at, pct: prev.pct, strikes: prev.strikes, channel: prev.channel, perm: prev.perm };
      }
      sites[site] = {
        at: Date.now(),
        pct: Math.round((Number(score) || 1) * 100),
        strikes: reason || 'flou',
        channel
      };
      mutedUsers[key] = Object.assign({}, prev, { sites });
    }
    try {
      sendBg(
        {
          type: 'CSG_LOCAL_MUTE',
          author: key,
          channel,
          score: Number(score) || 0.99,
          reason: reason || 'flou'
        },
        {
          expectReply: true,
          onReply: (res) => {
            if (manual !== true || (res && res.applied !== false)) return;
            delete mutedUsers[key];
            releasedMutes.add(key);
            retroHideMuted();
            paintViewerCards();
          },
          onDrop: () => {
            if (manual !== true) return;
            delete mutedUsers[key];
            releasedMutes.add(key);
            retroHideMuted();
            paintViewerCards();
          }
        }
      );
    } catch (_) {}
  }

  function harvestBlurred() {
    // Une ligne floutée par un ancien état ne crée plus de mute automatiquement.
    return;
    const nodes = document.querySelectorAll('.csg-blur, [data-csg-blocked="1"]');
    nodes.forEach((el) => {
      const line = (el.closest && el.closest(LINE_SEL)) || (isChatLine(el) ? el : el.parentElement);
      if (!line) return;
      // Un masquage 'LLM?' est le verdict PROVISOIRE du fast : act() ne mute pas
      // dessus exprès (le deep peut encore innocenter). Sans ce garde, ce balayage
      // périodique mutait quand même l'auteur 5s plus tard et contournait
      // entièrement canMuteAuthor:false — exactement le trou que 'LLM?' devait combler.
      if (line.dataset && (line.dataset.csgReason === 'LLM?' || line.dataset.csgReason === 'copypasta')) return;
      const n = (line.dataset && line.dataset.csgName) || chatName(line) || '';
      const key = String(n).trim().toLowerCase();
      if (!key || isSelfName(key) || releasedMutes.has(key)) return;
      muteAuthor(key, 1, 'flou');
    });
  }

  function act(el, score, reason) {
    // Toutes les raisons locales passent ici : mot perso, liste, harsh, recollé,
    // appris, copypasta. Les limiter à muet/LLM laissait l'insulte à l'écran et
    // fermait le journal en « mute », donc le clic ne la revoyait plus.
    if (!isChatLine(el) || el.dataset.csgBlocked === '1') return;
    const name = (el.dataset.csgName || chatName(el) || '').toLowerCase();
    if (name) {
      el.dataset.csgName = name;
      if (isSelfName(name) || isWhitelisted(name) || isOwnMessage(el)) {
        unhideLine(el);
        return;
      }
      // 'LLM?' = verdict provisoire du modèle rapide : on masque, mais on ne mute
      // pas l'auteur tant que le modèle lent n'a pas confirmé.
      // 'copypasta' = bruit, pas toxicite : la ligne tombe, l'auteur reste libre.
      if (reason !== 'muet' && reason !== 'LLM?' && reason !== 'copypasta') muteAuthor(name, score, reason);
    }

    el.dataset.csgBlocked = '1';
    el.dataset.csgReason = reason || '';
    el.title = 'Masqué par Refchat — ' + reason;
    applyStyle(el);

    pageBlocked += 1;
    bumpTotal();
  }

  function labelText(el) {
    const reason = el.dataset.csgReason || '';
    if (el.classList.contains('csg-revealed')) return 'masquer';
    if (reason === 'muet') return 'muté';
    // « — voir » est repris par le ::after de la puce, qui ne le déplie qu'au
    // survol : le répéter ici allongerait l'étiquette sur chaque ligne.
    return reason ? 'bloqué · ' + reason : 'bloqué';
  }

  function toggleReveal(el) {
    el.classList.toggle('csg-revealed');
    const lbl = el.querySelector('.csg-blocked-label');
    if (lbl) lbl.textContent = labelText(el);
    reportLearnReveal(el);
  }

  // Boucle de retour de la liste apprise. Reveler un message masque par un terme
  // APPRIS est le seul signal de faux positif qu'on puisse observer sans rien
  // demander : l'utilisateur vient de dire, en actes, que ce blocage etait faux.
  // Un terme revele sur plusieurs messages differents se retire tout seul.
  // Ne compte que la premiere revelation d'une ligne : replier/deplier le meme
  // message ne doit pas condamner un terme trois fois.
  function reportLearnReveal(el) {
    if (!el || !el.classList.contains('csg-revealed')) return;
    const term = el.dataset && el.dataset.csgTerm;
    if (!term || el.dataset.csgTermSent === '1') return;
    el.dataset.csgTermSent = '1';
    sendBg(
      { type: 'CSG_LEARN_REVEAL', w: term, text: String(msgText(el) || '').slice(0, 120) },
      { expectReply: true }
    );
  }

  function blockedLabel(el) {
    const s = document.createElement('span');
    s.className = 'csg-blocked-label';
    s.setAttribute('role', 'button');
    s.tabIndex = 0;
    s.title = 'Afficher / masquer le message d’origine';
    const toggle = (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleReveal(el);
    };
    s.addEventListener('click', toggle);
    s.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') toggle(e);
    });
    return s;
  }

  function applyStyle(el) {
    // Masquer les mutés coupé : la ligne garde son verdict (csgBlocked,
    // csgReason, compteurs, journal, mute de l'auteur), on retire seulement ce
    // qui se voit. Recocher remet tout en place — restyleAll() repasse sur ces
    // memes lignes, aucune n'est rejugee.
    if (!hideMuted()) {
      el.classList.remove('csg-blur', 'csg-hidden', 'csg-block', 'csg-mute', 'csg-revealed');
      el.removeAttribute('title');
      el.querySelectorAll('.csg-blocked-label').forEach((n) => n.remove());
      return;
    }
    // Une ligne jugée par le modèle disparaît sans la puce « bloqué · LLM ».
    // blankMute : même sort pour un auteur déjà muet — plus de pseudo à l'écran.
    const reason = el.dataset.csgReason || '';
    const mode =
      reason === 'LLM' || (reason === 'muet' && settings.blankMute === true)
        ? 'hide'
        : settings.mode === 'hide'
          ? 'block'
          : settings.mode || 'block';
    el.classList.remove('csg-blur', 'csg-hidden', 'csg-block', 'csg-mute');
    let old = el.querySelector('.csg-blocked-label');
    if (mode === 'block') {
      el.classList.add('csg-block');
      if (reason === 'muet') el.classList.add('csg-mute');
      el.title = 'Masqué par Refchat — clique pour voir';
      if (!old) {
        old = blockedLabel(el);
        el.appendChild(old);
      }
      old.textContent = labelText(el);
    } else if (mode === 'hide') {
      if (old) old.remove();
      el.classList.add('csg-hidden');
    } else {
      if (old) old.remove();
      el.classList.add('csg-blur');
    }
  }

  function restyleAll() {
    // LINE_SEL est une LISTE de selecteurs separes par des virgules : y coller
    // '[data-csg-blocked="1"]' ne filtrait que le DERNIER element de la liste.
    // La requete renvoyait donc TOUTES les lignes du chat, et applyStyle les
    // masquait toutes des qu un parametre changeait. Filtrage en JS a la place.
    document.querySelectorAll(LINE_SEL).forEach((el) => {
      if (el.dataset && el.dataset.csgBlocked === '1') applyStyle(el);
    });
  }

  function isBroadcaster(el) {
    if (el.querySelector('[data-a-target="badge-broadcaster"], [data-testid="identity-badge-broadcaster"]')) return true;
    const n = chatName(el);
    const ch = rawChannel();
    return !!(n && ch && n === ch);
  }

  function chatName(el) {
    const fromAttr = nick(el.getAttribute('data-a-user') || el.getAttribute('data-user') || el.getAttribute('data-username') || '');
    if (fromAttr) return fromAttr.slice(0, 60);
    const n = el.querySelector(AUTHOR_SEL);
    const t = n ? (n.textContent || '').trim().toLowerCase().slice(0, 60) : '';
    return nick(t);
  }

  let selfNicks = new Set();
  let selfNicksAt = 0;
  let selfPublished = '';

  function nick(s) {
    return String(s || '')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/^@+/, '')
      .trim()
      .toLowerCase();
  }

  function readCookie(name) {
    const parts = document.cookie ? document.cookie.split(';') : [];
    for (const part of parts) {
      const i = part.indexOf('=');
      if (i === -1) continue;
      if (part.slice(0, i).trim() !== name) continue;
      const raw = part.slice(i + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch (_) {
        return raw;
      }
    }
    return '';
  }

  function refreshSelfNicks(force) {
    const now = Date.now();
    if (!force && selfNicks.size && now - selfNicksAt < 4000) return selfNicks;
    const next = new Set();
    const login = nick(readCookie('login'));
    const name = nick(readCookie('name'));
    if (login) next.add(login);
    if (name) next.add(name);
    for (const doc of rootDocs()) {
      const els = doc.querySelectorAll(
        '[data-a-target="user-menu-toggle"] img[alt], [data-a-target="user-display-name"]'
      );
      for (const el of els) {
        const v = nick(el.getAttribute('alt') || el.textContent);
        if (v && v.length > 1 && v !== 'user') next.add(v);
      }
    }
    selfNicks = next;
    selfNicksAt = now;
    const key = Array.from(next).sort().join('|');
    if (key && key !== selfPublished) {
      selfPublished = key;
      for (const n of next) {
        if (mutedUsers[n]) delete mutedUsers[n];
      }
      sendBg({ type: 'CSG_SELF', nicks: Array.from(next) }, { expectReply: true });
    }
    return selfNicks;
  }

  function isSelfName(name) {
    const key = nick(name);
    if (!key) return false;
    const nicks = refreshSelfNicks();
    if (nicks.has(key)) return true;
    for (const n of nicks) {
      if (n && n.replace(/\s+/g, '') === key.replace(/\s+/g, '')) return true;
    }
    return false;
  }

  function isWhitelisted(name) {
    const key = nick(name);
    return !!(key && whitelist[key]);
  }

  function isOwnMessage(el) {
    if (
      el.classList.contains('chat-line__message--own-message') ||
      el.classList.contains('chat-line__message--self')
    ) {
      return true;
    }
    const fromAttr = nick(el.getAttribute('data-a-user') || el.getAttribute('data-user') || '');
    if (fromAttr && isSelfName(fromAttr)) return true;
    return isSelfName(el.dataset.csgName || chatName(el));
  }

  function unhideLine(el) {
    if (!el || !el.dataset) return;
    el.classList.remove('csg-blur', 'csg-hidden', 'csg-block', 'csg-mute', 'csg-revealed');
    if (el.dataset.csgBlocked) delete el.dataset.csgBlocked;
    if (el.dataset.csgReason) delete el.dataset.csgReason;
    el.removeAttribute('title');
    el.querySelectorAll('.csg-chip, .csg-blocked-label').forEach((n) => n.remove());
  }

  function unhideSelfLines() {
    refreshSelfNicks();
    document.querySelectorAll(LINE_SEL).forEach((el) => {
      if (!isChatLine(el)) return;
      if (!isOwnMessage(el) && !isSelfName(el.dataset.csgName || chatName(el))) return;
      const author = chatName(el);
      if (author) el.dataset.csgName = author;
      el.dataset.csg = '1';
      unhideLine(el);
    });
  }

  function unhideWhitelisted() {
    document.querySelectorAll(LINE_SEL).forEach((el) => {
      if (!isChatLine(el)) return;
      const author = nick(el.dataset.csgName || chatName(el));
      if (!author || !isWhitelisted(author)) return;
      el.dataset.csgName = author;
      el.dataset.csg = '1';
      delete mutedUsers[author];
      unhideLine(el);
    });
  }

  function toggleWhitelist(names, on) {
    const prev = whitelist;
    const next = Object.assign({}, whitelist);
    const at = Date.now();
    for (const n of names) {
      const k = nick(n);
      if (!k) continue;
      if (on) next[k] = { at };
      else delete next[k];
    }
    whitelist = next;
    unhideWhitelisted();
    paintViewerCards();
    const revert = () => {
      whitelist = prev;
      paintViewerCards();
    };
    sendBg(
      { type: 'CSG_WHITELIST', names, on },
      { expectReply: true, onReply: (res) => { if (!res || !res.ok) revert(); }, onDrop: revert }
    );
  }

  function retroHideMuted() {
    document.querySelectorAll(LINE_SEL).forEach((el) => {
      if (!isChatLine(el)) return;
      // Avant tout test d'auteur : la citation d'un muté doit tomber même sur
      // les lignes qu'on garde visibles.
      maskReply(el);
      const n = String(el.dataset.csgName || chatName(el) || '')
        .trim()
        .toLowerCase();
      if (n) el.dataset.csgName = n;
      if (n && (isSelfName(n) || isWhitelisted(n))) {
        unhideLine(el);
        return;
      }
      if (n && hideMuted() && mutedHere(n)) {
        if (!el.dataset.csgBlocked) act(el, 1, 'muet');
        return;
      }
      if (el.dataset.csgBlocked && el.dataset.csgReason === 'muet') unhideLine(el);
    });
  }

  // Pas de \b apres « à » : \b est ASCII en JS, et « à » n'y est pas un
  // caractere de mot — la limite ne se declenchait jamais et le repli Kick ne
  // trouvait rien. On exige une espace, ce que la mise en forme donne toujours.
  const RE_REPLY_HEAD = /^\s*(?:répond(?:s|re)?\s+à|réponse\s+à|replying\s+to)\s/i;

  // Kick n'expose aucune classe « reply » : REPLY_SEL ne trouve rien et
  // l'en-tête « Répond à @x : … » passait entre les mailles. Repli sur le
  // texte, en ne gardant que le nœud le plus profond — ses ancêtres
  // contiennent aussi le message de la ligne.
  function replyNodes(el) {
    const known = el.querySelectorAll('.csg-quote');
    if (known.length) return Array.from(known);
    const hit = [];
    el.querySelectorAll(REPLY_SEL).forEach((n) => {
      if (n !== el) hit.push(n);
    });
    if (hit.length) return hit;
    // Fast reject : 90 % des lignes n'ont pas d'en-tête « Répond à ».
    // Sans ça on marchait TOUS les div/span/p de la row à chaque message.
    if (!/(?:^|\s)(?:répond(?:s|re)?\s+à|réponse\s+à|replying\s+to)\s/i.test(el.textContent || '')) return [];
    const cands = [];
    const nodes = el.querySelectorAll('div,span,p');
    const cap = Math.min(nodes.length, 48);
    for (let i = 0; i < cap; i++) {
      const n = nodes[i];
      if (RE_REPLY_HEAD.test(n.textContent || '') && !n.querySelector(AUTHOR_SEL)) cands.push(n);
    }
    const heads = cands.filter((n) => !cands.some((o) => o !== n && n.contains(o)));
    const out = [];
    for (const head of heads) {
      out.push(head);
      // Kick peut séparer l'en-tête, la citation et la réponse en trois spans.
      // Exiger encore un fragment après la citation évite de retirer la réponse
      // quand l'en-tête n'est suivi que du corps du message.
      const quote = head.nextElementSibling;
      if (/^\s*(?:répond(?:s|re)?\s+à|réponse\s+à|replying\s+to)\s+@?[^\s:·•]+\s*[:·•-]?\s*$/i.test(head.textContent || '') &&
          quote && quote.nextElementSibling && !quote.querySelector(AUTHOR_SEL) &&
          !RE_REPLY_HEAD.test(quote.textContent || '')) out.push(quote);
    }
    return out;
  }

  function extractReply(el) {
    // Fast path : 90% des messages ne sont pas des replies.
    const nodes = replyNodes(el);
    if (!nodes.length) return { to: '', quote: '' };
    let raw = '';
    for (const n of nodes) raw += ' ' + (n.textContent || '');
    raw = raw.replace(/\s+/g, ' ').trim();
    if (!raw) return { to: '', quote: '' };
    const m = raw.match(
      /(?:répond(?:s|re)?\s+à|replying\s+to|réponse\s+à)\s+@?([^\s:·•]+)\s*[:·•-]?\s*(.*)$/i
    );
    if (m) return { to: m[1].replace(/^@/, ''), quote: String(m[2] || '').trim().slice(0, 500) };
    return { to: '', quote: raw.slice(0, 500) };
  }

  // Une réponse republie le message d'origine dans son en-tête. Tout ce qu'on
  // vient de couper revient donc par la citation, sur la ligne de quelqu'un
  // d'autre : un auteur muté reste lisible tant qu'on lui répond. On coupe
  // l'aperçu, jamais la ligne — celui qui répond n'a rien fait.
  function replyTainted(el) {
    const to = String(el.dataset.csgReplyTo || '').trim().toLowerCase();
    if (to && !isSelfName(to) && hideMuted() && mutedHere(to)) return true;
    const q = String(el.dataset.csgReplyQuote || '');
    if (!q || !window.CSG_KEYWORDS) return false;
    const extra = window.CSG_KEYWORDS.parseExtra(settings.extraWords);
    if (extra.length && window.CSG_KEYWORDS.hitExtra(q, extra)) return true;
    if (settings.learn !== false && learnedWords.length && window.CSG_KEYWORDS.matchExtra(q, learnedWords)) return true;
    const v = window.CSG_KEYWORDS.analyze(q);
    return !!(v.heavy || v.harsh || v.vitalityHate || v.brainrot);
  }

  function maskReply(el) {
    if (!el || !el.dataset || el.dataset.csgReply === '0') return;
    if (!el.dataset.csgReplyTo && !el.dataset.csgReplyQuote) {
      const r = extractReply(el);
      // 90% des lignes ne sont pas des replies : on le note pour ne pas
      // relancer extractReply à chaque passe rétroactive.
      if (!r.to && !r.quote) {
        el.dataset.csgReply = '0';
        return;
      }
      if (r.to) el.dataset.csgReplyTo = r.to;
      if (r.quote) el.dataset.csgReplyQuote = r.quote;
    }
    // Le CSS ne peut pas connaître le nœud d'aperçu sur Kick : on le marque.
    for (const n of replyNodes(el)) n.classList.add('csg-quote');
    el.classList.toggle('csg-reply-cut', hideMuted() && (settings.hideQuote === true || replyTainted(el)));
  }

  // Le texte jugé ne doit jamais contenir la citation : sinon on juge celui qui
  // répond sur les mots d'un autre. Passe par replyNodes, donc couvre Kick.
  function stripReplyNodes(root) {
    for (const n of replyNodes(root)) if (n !== root) n.remove();
  }

  function msgText(el) {
    const clone = el.cloneNode(true);
    stripReplyNodes(clone);
    clone
      .querySelectorAll(
        AUTHOR_SEL + ', .chat-badge, .badge, .seventv-chat-user, ' +
          // Kick : horodatage, badges d'identité et le « : » séparateur.
          '[data-testid^="identity-badge-"], span[aria-hidden="true"], ' +
          'span[style*="--chatroom-timestamps-display"], ' +
          // Kick : badge de niveau en SVG, dont le <title> « Niveau 38 »
          // devenait le texte des messages 100 % emotes.
          'svg, .csg-chip, .csg-blocked-label, .csg-grok-icon, .csg-grok-btn'
      )
      .forEach((n) => n.remove());
    let t = '';
    clone.querySelectorAll(FRAG_SEL).forEach((f) => {
      t += f.textContent + ' ';
    });
    if (!t.trim()) t = clone.textContent || '';
    const plain = window.CSG_KEYWORDS && window.CSG_KEYWORDS.plainMessage
      ? window.CSG_KEYWORDS.plainMessage(t)
      : t.replace(/\s+/g, ' ').trim();
    return plain.slice(0, 800);
  }

  let totalBuf = 0;
  let totalFlushT = null;
  contentCleanups.push(() => clearTimeout(totalFlushT));

  function bumpTotal() {
    totalBuf += 1;
    if (totalFlushT) return;
    totalFlushT = setTimeout(() => {
      const add = totalBuf;
      totalBuf = 0;
      totalFlushT = null;
      // bumpTotal est appele depuis act(), sur CHAQUE ligne masquee. Non
      // protege, il faisait remonter l'exception jusqu'a act() et cassait le
      // masquage en plein milieu.
      safe(() =>
        chrome.storage.local.get({ csg_blocked_total: 0 }, ({ csg_blocked_total }) => {
          chrome.storage.local.set({ csg_blocked_total: csg_blocked_total + add });
        })
      );
    }, 2000);
  }

  function collectLines(node, out) {
    if (!(node instanceof HTMLElement)) return;
    if (node.id === 'csg-hud' || (node.classList && (node.classList.contains('csg-chip') || node.classList.contains('csg-blocked-label')))) return;
    if (isChatLine(node)) out.push(node);
    else if (node.closest) {
      const line = node.closest(LINE_SEL);
      if (line && isChatLine(line)) out.push(line);
    }
    if (node.querySelectorAll) {
      node.querySelectorAll(LINE_SEL).forEach((el) => {
        if (isChatLine(el)) out.push(el);
      });
    }
  }

  let lastMutAt = 0;
  let observerStartedAt = 0;
  let lastRescanAt = 0;
  let lastRetroAt = 0;
  let whyCache = '';
  let whyCacheAt = 0;
  let whyCacheHref = '';

  function getWhy(force) {
    const now = Date.now();
    let href = '';
    try {
      href = location.href;
    } catch (_) {}
    // Une réponse « pas de chat » ne doit pas survivre à l'ouverture du panneau,
    // ni un « pas un live » à une navigation SPA : flushPending marque alors les
    // lignes vues et elles ne sont plus jamais capturées.
    const chatArrived = /pas de chat/i.test(whyCache) && hasChat();
    if (!force && whyCache && href === whyCacheHref && !chatArrived && now - whyCacheAt < 2500) return whyCache;
    whyCacheHref = href;
    whyCache = captureWhy();
    whyCacheAt = now;
    return whyCache;
  }

  const CHAT_ROOT_SEL = [
    '[data-test-selector="chat-scrollable-area__message-container"]',
    '.chat-scrollable-area__message-container',
    '.seventv-chat-list',
    '[data-testid="chatroom-messages"]',
    '#chatroom-messages',
    '.video-chat__message-list-wrapper',
    '[data-a-target="video-chat"]',
    '.video-chat'
  ].join(',');

  let ambienceStates = {};
  let ambienceRevealedUntil = 0;
  let ambienceBanner = null;
  function paintAmbiencePause() {
    const state = ambienceStates[currentChannel()] || {};
    const remaining = Math.ceil((Number(state.until) - Date.now()) / 1000);
    const hidden = settings.enabled !== false && settings.ambiencePause !== false &&
      remaining > 0 && ambienceRevealedUntil < Number(state.until);
    document.documentElement.classList.toggle('csg-chat-paused', hidden);
    if (!hidden) {
      if (ambienceBanner) ambienceBanner.remove();
      ambienceBanner = null;
      return;
    }
    if (!ambienceBanner) {
      ambienceBanner = document.createElement('div');
      ambienceBanner.id = 'csg-ambience-pause';
      ambienceBanner.setAttribute('role', 'status');
      const label = document.createElement('span');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Réafficher le chat';
      button.addEventListener('click', () => {
        ambienceRevealedUntil = Number((ambienceStates[currentChannel()] || {}).until) || Date.now();
        sendBg({ type: 'CSG_AMBIENCE_REVEAL', channel: currentChannel() });
        paintAmbiencePause();
      });
      ambienceBanner.append(label, button);
      (document.body || document.documentElement).appendChild(ambienceBanner);
    }
    const text = 'RefChat · chat en pause (' + remaining + ' s) · ' +
      Math.round((Number(state.ratio) || 0) * 100) + ' % de messages négatifs ou pénibles';
    if (ambienceBanner.firstChild.textContent !== text) ambienceBanner.firstChild.textContent = text;
  }
  safe(() => chrome.storage.local.get({ csg_ambience_state: {} }, (v) => {
    ambienceStates = v.csg_ambience_state || {};
    paintAmbiencePause();
  }));
  safe(() => listenStorage((changes, area) => {
    if (area === 'local' && changes.csg_ambience_state) {
      ambienceStates = changes.csg_ambience_state.newValue || {};
      paintAmbiencePause();
    }
    if (area === 'sync' && changes.csg_settings) paintAmbiencePause();
  }));
  const ambiencePaintTimer = setInterval(() => {
    if (ctxDead()) {
      clearInterval(ambiencePaintTimer);
      document.documentElement.classList.remove('csg-chat-paused');
      if (ambienceBanner) ambienceBanner.remove();
      return;
    }
    paintAmbiencePause();
  }, 500);
  contentCleanups.push(() => {
    clearInterval(ambiencePaintTimer);
    if (window.__csgVer === CSG_VER) document.documentElement.classList.remove('csg-chat-paused');
    if (ambienceBanner) ambienceBanner.remove();
    ambienceBanner = null;
  });

  function flushMuts() {
    mutFlushT = 0;
    if (ctxDead()) return teardown();
    const nodes = mutBuf;
    mutBuf = [];
    if (!nodes.length) return;
    const collected = [];
    for (let i = 0; i < nodes.length; i++) collectLines(nodes[i], collected);
    const found = Array.from(new Set(collected));
    const now = Date.now();
    if (found.length) lastMutAt = now;
    const liveAt = document.visibilityState === 'visible' && found.length <= 8 &&
      observerStartedAt && now - observerStartedAt >= 10000 ? now : 0;
    const ambienceAt = document.visibilityState === 'visible' && observerStartedAt && now - observerStartedAt >= 10000 ? now : 0;
    for (let i = 0; i < found.length; i++) queueLine(found[i], liveAt, ambienceAt);
  }

  const observer = new MutationObserver((muts) => {
    // Un observer orphelin continue de marquer les lignes comme vues sans
    // pouvoir les envoyer : elles seraient perdues pour le script vivant.
    if (ctxDead()) return teardown();
    if (!observedRoot) return;
    for (let i = 0; i < muts.length; i++) {
      const add = muts[i].addedNodes;
      for (let j = 0; j < add.length; j++) {
        if (add[j].nodeType === 1) mutBuf.push(add[j]);
      }
      if (muts[i].type === 'characterData') {
        const parent = muts[i].target.parentElement;
        if (parent) mutBuf.push(parent);
      }
      // textContent replacements add text nodes, not elements; recycled rows
      // can also lose their old text before their new text arrives.
      const changed = muts[i].target && (muts[i].target.nodeType === 1 ? muts[i].target : muts[i].target.parentElement);
      const line = changed && changed.closest && changed.closest(LINE_SEL);
      if (line) mutBuf.push(line);
    }
    if (!mutFlushT) mutFlushT = setTimeout(flushMuts, 32);
  });

  function chatRoot() {
    return document.querySelector(CHAT_ROOT_SEL) || null;
  }

  function startObserver() {
    if (!hasChat()) {
      if (observedRoot) {
        try {
          observer.disconnect();
        } catch (_) {}
        observedRoot = null;
      }
      return;
    }
    const root = chatRoot() || document.body || document.documentElement;
    if (!root) return;
    if (observedRoot === root) return;
    try {
      observer.disconnect();
    } catch (_) {}
    observedRoot = root;
    observerStartedAt = Date.now();
    try {
      observer.observe(root, { childList: true, characterData: true, subtree: true });
    } catch (_) {}
  }
  startObserver();

  // Migration provisoire supprimé : les lignes restées en « LLM? » d'une
  // version précédente n'ont jamais eu de verdict définitif, on les rend.
  function releaseProvLines() {
    document.querySelectorAll(LINE_SEL).forEach((el) => {
      if (el.dataset && el.dataset.csgReason === 'LLM?') {
        unhideLine(el);
        if (pageBlocked > 0) pageBlocked -= 1;
      }
    });
  }
  releaseProvLines();

  function rescanBacklog() {
    // Pas de forEach(queueLine) : l'index devenait `liveAt`, et l'arriéré
    // passait pour du direct (liveEligible, capturedAt = index).
    document.querySelectorAll(LINE_SEL).forEach((el) => queueLine(el));
  }

  function composerText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return String(el.value || '');
    return String(el.innerText || el.textContent || '');
  }

  function findComposer() {
    const sels = [
      '[data-a-target="chat-input"]',
      '[data-testid="chat-input"] textarea',
      '[data-testid="chat-input"] [contenteditable="true"]',
      'textarea[data-testid="chat-input"]',
      '[data-testid="chat-input"]'
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.getAttribute('contenteditable') === 'true' || el.getAttribute('data-a-target') === 'chat-input') return el;
      const inner = el.querySelector('textarea, input, [contenteditable="true"]');
      if (inner) return inner;
    }
    return null;
  }

  function composerDraft(el) {
    return composerText(el).replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
  }

  function pressEnter(el) {
    try {
      const ev = document.createEvent('Event');
      ev.initEvent('keydown', true, true);
      ev.key = 'Enter';
      ev.code = 'Enter';
      ev.keyCode = 13;
      ev.which = 13;
      el.dispatchEvent(ev);
      return;
    } catch (_) {}
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  }

  function placeComposerText(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return composerDraft(el).indexOf(text.slice(0, 16)) !== -1;
    }
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch (_) {}
    if (composerDraft(el).indexOf(text.slice(0, 12)) !== -1) return true;
    try {
      document.execCommand('insertText', false, text);
    } catch (_) {}
    return composerDraft(el).indexOf(text.slice(0, 12)) !== -1;
  }

  function clickChatSend() {
    const btn =
      document.querySelector('[data-a-target="chat-send-button"]') ||
      document.querySelector('[data-testid="send-message-button"]') ||
      document.querySelector('[data-testid="chat-send-button"]');
    if (btn && !btn.disabled) {
      btn.click();
      return true;
    }
    return false;
  }

  // --- Grok répond à ce message ------------------------------------------------
  // Bouton « G » posé à côté de la flèche Répondre de Twitch. Le clic demande au
  // fond une réplique écrite à ta façon, qui repart en réponse Twitch native.

  function lineById(id) {
    if (!id) return null;
    try {
      return document.querySelector('[data-csg-id="' + CSS.escape(String(id)) + '"]');
    } catch (_) {
      return null;
    }
  }

  function replyBtnOf(el) {
    const b = el && el.querySelector('.chat-line__reply-icon button');
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return null;
    return b;
  }

  // Le bloc du champ de chat (bandeau « Réponse à @x » compris), sans remonter
  // jusqu'à la liste des messages.
  function composerZoneText() {
    let box = findComposer();
    let best = '';
    for (let i = 0; box && i < 16; i++, box = box.parentElement) {
      const t = box.innerText || '';
      if (t.length > 600) break;
      best = t;
    }
    return best.toLowerCase();
  }

  function replyTrayFor(author) {
    const t = composerZoneText();
    return /r[ée]pon|reply/.test(t) && t.indexOf(String(author || '').toLowerCase()) !== -1;
  }

  // Clique la flèche Répondre de la ligne. true = Twitch affiche le bandeau de
  // réponse, la réplique partira sans @ ; false = on préfixera @pseudo.
  function openNativeReply(id, author) {
    const el = lineById(id);
    const btn = replyBtnOf(el);
    if (!btn || !author) return Promise.resolve(false);
    if (replyTrayFor(author)) return Promise.resolve(true);
    try {
      btn.click();
    } catch (_) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => setTimeout(() => resolve(replyTrayFor(author)), 350));
  }

  function noteMine(el) {
    if (!el || !el.dataset || el.dataset.csgMine) return;
    el.dataset.csgMine = '1';
    const text = msgText(el);
    if (!text) return;
    // À qui tu répondais (en-tête de réponse Twitch) : Grok relit ce fil-là.
    const to = el.dataset.csgReplyTo || extractReply(el).to || '';
    sendBg({ type: 'CSG_MY_LINE', text, to, channel: lastChannel || currentChannel() });
  }

  // Un brouillon reste en dehors du composeur Twitch jusqu'au clic « Placer ».
  let replyAssistEnabled = false;
  let replyDraftPanel = null;
  let replyAutoTargets = {};
  let autoControlChannel = '';
  safe(() => chrome.storage.local.get({ csg_reply_assist: null, csg_hand: {} }, (v) => {
    replyAssistEnabled = !!(v.csg_reply_assist && v.csg_reply_assist.enabled);
    replyAutoTargets = v.csg_hand || {};
    paintAutoReplyControl();
  }));
  safe(() => listenStorage((changes, area) => {
    if (area !== 'local' || (!changes.csg_hand && !changes.csg_reply_assist)) return;
    if (changes.csg_hand) replyAutoTargets = changes.csg_hand.newValue || {};
    if (changes.csg_reply_assist) {
      replyAssistEnabled = !!(changes.csg_reply_assist.newValue && changes.csg_reply_assist.newValue.enabled);
      if (!replyAssistEnabled) closeReplyDraft();
    }
    paintAutoReplyControl();
  }));
  contentCleanups.push(() => { closeReplyDraft(); const control = document.getElementById('csg-auto-reply-control'); if (control) control.remove(); });

  function paintAutoReplyControl() {
    const old = document.getElementById('csg-auto-reply-control');
    if (old) old.remove();
    const channel = currentChannel();
    autoControlChannel = channel;
    const targets = Object.entries(replyAutoTargets).filter(([,t]) => t && (!t.channel || t.channel === channel));
    if (!targets.length || replyAssistEnabled) return;
    const panel = document.createElement('aside');
    panel.id = 'csg-auto-reply-control';
    panel.setAttribute('aria-label', 'Réponse automatique Grok');
    for (const [key, target] of targets) {
      const row = document.createElement('div');
      const text = document.createElement('span');
      text.textContent = 'Grok auto · @' + String(target.name || key);
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.textContent = 'Arrêter';
      stop.addEventListener('click', () => {
        // Annulation locale immédiate, même si le worker attend encore son tour.
        delete replyAutoTargets[key];
        paintAutoReplyControl();
        const failed = () => {
          text.textContent = 'Arrêt non confirmé : ouvre RefChat puis Tout arrêter.';
          panel.appendChild(row); document.body.appendChild(panel);
        };
        sendBg({ type: 'CSG_HAND_STOP', key }, { expectReply: true, onReply: (res) => {
          if (!res || !res.ok) failed();
        }, onDrop: failed });
      });
      row.append(text, stop);
      panel.appendChild(row);
    }
    document.body.appendChild(panel);
  }

  function autoReplyAllowed(opts) {
    if (!opts.targetKey) return true;
    const target = replyAutoTargets[opts.targetKey];
    return !!(target && Number(target.at) === Number(opts.targetAt) &&
      (!target.channel || target.channel === currentChannel()));
  }

  function closeReplyDraft() {
    if (replyDraftPanel) replyDraftPanel.remove();
    replyDraftPanel = null;
  }

  function replyDraftReady(requestedChannel) {
    const channel = currentChannel();
    if (!replyAssistEnabled || !channel || channel !== String(requestedChannel || '').toLowerCase()) {
      return { ok: false, err: 'brouillons désactivés ou autre salon' };
    }
    if (document.visibilityState !== 'visible') return { ok: false, err: 'onglet masqué' };
    if (replyDraftPanel && replyDraftPanel.isConnected) return { ok: false, err: 'un brouillon est déjà ouvert' };
    return { ok: true };
  }

  function showReplyDraft(msg) {
    const ready = replyDraftReady(msg.channel);
    if (!ready.ok) return ready;
    const channel = currentChannel();
    closeReplyDraft();
    const panel = document.createElement('section');
    panel.id = 'csg-reply-draft';
    panel.setAttribute('aria-label', 'Brouillon RefChat');
    const title = document.createElement('b');
    title.textContent = 'Brouillon pour @' + String(msg.author || '').slice(0, 40);
    const note = document.createElement('p');
    note.textContent = msg.political
      ? 'Sujet politique : écris ton avis, puis reformule-le sans ajouter d’arguments.'
      : 'Relis et ajuste le texte. L’envoi reste entre tes mains.';
    const input = document.createElement('textarea');
    input.setAttribute('aria-label', 'Mon texte à relire ou reformuler');
    input.maxLength = 500;
    input.rows = 4;
    input.value = msg.political ? '' : String(msg.text || '').slice(0, 500);
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const actions = document.createElement('div');
    const rephrase = document.createElement('button');
    rephrase.type = 'button';
    rephrase.textContent = 'Reformuler mon texte';
    rephrase.addEventListener('click', () => {
      const original = input.value.trim();
      if (!original) { status.textContent = 'Écris d’abord ton propre texte.'; return; }
      rephrase.disabled = true;
      status.textContent = 'Reformulation…';
      const done = () => { rephrase.disabled = false; };
      const sent = sendBg({ type: 'CSG_REPHRASE_DRAFT', text: original }, {
        expectReply: true, noRetry: true,
        onReply: (res) => {
          done();
          if (replyDraftPanel !== panel || channel !== currentChannel()) return;
          if (input.value.trim() !== original) { status.textContent = 'Ton texte a changé : il a été conservé.'; return; }
          if (res && res.ok && res.line) {
            input.value = res.line;
            status.textContent = 'Texte reformulé. Relis-le avant de le placer dans le chat.';
          } else status.textContent = (res && res.err) || 'Reformulation indisponible.';
        },
        onDrop: () => { done(); status.textContent = 'Extension injoignable : recharge la page.'; }
      });
      if (!sent) { done(); status.textContent = 'Extension injoignable : recharge la page.'; }
    });
    const place = document.createElement('button');
    place.type = 'button';
    place.textContent = 'Placer dans le chat';
    place.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) { status.textContent = 'Le brouillon est vide.'; return; }
      if (document.visibilityState !== 'visible' || currentChannel() !== channel || Date.now() - openedAt > 5 * 60 * 1000) {
        status.textContent = 'Brouillon ancien ou autre salon : ferme-le puis redemande une proposition.'; return;
      }
      const composer = findComposer();
      if (!composer || composerDraft(composer)) { status.textContent = 'Le champ du chat est absent ou contient déjà ton texte.'; return; }
      place.disabled = true;
      try {
        const native = await openNativeReply(msg.replyToId, msg.author);
        if (replyDraftPanel !== panel || currentChannel() !== channel || document.visibilityState !== 'visible' || ctxDead()) return;
        const target = findComposer();
        if (!target || composerDraft(target)) { status.textContent = 'Ton texte déjà saisi a été conservé.'; return; }
        const line = native ? text : '@' + String(msg.author || '').replace(/^@/, '') + ' ' + text;
        if (placeComposerText(target, line)) closeReplyDraft();
        else status.textContent = 'Le champ a refusé le texte. Tu peux le copier depuis le brouillon.';
      } finally { place.disabled = false; }
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Fermer';
    close.addEventListener('click', closeReplyDraft);
    actions.append(rephrase, place, close);
    panel.append(title, note, input, status, actions);
    const openedAt = Date.now();
    replyDraftPanel = panel;
    document.body.appendChild(panel);
    return { ok: true };
  }

  const GROK_TIP = 'Grok répond à ce message, à ta façon';

  function grokState(btn, state, tip) {
    if (!btn) return;
    btn.dataset.state = state;
    btn.title = tip || GROK_TIP;
    btn.setAttribute('aria-label', btn.title);
    if (state === 'sent' || state === 'err') {
      clearTimeout(btn._csgT);
      btn._csgT = setTimeout(() => {
        if (btn.dataset.state === state) grokState(btn, '', GROK_TIP);
      }, state === 'sent' ? 8000 : 12000);
    }
  }

  function onGrokClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const btn = ev.currentTarget;
    if (btn.dataset.state === 'think') return;
    const el = btn.closest(LINE_SEL);
    const author = el && (el.dataset.csgName || chatName(el));
    const text = el && msgText(el);
    if (!author || !text) {
      grokState(btn, 'err', 'Message illisible');
      return;
    }
    if (!el.dataset.csgId) el.dataset.csgId = nextId();
    grokState(btn, 'think', 'Grok réfléchit…');
    const ok = sendBg(
      {
        type: replyAssistEnabled ? 'CSG_REPLY_DRAFT_REQUEST' : 'CSG_GROK_REPLY',
        id: el.dataset.csgId,
        author,
        text,
        channel: currentChannel(),
        streamContext: currentStreamContext(),
        replyTo: el.dataset.csgReplyTo || '',
        replyQuote: el.dataset.csgReplyQuote || ''
      },
      {
        expectReply: true,
        noRetry: true,
        onReply: (res) => {
          if (res && res.ok) grokState(btn, 'sent', res.draft ? 'Brouillon à relire' : 'Envoyé : ' + res.line);
          else grokState(btn, 'err', 'Pas envoyé : ' + ((res && res.err) || 'pas de réponse'));
        },
        onDrop: () => grokState(btn, 'err', 'Extension injoignable : recharge la page')
      }
    );
    if (!ok) grokState(btn, 'err', 'Extension rechargée : recharge la page');
  }

  // Twitch seulement : la réponse native y existe, et Kick recycle ses lignes.
  function addGrokBtn(el) {
    if (siteTag() !== 'twitch' || !el || el.querySelector('.csg-grok-btn')) return;
    if (isOwnMessage(el)) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'csg-grok-btn';
    grokState(btn, '', GROK_TIP);
    btn.addEventListener('click', onGrokClick);
    const icons = el.querySelector('.chat-line__icons');
    if (icons) {
      const wrap = document.createElement('div');
      wrap.className = 'chat-line__icon csg-grok-icon';
      wrap.appendChild(btn);
      icons.appendChild(wrap);
    } else {
      btn.classList.add('csg-grok-float');
      el.appendChild(btn);
    }
  }

  function sendBaitLine(text, opts) {
    const base = String(text || '').trim();
    if (!base) return Promise.resolve({ ok: false, err: 'vide' });
    const o = opts || {};
    const author = String(o.author || '').replace(/^@/, '');
    let line = base;
    let replied = !author;
    const deadline = Date.now() + 12000;
    const step = () => {
      if (replyAssistEnabled || ctxDead() || !autoReplyAllowed(o)) return Promise.resolve({ ok: false, err: 'envoi annulé' });
      const el = findComposer();
      if (!el) return Promise.resolve({ ok: false, err: 'pas de champ de chat' });
      if (composerDraft(el)) {
        if (Date.now() >= deadline) return Promise.resolve({ ok: false, err: 'tu ecrivais' });
        return new Promise((resolve) => setTimeout(() => resolve(step()), 400));
      }
      if (!replied) {
        replied = true;
        return openNativeReply(o.replyToId, author).then((native) => {
          line = native ? base : '@' + author + ' ' + base;
          return step();
        });
      }
      if (!placeComposerText(el, line)) return Promise.resolve({ ok: false, err: 'champ refuse le texte' });
      const clicked = clickChatSend();
      if (!clicked) pressEnter(el);
      const stillThere = () => composerDraft(el).indexOf(line.slice(0, 12)) !== -1;
      return new Promise((resolve) => {
        setTimeout(() => {
          if (replyAssistEnabled || ctxDead() || !autoReplyAllowed(o)) { resolve({ ok: false, err: 'envoi arrêté' }); return; }
          if (!stillThere()) {
            resolve({ ok: true });
            return;
          }
          if (clicked) pressEnter(el);
          else clickChatSend();
          setTimeout(() => {
            if (!stillThere()) resolve({ ok: true });
            else resolve({ ok: false, err: 'reste dans le champ' });
          }, 700);
        }, 900);
      });
    };
    return step();
  }

  const onContentMessage = (msg, sender, sendResponse) => {
    if (ctxDead()) { teardown(); return false; }
    if (msg && msg.type === 'CSG_REPLY_DRAFT_READY') {
      sendResponse(replyDraftReady(msg.channel));
      return false;
    }
    if (msg && msg.type === 'CSG_REPLY_DRAFT') {
      sendResponse(showReplyDraft(msg));
      return false;
    }
    if (msg && msg.type === 'CSG_BAIT_SEND') {
      const channel = String(msg.channel || '');
      const here = currentChannel() || '';
      if (channel && here && here.toLowerCase() !== channel.toLowerCase()) {
        sendResponse({ ok: false, err: 'autre salon' });
        return true;
      }
      sendBaitLine(msg.text, { replyToId: msg.replyToId, author: msg.author, targetKey: msg.targetKey, targetAt: msg.targetAt }).then(
        (res) => {
          if (res && res.ok) {
            const btn = document.querySelector('.csg-grok-btn[data-state="think"]');
            if (btn) grokState(btn, 'sent', 'Envoyé : ' + msg.text);
          }
          sendResponse(res);
        },
        (e) => sendResponse({ ok: false, err: String((e && e.message) || e).slice(0, 80) })
      );
      return true;
    }
    if (msg && msg.type === 'CSG_PAGE_STATS') {
      // Le popup interroge TOUS les frames de l'onglet et garde la première
      // réponse. Kick empile des iframes about:blank où le script est injecté
      // aussi : elles répondaient « pas de chat dans cette frame » avant le chat.
      const chat = isChatFrame();
      if (!chat && window !== window.top) return false;
      const reply = () =>
        sendResponse({
          pageBlocked,
          modelReady,
          captured: capturedCount,
          channel: currentChannel(),
          why: captureWhy(),
          last: lastSeen
        });
      // Sans chat, le frame du haut ne répond qu'en dernier recours.
      if (chat) reply();
      else setTimeout(reply, 300);
      return true;
    }
    if (msg && msg.type === 'CSG_MUTE_SYNC') {
      applyMuteSync(msg.muted);
      sendResponse({ ok: true });
      return true;
    }
    if (msg && msg.type === 'CSG_LIVE_MUTE_SYNC') {
      applyLiveMuteSync(msg.muted);
      sendResponse({ ok: true });
      return true;
    }
    if (msg && msg.type === 'CSG_LLM_HIDE') {
      hideByLlm(msg);
      sendResponse({ ok: true });
      return true;
    }
    if (msg && msg.type === 'CSG_LLM_UNHIDE') {
      unhideByLlm(msg);
      sendResponse({ ok: true });
      return true;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(onContentMessage);
  contentCleanups.push(() => chrome.runtime.onMessage.removeListener(onContentMessage));

  // Vrai si la ligne correspond au message visé par le background (par id, sinon
  // par auteur + texte exact).
  function matchesLlmMsg(el, msg, author, needle) {
    if (msg.id && el.dataset.csgId === msg.id) return true;
    if (!author || el.dataset.csgName !== author) return false;
    const t = msgText(el).toLowerCase();
    return !!(t && needle && t === needle);
  }

  function hideByLlm(msg) {
    if (captureWhy() !== 'ok') return;
    // Provisoire supprimé : le fond ne doit plus envoyer de masquage fast en
    // attente de confirmation deep. On ignore les vieux messages prov qui
    // traîneraient encore (reload, worker pas à jour) : seul le définitif masque.
    if (msg && msg.prov) return;
    const author = String(msg.author || '').toLowerCase();
    if (isSelfName(author) || isWhitelisted(author)) return;
    const needle = String(msg.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const reason = 'LLM';
    document.querySelectorAll(LINE_SEL).forEach((el) => {
      if (!isChatLine(el)) return;
      if (isOwnMessage(el) || isSelfName(el.dataset.csgName || author) || isWhitelisted(el.dataset.csgName || author)) return;
      if (!matchesLlmMsg(el, msg, author, needle)) return;
      if (el.dataset.csgBlocked === '1') {
        // Déjà masqué en provisoire et le modèle lent confirme : on promeut la
        // raison en définitif et on mute l'auteur, ce que act() ne fera plus.
        if (!msg.prov && el.dataset.csgReason === 'LLM?') {
          el.dataset.csgReason = 'LLM';
          el.title = 'Masqué par Refchat — LLM';
          applyStyle(el);
          muteAuthor(el.dataset.csgName || author, Number(msg.score) || 0.9, 'LLM');
        }
        return;
      }
      act(el, Number(msg.score) || 0.9, reason);
    });
  }

  // Le modèle lent innocente une ligne que le rapide avait masquée. On ne touche
  // qu'aux masquages provisoires : jamais un blocage mot-clé ni un auteur muté.
  function unhideByLlm(msg) {
    const author = String(msg.author || '').toLowerCase();
    const needle = String(msg.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    document.querySelectorAll(LINE_SEL).forEach((el) => {
      if (!isChatLine(el) || el.dataset.csgReason !== 'LLM?') return;
      if (!matchesLlmMsg(el, msg, author, needle)) return;
      unhideLine(el);
      if (pageBlocked > 0) pageBlocked -= 1;
    });
  }

  safe(() =>
    chrome.storage.local.get({ csg_audit: null, csg_model_status: null }, (v) => {
      lastAudit = v.csg_audit;
      bertStatus = v.csg_model_status || {};
      modelReady = bertStatus.status === 'ready';
      paintHud();
    })
  );

  function hideHud() {
    if (hudEl && hudEl.remove) hudEl.remove();
    hudEl = null;
  }

  function placeHud(el) {
    const box =
      document.querySelector('[data-test-selector="chat-room-component-layout"]') ||
      document.querySelector('.chat-shell') ||
      document.querySelector('.stream-chat');
    if (!box) {
      el.style.top = '72px';
      el.style.right = '16px';
      return;
    }
    const r = box.getBoundingClientRect();
    el.style.top = Math.max(8, Math.round(r.top + 8)) + 'px';
    el.style.right = Math.max(8, Math.round(window.innerWidth - r.right + 8)) + 'px';
    el.style.width = Math.min(240, Math.max(180, Math.round(r.width - 16))) + 'px';
  }

  function ensureHud() {
    if (!settings.showHud) {
      hideHud();
      return null;
    }
    if (!isChatFrame()) return null;
    hudEl = document.getElementById('csg-hud');
    if (hudEl && !hudEl.querySelector('.csg-hud-x')) {
      hudEl.remove();
      hudEl = null;
    }
    if (hudEl && hudEl.isConnected) {
      if (hudEl.parentElement !== document.documentElement && hudEl.parentElement !== document.body) {
        (document.documentElement || document.body).appendChild(hudEl);
      }
      return hudEl;
    }
    hudEl = document.createElement('div');
    hudEl.id = 'csg-hud';

    const bar = document.createElement('div');
    bar.className = 'csg-hud-bar';
    const dot = document.createElement('span');
    dot.className = 'csg-hud-dot';
    dot.dataset.role = 'dot';
    const sum = document.createElement('span');
    sum.className = 'csg-hud-sum';
    sum.dataset.role = 'sum';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'csg-hud-x';
    close.title = 'Masquer ce résumé';
    close.textContent = '✕';
    close.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    close.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      settings.showHud = false;
      try {
        chrome.storage.sync.set({ csg_settings: settings });
      } catch (_) {}
      hideHud();
    });
    bar.appendChild(dot);
    bar.appendChild(sum);
    bar.appendChild(close);

    const body = document.createElement('div');
    body.className = 'csg-hud-body';
    body.dataset.role = 'body';

    hudEl.appendChild(bar);
    hudEl.appendChild(body);
    (document.documentElement || document.body).appendChild(hudEl);
    return hudEl;
  }

  function paintHud() {
    if (!settings.showHud) {
      hideHud();
      return;
    }
    if (!isChatFrame()) return;
    const el = ensureHud();
    if (!el) return;
    placeHud(el);

    const a = lastAudit || {};
    const why = lastWhy || getWhy();
    const ch = lastChannel || currentChannel();
    const state = why === 'ok' ? a.state || 'offline' : 'paused';
    el.className = state;

    const capTxt =
      why === 'ok'
        ? 'Chat de ' + (ch || '?') + ' · ' + capturedCount + ' msgs'
        : 'Chat NON capté · ' + why;

    let llmTxt = a.label || 'en attente';
    if (a.current && a.current.author) {
      const sec = Math.max(0, Math.round((Date.now() - (a.current.startedAt || Date.now())) / 1000));
      llmTxt = 'réfléchit · ' + a.current.author + ' (' + sec + 's)';
      if (a.queue) llmTxt += ' · file ' + a.queue;
    } else if (a.state === 'offline' || state === 'offline') {
      llmTxt = a.lastError || 'hors ligne';
    }

    const sum = el.querySelector('[data-role="sum"]');
    const dot = el.querySelector('[data-role="dot"]');
    const body = el.querySelector('[data-role="body"]');
    if (sum) sum.textContent = (why === 'ok' ? 'LLM · ' : '') + capTxt;
    if (dot) {
      dot.className =
        'csg-hud-dot' +
        (a.state === 'running' || a.state === 'queued' ? ' pulse' : why === 'ok' ? ' on' : '');
    }
    if (body) {
      body.textContent =
        llmTxt +
        (lastSeen ? '\n' + lastSeen.author + ' : ' + lastSeen.text.slice(0, 60) : '') +
        (pageBlocked ? '\n' + pageBlocked + ' masqués' : '');
    }
  }

  const NOT_LOGIN = {
    directory: 1,
    videos: 1,
    settings: 1,
    subscriptions: 1,
    search: 1,
    downloads: 1,
    clips: 1,
    browse: 1,
    category: 1,
    categories: 1,
    following: 1,
    inventory: 1,
    drops: 1,
    wallet: 1,
    friends: 1,
    messages: 1,
    whispers: 1,
    moderator: 1,
    dashboard: 1,
    popout: 1,
    badges: 1
  };

  function loginFromHref(href) {
    const raw = String(href || '');
    let path = raw;
    try {
      if (/^https?:/i.test(raw)) path = new URL(raw).pathname;
    } catch (_) {}
    const m = /^(?:\/popout)?\/([A-Za-z0-9_]{2,25})\/?$/.exec(path);
    if (!m || NOT_LOGIN[m[1].toLowerCase()]) return '';
    return nick(m[1]);
  }

  function cardLabel(s) {
    return /^(badges?|tout voir(?:\s*\(\d+\))?|see all(?:\s*\(\d+\))?|suivre|follow|following|chuchoter|whisper|offrir un sub|gift a sub|subscribe|s'abonner)$/i.test(s);
  }

  function cardNames(card) {
    const names = [];
    const push = (s) => {
      const k = nick(s);
      if (!k || k.length < 2 || k.length > 30 || NOT_LOGIN[k] || cardLabel(k) || names.indexOf(k) !== -1) return;
      names.push(k);
    };
    card.querySelectorAll('a[href]').forEach((a) => push(loginFromHref(a.getAttribute('href'))));
    card.querySelectorAll(
      '[data-a-target="viewer-card-display-name"], [data-a-target="viewer-card-username"], [data-test-selector="viewer-card-display-name"]'
    ).forEach((el) => push(el.textContent));
    if (!names.length) {
      card.querySelectorAll('h1, h2, h3, h4, h5, p, a, button, span').forEach((head) => {
        if (names.length) return;
        if (head.classList && (head.classList.contains('csg-wl-btn') || head.classList.contains('csg-mute-btn'))) return;
        if (head.querySelector && head.querySelector('h1, h2, h3, h4, h5, p, button, span')) return;
        push(head.textContent);
      });
    }
    return names.slice(0, 4);
  }

  function climbCard(btn) {
    let n = btn.parentElement;
    for (let i = 0; i < 12 && n && n !== document.body && n !== document.documentElement; i++) {
      if (n.querySelectorAll('button').length > 14) break;
      const blob = (n.innerText || '').slice(0, 700);
      if (/chuchoter|whisper/i.test(blob) && /suivre|follow|badges|offrir un sub|gift a sub/i.test(blob)) return n;
      n = n.parentElement;
    }
    return null;
  }

  function findViewerCards(doc) {
    let whisper = doc.querySelector('[data-a-target="viewer-card-whisper-button"]');
    if (!whisper) {
      const buttons = doc.querySelectorAll('button');
      for (const b of buttons) {
        if (b.classList.contains('csg-wl-btn') || b.classList.contains('csg-mute-btn')) continue;
        const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
        if (/^(chuchoter|whisper)$/i.test(t)) {
          whisper = b;
          break;
        }
      }
    }
    if (whisper) {
      const card = climbCard(whisper) || whisper.closest('[data-a-target="viewer-card"], [data-test-selector="viewer-card"]');
      if (card && cardNames(card).length) return [card];
    }
    const marked = Array.from(doc.querySelectorAll('[data-a-target="viewer-card"], [data-test-selector="viewer-card"]'));
    return marked.filter((el) => cardNames(el).length && !marked.some((o) => o !== el && o.contains(el)));
  }

  function placeWl(card, slot) {
    let whisper = card.querySelector('[data-a-target="viewer-card-whisper-button"]');
    if (!whisper) {
      const buttons = card.querySelectorAll('button');
      for (const b of buttons) {
        if (b.classList.contains('csg-wl-btn') || b.classList.contains('csg-mute-btn')) continue;
        const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
        if (/^(chuchoter|whisper)$/i.test(t)) {
          whisper = b;
          break;
        }
      }
    }
    const parent = whisper && whisper.parentElement;
    if (parent) {
      if (slot.parentElement !== parent || slot.previousElementSibling !== whisper) parent.insertBefore(slot, whisper.nextSibling);
      return;
    }
    if (slot.parentElement !== card) card.appendChild(slot);
  }

  function onWlClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const names = String((e.currentTarget.dataset && e.currentTarget.dataset.csgWl) || '').split('|').filter(Boolean);
    if (!names.length) return;
    toggleWhitelist(names, !names.some(isWhitelisted));
  }

  function stopCardEvent(e) {
    e.stopPropagation();
  }

  function onMuteClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const names = String((e.currentTarget.dataset && e.currentTarget.dataset.csgMute) || '').split('|').filter(Boolean);
    if (!names.length || names.some(isWhitelisted) || names.every(isSelfName)) return;
    const keys = [];
    for (const n of names) {
      const k = nick(n);
      if (!k || isSelfName(k) || keys.indexOf(k) !== -1) continue;
      keys.push(k);
    }
    if (!keys.length) return;
    if (keys.some((k) => mutedHere(k))) {
      const prev = mutedUsers;
      const next = Object.assign({}, mutedUsers);
      for (const k of keys) {
        delete next[k];
        releasedMutes.add(k);
      }
      mutedUsers = next;
      retroHideMuted();
      paintViewerCards();
      let pending = keys.length;
      let failed = false;
      const done = (res) => {
        if (!res || !res.ok) failed = true;
        pending -= 1;
        if (pending) return;
        if (!failed) return;
        mutedUsers = prev;
        for (const k of keys) releasedMutes.delete(k);
        retroHideMuted();
        paintViewerCards();
      };
      for (const k of keys) {
        const sent = sendBg(
          { type: 'CSG_MUTE_REMOVE', key: k, site: siteTag() },
          { expectReply: true, onReply: done, onDrop: () => done(null) }
        );
        if (!sent) done(null);
      }
      return;
    }
    for (const k of keys) muteAuthor(k, 1, 'main', true);
    retroHideMuted();
    paintViewerCards();
  }

  function handedHere(name) {
    const k = nick(name);
    return !!(k && handTargets[k]);
  }

  function onHandClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.currentTarget;
    const name = String((btn.dataset && btn.dataset.csgHand) || '').split('|').filter(Boolean)[0];
    if (!name || isSelfName(name)) return;
    const k = nick(name);
    const on = !handedHere(name);
    const prev = handTargets;
    const next = Object.assign({}, handTargets);
    if (on) next[k] = { name, at: Date.now() };
    else delete next[k];
    handTargets = next;
    paintViewerCards();
    const revert = (err) => {
      handTargets = prev;
      paintViewerCards();
      if (err) btn.title = err;
    };
    sendBg(
      { type: 'CSG_HAND_SET', name, on, channel: lastChannel || currentChannel() },
      { expectReply: true, onReply: (res) => { if (!res || !res.ok) revert(res && res.err); }, onDrop: () => revert('recharge la page') }
    );
  }

  function onBoardClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const author = String((e.currentTarget.dataset && e.currentTarget.dataset.csgAuthor) || '').split('|').filter(Boolean)[0];
    if (!author) return;
    sendBg({ type: 'CSG_OPEN_BOARD', tab: 'author', author });
  }

  function bindCardBtn(slot, sel, cls, onClick) {
    let btn = slot.querySelector(sel);
    if (btn && btn.dataset.csgBound === String(CSG_VER)) return btn;
    const fresh = document.createElement('button');
    fresh.type = 'button';
    fresh.className = cls;
    fresh.dataset.csgBound = String(CSG_VER);
    fresh.addEventListener('pointerdown', stopCardEvent);
    fresh.addEventListener('mousedown', stopCardEvent);
    fresh.addEventListener('click', onClick);
    if (btn) btn.replaceWith(fresh);
    else slot.appendChild(fresh);
    return fresh;
  }

  // Setting the same text still replaces its DOM node and wakes observers.
  function setCardText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function paintViewerCards() {
    if (ctxDead() || !document.querySelector) return;
    const cards = findViewerCards(document);
    for (const card of cards) {
      const names = cardNames(card);
      if (!names.length) continue;
      let slot = card.querySelector('.csg-wl-slot');
      if (!slot) {
        slot = document.createElement('div');
        slot.className = 'csg-wl-slot';
      }
      const btn = bindCardBtn(slot, '.csg-wl-btn:not(.csg-mute-btn):not(.csg-hand-btn):not(.csg-board-btn)', 'csg-wl-btn', onWlClick);
      const muteBtn = bindCardBtn(slot, '.csg-mute-btn', 'csg-wl-btn csg-mute-btn', onMuteClick);
      const handBtn = bindCardBtn(slot, '.csg-hand-btn', 'csg-wl-btn csg-hand-btn', onHandClick);
      const boardBtn = bindCardBtn(slot, '.csg-board-btn', 'csg-wl-btn csg-board-btn', onBoardClick);
      placeWl(card, slot);
      const on = names.some(isWhitelisted);
      btn.dataset.csgWl = names.join('|');
      btn.classList.toggle('on', on);
      setCardText(btn, on ? 'Whitelisté' : 'Whitelist');
      btn.title = on ? 'Retirer cet auteur de la whitelist Refchat' : 'Refchat ignorera cet auteur';
      const muteable = names.filter((n) => !isSelfName(n));
      const muted = muteable.some((n) => mutedHere(n));
      muteBtn.hidden = !muteable.length;
      muteBtn.disabled = on;
      muteBtn.dataset.csgMute = muteable.join('|');
      muteBtn.classList.toggle('on', muted && !on);
      setCardText(muteBtn, muted ? 'Muté' : 'Muter');
      muteBtn.title = on
        ? 'Whitelisté — retire la whitelist pour muter'
        : muted
          ? 'Retirer le mute Refchat sur ce site'
          : 'Muter cet auteur sur ce site';
      const handed = muteable.some(handedHere);
      handBtn.hidden = !muteable.length;
      handBtn.dataset.csgHand = muteable.join('|');
      handBtn.classList.toggle('on', handed);
      setCardText(handBtn, handed ? 'Grok répond' : 'Grok lui répond');
      handBtn.title = handed
        ? 'Reprendre la main : Grok arrête de lui répondre'
        : 'Grok lit ce qu il te dit et répond à ta place, à chaque fois';
      boardBtn.dataset.csgAuthor = names[0] || '';
      const reports = typeof activeReports !== 'undefined' && activeReports ? activeReports : {};
      const notes = typeof authorNotes !== 'undefined' && authorNotes ? authorNotes : {};
      const authorKey = String(names[0] || '').replace(/^@+/, '').trim().toLowerCase();
      const reported = Object.keys(reports).some((id) => {
        const r = reports[id];
        const who = String((r && r.author) || '').replace(/^@+/, '').trim().toLowerCase();
        return !!(r && !r.done && who && who === authorKey);
      });
      const note = notes[authorKey] || notes[names[0]] || null;
      boardBtn.classList.remove('warn');
      boardBtn.classList.remove('noted');
      if (reported) {
        setCardText(boardBtn, 'Dossier ⚠');
        boardBtn.classList.add('warn');
        boardBtn.title = 'Signalement actif — ouvrir le dossier';
      } else if (note && note.text) {
        setCardText(boardBtn, 'Dossier 📝');
        boardBtn.classList.add('noted');
        boardBtn.title = String(note.text);
      } else {
        setCardText(boardBtn, 'Dossier');
        boardBtn.title = 'Ouvrir le dossier de cet auteur dans le tableau';
      }
    }
  }

  function ensureCardObserver() {
    if (window.__csgCardObserver || ctxDead()) return;
    const root = document.documentElement;
    if (!root) return;
    const obs = new MutationObserver((muts) => {
      if (ctxDead()) return teardown();
      // RefChat's own button labels cannot signal a new Twitch viewer card.
      // Otherwise painting a card schedules another paint every 60 ms forever.
      if (!muts.some((mut) => {
        const target = mut.target && (mut.target.nodeType === 1 ? mut.target : mut.target.parentElement);
        return !target || !target.closest || !target.closest('.csg-wl-slot');
      })) return;
      if (obs._t) return;
      obs._t = setTimeout(() => {
        obs._t = 0;
        paintViewerCards();
      }, 60);
    });
    try {
      obs.observe(root, { childList: true, subtree: true });
    } catch (_) {
      return;
    }
    window.__csgCardObserver = obs;
  }

  window.__csgObserver = observer;

  window.__csgTick = setInterval(() => {
    // Le zombie s'arrete ici : plus de tick, plus d'observer, plus d'erreurs.
    if (ctxDead()) return teardown();
    startObserver();
    lastWhy = getWhy();
    lastChannel = currentChannel();
    if (autoControlChannel !== lastChannel) paintAutoReplyControl();
    if (!isChatFrame()) return;
    const now = Date.now();
    // Rescan du backlog toutes les ~4-5s max (avant : à chaque tick de 1.5s dès
    // qu'une mutation avait eu lieu). Les nouveaux messages sont déjà captés en
    // temps réel par le MutationObserver ; le rescan ne sert qu'aux retardataires.
    if (lastMutAt > lastRescanAt && now - lastRescanAt > 4000) {
      rescanBacklog();
      lastRescanAt = now;
    }
    if (now - lastRetroAt > 5000) {
      lastRetroAt = now;
      unhideSelfLines();
      unhideWhitelisted();
      harvestBlurred();
    }
    ensureCardObserver();
    paintViewerCards();
    paintHud();
    // Le keepalive ne partait que si l'onglet était visible : en arrière-plan
    // le service worker MV3 s'endormait au bout de ~30s et plus rien n'était
    // jugé. On l'envoie toujours — c'est lui qui garde le worker en vie.
    try {
      chrome.runtime.sendMessage(
        {
          type: 'CSG_KEEPALIVE',
          channel: lastChannel,
          captured: capturedCount,
          why: lastWhy,
          last: lastSeen
        },
        () => void chrome.runtime.lastError
      );
    } catch (_) {}
  }, 1500);

  function flushBg() {
    sendBg({ type: 'CSG_FLUSH' });
  }

  window.addEventListener('pagehide', flushBg);
  const onVisibilityChange = () => {
    if (ctxDead()) return teardown();
    whyCache = '';
    lastWhy = getWhy(true);
    paintHud();
    if (document.visibilityState === 'hidden') flushBg();
    if (document.visibilityState === 'visible') {
      rescanBacklog();
      lastRescanAt = Date.now();
      unhideSelfLines();
      unhideWhitelisted();
      harvestBlurred();
      lastRetroAt = Date.now();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  contentCleanups.push(() => {
    window.removeEventListener('pagehide', flushBg);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });

  refreshSelfNicks(true);
  unhideSelfLines();
  rescanBacklog();
  harvestBlurred();
  ensureCardObserver();
  paintViewerCards();
})();
