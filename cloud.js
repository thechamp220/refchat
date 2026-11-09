'use strict';

// Sync VPS : un seul snapshot JSON (journal, mutés, appris, réglages, clés).
// Pas de Chrome ici — le service worker et les tests s'en servent tels quels.
(function (root) {
  const CLOUD = { V: 1, PATH: '/snapshot', MAX_BYTES: 8 * 1024 * 1024, PUSH_GAP_MS: 10 * 60 * 1000, FT_KEEP: 4000 };

  function normalizeUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      if (u.username || u.password) return '';
      if (!u.hostname) return '';
      const path = u.pathname.replace(/\/+$/, '');
      return u.origin + (path === '/' ? '' : path);
    } catch (_) {
      return '';
    }
  }

  function originPattern(url) {
    const n = normalizeUrl(url);
    if (!n) return '';
    try {
      return new URL(n).origin + '/*';
    } catch (_) {
      return '';
    }
  }

  function snapshotUrl(url) {
    const n = normalizeUrl(url);
    return n ? n + CLOUD.PATH : '';
  }

  function scrubEngine(eng) {
    const out = Object.assign({}, eng && typeof eng === 'object' ? eng : {});
    delete out.goKey;
    delete out.googleKey;
    delete out.glmKey;
    delete out.xaiKey;
    delete out.customKey;
    delete out.xaiOAuth;
    delete out.apiKey;
    delete out.zenKey;
    return out;
  }

  function localEmpty(store) {
    const s = store || {};
    const muted = s.csg_muted || {};
    const ft = s.csg_ft_log || [];
    const learned = s.csg_learned || [];
    return !Object.keys(muted).length && !ft.length && !learned.length;
  }

  function build(store, rev) {
    const s = store || {};
    const ft = Array.isArray(s.csg_ft_log) ? s.csg_ft_log : [];
    return {
      v: CLOUD.V,
      rev: Number(rev) || Date.now(),
      settings: s.csg_settings && typeof s.csg_settings === 'object' ? s.csg_settings : {},
      engine: scrubEngine(s.csg_engine),
      muted: s.csg_muted && typeof s.csg_muted === 'object' ? s.csg_muted : {},
      learned: Array.isArray(s.csg_learned) ? s.csg_learned : [],
      learnLog: Array.isArray(s.csg_learn_log) ? s.csg_learn_log : [],
      learnBlock: Array.isArray(s.csg_learn_block) ? s.csg_learn_block : [],
      learnAt: Number(s.csg_learn_at) || 0,
      ftLog: ft,
      ftCount: Number(s.csg_ft_count) || ft.length,
      authors: s.csg_authors && typeof s.csg_authors === 'object' ? s.csg_authors : {},
      toxic: s.csg_toxic && typeof s.csg_toxic === 'object' ? s.csg_toxic : {}
    };
  }

  function labeled(row) {
    const l = String((row && row.label) || '').toLowerCase();
    return l === 'mute' || l === 'keep';
  }

  function muteSite(rec) {
    if (typeof rec.site === 'string') return rec.site;
    const m = /^(kick|twitch)\//i.exec(String(rec.channel || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function coversAll(rec) {
    if (!rec || typeof rec !== 'object') return false;
    if (rec.sites && typeof rec.sites === 'object' && (rec.sites.kick || rec.sites.twitch)) return false;
    return muteSite(rec) === '';
  }

  function collectSites(rec, map) {
    if (!rec) return;
    if (rec.sites && typeof rec.sites === 'object' && (rec.sites.kick || rec.sites.twitch)) {
      for (const s of ['kick', 'twitch']) if (rec.sites[s]) map[s] = rec.sites[s];
      return;
    }
    const s = muteSite(rec);
    if ((s === 'kick' || s === 'twitch') && !map[s]) {
      map[s] = { at: rec.at, pct: rec.pct, strikes: rec.strikes, channel: rec.channel, perm: rec.perm };
    }
  }

  function mergeMuted(a, b) {
    const out = Object.assign({}, a || {});
    for (const k of Object.keys(b || {})) {
      const rec = b[k];
      if (!rec) continue;
      const prev = out[k];
      if (!prev) {
        out[k] = rec;
        continue;
      }
      const base = {
        at: Math.max(Number(prev.at) || 0, Number(rec.at) || 0),
        pct: Math.max(Number(prev.pct) || 0, Number(rec.pct) || 0),
        strikes: rec.strikes || prev.strikes,
        channel: prev.channel || rec.channel || '',
        perm: !!(prev.perm || rec.perm)
      };
      // Un mute déjà valable partout le reste. Deux sites concrets différents
      // restent deux fiches : on ne les fond plus en site ''.
      if (coversAll(prev) || coversAll(rec)) {
        out[k] = Object.assign(base, { site: '' });
        continue;
      }
      const map = {};
      collectSites(prev, map);
      collectSites(rec, map);
      const keys = ['kick', 'twitch'].filter((s) => map[s]);
      if (keys.length <= 1) {
        out[k] = Object.assign(base, { site: keys[0] || '' });
        continue;
      }
      out[k] = Object.assign(base, { site: keys[0], sites: map });
    }
    return out;
  }

  function mergeTerms(a, b) {
    const map = new Map();
    for (const row of [].concat(a || [], b || [])) {
      if (!row || !row.w) continue;
      const k = String(row.w).toLowerCase();
      const prev = map.get(k);
      if (!prev || (Number(row.at) || 0) >= (Number(prev.at) || 0)) map.set(k, row);
    }
    return Array.from(map.values());
  }

  function mergeBlock(a, b) {
    const set = new Set();
    for (const x of [].concat(a || [], b || [])) {
      const w = String(x || '')
        .trim()
        .toLowerCase();
      if (w) set.add(w);
    }
    return Array.from(set);
  }

  function ftKey(row) {
    const id = String((row && row.id) || '');
    if (id) return 'id:' + id;
    return (
      'f:' +
      String((row && row.ts) || '') +
      '|' +
      String((row && row.author) || '') +
      '|' +
      String((row && row.text) || '').slice(0, 40)
    );
  }

  function mergeFt(local, remote) {
    const map = new Map();
    const put = (row) => {
      if (!row) return;
      const key = ftKey(row);
      const prev = map.get(key);
      if (!prev) {
        map.set(key, row);
        return;
      }
      const prevL = labeled(prev);
      const rowL = labeled(row);
      if (rowL && !prevL) map.set(key, row);
      else if (prevL && !rowL) return;
      else if ((Number(row.ts) || 0) > (Number(prev.ts) || 0)) map.set(key, row);
    };
    for (const r of local || []) put(r);
    for (const r of remote || []) put(r);
    return Array.from(map.values())
      .sort((x, y) => (Number(x.ts) || 0) - (Number(y.ts) || 0))
      .slice(-CLOUD.FT_KEEP);
  }

  function mergeEngine(local, remote) {
    const a = local && typeof local === 'object' ? local : {};
    const b = remote && typeof remote === 'object' ? remote : {};
    const out = Object.assign({}, b);
    for (const k of Object.keys(a)) {
      const v = a[k];
      // Un champ local vide ne doit pas effacer une clé présente sur l'autre
      // machine ; les valeurs explicites non textuelles restent prioritaires.
      if (typeof v === 'string' && !v.trim() && typeof b[k] === 'string' && b[k].trim()) continue;
      if (v !== undefined && v !== null) out[k] = v;
    }
    return out;
  }

  function scrubSnap(snap) {
    if (!snap || typeof snap !== 'object') return snap;
    return Object.assign({}, snap, { engine: scrubEngine(snap.engine) });
  }

  function merge(local, remote) {
    if (!remote || remote.v !== CLOUD.V || typeof remote !== 'object') {
      return { snap: local || null, why: 'remote-invalide' };
    }
    if (!local) return { snap: scrubSnap(remote), why: 'local-vide' };
    const empty = localEmpty({
      csg_muted: local.muted,
      csg_ft_log: local.ftLog,
      csg_learned: local.learned,
      csg_engine: local.engine
    });
    if (empty) return { snap: scrubSnap(remote), why: 'local-vide' };
    const engine = mergeEngine(local.engine, remote.engine);
    const settings = Object.assign({}, remote.settings || {}, local.settings || {});
    const ftLog = mergeFt(local.ftLog, remote.ftLog);
    const snap = {
      v: CLOUD.V,
      rev: Math.max(Number(local.rev) || 0, Number(remote.rev) || 0),
      settings,
      engine: scrubEngine(engine),
      muted: mergeMuted(local.muted, remote.muted),
      learned: mergeTerms(local.learned, remote.learned),
      learnLog: (remote.learnLog || []).length > (local.learnLog || []).length ? remote.learnLog : local.learnLog,
      learnBlock: mergeBlock(local.learnBlock, remote.learnBlock),
      learnAt: Math.max(Number(local.learnAt) || 0, Number(remote.learnAt) || 0),
      ftLog,
      ftCount: Math.max(Number(local.ftCount) || 0, Number(remote.ftCount) || 0, ftLog.length),
      authors: Object.assign({}, remote.authors || {}, local.authors || {}),
      toxic: Object.assign({}, remote.toxic || {}, local.toxic || {})
    };
    return { snap, why: 'fusion' };
  }

  function headers(token) {
    return {
      Authorization: 'Bearer ' + String(token || '').trim(),
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
  }

  root.CSG_CLOUD = {
    CLOUD,
    normalizeUrl,
    originPattern,
    snapshotUrl,
    localEmpty,
    scrubEngine,
    build,
    merge,
    mergeFt,
    mergeMuted,
    mergeTerms,
    mergeBlock,
    mergeEngine,
    headers
  };
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis);
