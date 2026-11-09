'use strict';

// Page « Tableau » : tout ce qui demande de la place et que le popup ne montre
// plus — mutés, journal des verdicts, ventilation par chat, historique d'un auteur.

const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(res || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

// « kick/xyz » → { site: 'kick', name: 'xyz' }. Les vieux enregistrements n'ont
// que le nom : ils datent d'avant Kick, donc Twitch.
function splitChan(c) {
  const s = String(c || '');
  const i = s.indexOf('/');
  if (i > 0) return { site: s.slice(0, i), name: s.slice(i + 1) };
  return { site: s ? 'twitch' : '', name: s };
}

function chanChip(c) {
  const { site, name } = splitChan(c);
  const el = document.createElement('span');
  el.className = 'chip ' + (site || '');
  el.textContent = site ? (site === 'kick' ? 'Kick' : 'Twitch') + ' · ' + name : '—';
  return el;
}

// 'dropped' = message sorti de la file sans verdict (file pleine, ou trop vieux
// au réveil du service worker). État TERMINAL : l'afficher « en attente » ferait
// croire à un jugement encore à venir, alors que plus personne ne l'attend.
function labelChip(label, source) {
  const el = document.createElement('span');
  const l = String(label || '').toLowerCase();
  const src = String(source || '').toLowerCase();
  if (src === 'politique' || l === 'politique') {
    el.className = 'chip pol';
    el.textContent = 'politique';
    el.title = 'Propos politique confirmé — mute auteur permanent';
    return el;
  }
  if (src === 'pol-suspect') {
    el.className = 'chip pending';
    el.textContent = 'pol · 1.3';
    el.title = 'Suspect politique, en attente de confirmation';
    return el;
  }
  if (l === 'skip') {
    el.className = 'chip skip';
    el.textContent = 'ignoré';
    el.title = 'Aucun modèle n’a pu lire cette ligne. Elle n’est ni acceptée ni rejetée.';
    return el;
  }
  const cls = l === 'mute' ? 'mute' : l === 'keep' ? 'keep' : l === 'review' ? 'review' : l === 'dropped' ? 'dropped' : 'pending';
  el.className = 'chip ' + cls;
  el.textContent =
    cls === 'mute' ? 'rejeté' : cls === 'keep' ? 'accepté' : cls === 'review' ? 'signalé' :
    cls === 'dropped' ? 'abandonné' : 'en attente';
  if (cls === 'dropped') el.title = 'Sorti de la file sans jugement — aucun verdict ne viendra';
  if (cls === 'review') el.title = 'Codex recommande un examen ; aucun mute appliqué';
  return el;
}

function td(text, cls) {
  const c = document.createElement('td');
  if (cls) c.className = cls;
  if (text instanceof Node) c.appendChild(text);
  else c.textContent = text == null ? '' : String(text);
  return c;
}

const FILTER_INDEX_HINT = 'Valeur interne du filtre, pas une probabilité de confiance.';
function filterIndex(value, scale = 100) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return '—';
  return Math.round(Math.max(0, Math.min(100, Number(value) * scale))) + '/100';
}

function accord(n, one, many) {
  return n + ' ' + (Number(n) === 1 ? one : many);
}

function ago(ts) {
  const d = Date.now() - (Number(ts) || 0);
  if (!ts || d < 0) return '—';
  if (d < 60000) return Math.round(d / 1000) + ' s';
  if (d < 3600000) return Math.round(d / 60000) + ' min';
  if (d < 86400000) return Math.round(d / 3600000) + ' h';
  return Math.round(d / 86400000) + ' j';
}

// Un <select> ignore une valeur qui n'est pas dans ses options. « Voir mutés »
// sur un chat sans mute laissait donc le filtre vide et montrait tout le monde.
function rememberChan(sel, chan) {
  if (!sel) return;
  const want = String(chan || '');
  if (want && sel.options && typeof sel.appendChild === 'function') {
    let found = false;
    for (let i = 0; i < sel.options.length; i++) {
      if (sel.options[i] && sel.options[i].value === want) { found = true; break; }
    }
    if (!found && document.createElement) {
      const o = document.createElement('option');
      o.value = want;
      o.textContent = chanLabel(want);
      sel.appendChild(o);
    }
  }
  sel.value = want;
}

function fillChanSelect(sel, chans, keep) {
  const cur = keep ? sel.value : '';
  sel.textContent = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'tous les chats';
  sel.appendChild(all);
  for (const c of Array.from(chans).sort()) {
    const o = document.createElement('option');
    o.value = c;
    const { site, name } = splitChan(c);
    o.textContent = (site === 'kick' ? 'Kick' : 'Twitch') + ' · ' + name;
    sel.appendChild(o);
  }
  if (cur && chans.has(cur)) sel.value = cur;
}

// ---------------------------------------------------------------- onglets
document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'log' && $('logAutoRefresh').checked) loadLog();
    if (b.dataset.tab === 'chats') loadLog();
    if (b.dataset.tab === 'report') loadReports();
    if (b.dataset.tab === 'author' && $('authorQuery') && !$('authorQuery').value.trim() && typeof renderRecentAuthors === 'function') renderRecentAuthors();
    // Un audit en masse peut avoir été lancé puis l'onglet fermé : on retrouve
    // sa progression en revenant dessus.
    if (b.dataset.tab === 'mutes') pollBulk();
    if (typeof history !== 'undefined' && history.replaceState && b.dataset && b.dataset.tab) {
      try {
        // #log?verdict=mute est appliqué au chargement, puis ce clic d'onglet
        // réécrivait #log et un rechargement perdait le filtre.
        const cur = String((location && location.hash) || '').replace(/^#/, '');
        const keep = cur === b.dataset.tab || cur.startsWith(b.dataset.tab + '?');
        if (!keep) history.replaceState(null, '', '#' + b.dataset.tab);
      } catch (_) {}
    }
  });
});

function goTab(name) {
  const b = document.querySelector('.tab[data-tab="' + name + '"]');
  if (b) b.click();
}

// ---------------------------------------------------------------- mutés
let mutedCache = {};
let liveMutedCache = {};
let muteShown = 100;
const MUTE_PAGE = 100;

// Raisons brutes (strikes) regroupées en cinq familles. L'ordre fixe les
// couleurs (voir --k-* dans board.css) : une famille garde sa couleur quel que
// soit son rang dans le tri.
const KINDS = [
  { id: 'ia', label: 'Modèle IA', color: 'var(--k-ia)' },
  { id: 'local', label: 'Liste locale', color: 'var(--k-local)' },
  { id: 'suivi', label: 'Suivi auteur', color: 'var(--k-suivi)' },
  { id: 'pol', label: 'Politique', color: 'var(--k-pol)' },
  { id: 'autre', label: 'Autre', color: 'var(--k-autre)' }
];
const KIND_BY_ID = Object.fromEntries(KINDS.map((k) => [k.id, k]));

function muteKind(rec) {
  const s = String((rec && rec.strikes) == null ? '' : rec.strikes).trim().toLowerCase();
  if (s === 'politique') return 'pol';
  if (/^(flou|llm|audit complet|relecture|suivi muse|évident|evident|reprise|direct)/.test(s)) return 'ia';
  if (/^suivi (auteur|local|susp)/.test(s)) return 'suivi';
  if (/^(liste locale|harsh|mot perso|appris|recolle|keyword|\d+$)/.test(s)) return 'local';
  return 'autre';
}

function chanLabel(c) {
  const { site, name } = splitChan(c);
  return site ? (site === 'kick' ? 'Kick' : 'Twitch') + ' · ' + name : 'chat inconnu';
}

function loadMutes() {
  chrome.storage.local.get({ csg_muted: {}, csg_live_muted: {}, csg_author_notes: {} }, ({ csg_muted, csg_live_muted, csg_author_notes }) => {
    mutedCache = csg_muted || {};
    liveMutedCache = csg_live_muted || {};
    if (csg_author_notes && typeof csg_author_notes === 'object') authorNotesCache = csg_author_notes;
    const chans = new Set();
    for (const rec of Object.values(mutedCache)) if (rec && rec.channel) chans.add(rec.channel);
    if ($('muteChan') && $('muteChan').value) chans.add($('muteChan').value);
    fillChanSelect($('muteChan'), chans, true);
    renderMuteDash();
    renderMutes();
    renderLiveMutes();
  });
}

// En live, csg_muted change à chaque mute : on regroupe les rafraîchissements
// pour que la table ne se redessine pas sous le curseur.
let muteReloadT = null;
function loadMutesSoon() {
  if (muteReloadT) return;
  muteReloadT = setTimeout(() => {
    muteReloadT = null;
    loadMutes();
  }, 1000);
}

// ------------------------------------------------ infobulle des graphiques
function showTip(ev, html) {
  const tip = $('tip');
  tip.textContent = '';
  for (const [k, v] of html) {
    const line = document.createElement('div');
    line.appendChild(document.createTextNode(k + ' '));
    const b = document.createElement('b');
    b.textContent = v;
    line.appendChild(b);
    tip.appendChild(line);
  }
  tip.classList.remove('hidden');
  const r = tip.getBoundingClientRect();
  const x = Math.min(ev.clientX + 12, window.innerWidth - r.width - 8);
  const y = ev.clientY - r.height - 12 < 8 ? ev.clientY + 16 : ev.clientY - r.height - 12;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = y + 'px';
}
function hideTip() {
  $('tip').classList.add('hidden');
}

function hbar(label, value, max, color, on, onClick, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hb' + (on ? ' on' : '');
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (title) b.title = title;
  const n = document.createElement('span');
  n.className = 'n';
  const sw = document.createElement('i');
  sw.style.background = color;
  const em = document.createElement('em');
  em.textContent = label;
  n.appendChild(sw);
  n.appendChild(em);
  const t = document.createElement('span');
  t.className = 't';
  const fill = document.createElement('i');
  fill.style.width = (max ? Math.max(1, Math.round((value / max) * 100)) : 0) + '%';
  fill.style.background = color;
  t.appendChild(fill);
  const v = document.createElement('span');
  v.className = 'v';
  v.textContent = String(value);
  b.appendChild(n);
  b.appendChild(t);
  b.appendChild(v);
  b.addEventListener('click', onClick);
  return b;
}

function renderMuteDash() {
  const recs = Object.values(mutedCache).map((r) => r || {});
  const now = Date.now();
  const total = recs.length;
  const day = recs.filter((r) => r.at && now - r.at < 86400000).length;
  const prevDay = recs.filter((r) => r.at && now - r.at >= 86400000 && now - r.at < 2 * 86400000).length;
  const perm = recs.filter((r) => r.perm).length;
  const scored = recs.filter((r) => r.pct != null && Number.isFinite(Number(r.pct)));
  const chans = new Set(recs.map((r) => r.channel).filter(Boolean));

  $('kTotal').textContent = String(total);
  $('kTotalSub').textContent = accord(chans.size, 'chat', 'chats');
  $('kDay').textContent = String(day);
  const diff = day - prevDay;
  $('kDaySub').textContent = prevDay || day ? (diff >= 0 ? '+' : '−') + Math.abs(diff) + ' vs la veille' : 'aucun mute récent';
  $('kPerm').textContent = String(perm);
  $('kPermSub').textContent = total ? Math.round((perm / total) * 100) + ' % du total' : ' ';
  $('kScore').textContent = scored.length
    ? filterIndex(scored.reduce((s, r) => s + Number(r.pct), 0) / scored.length, 1)
    : '—';
  $('kScore').title = FILTER_INDEX_HINT;

  // Mutes par jour, 14 jours glissants, jour local.
  const days = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  for (let i = 13; i >= 0; i--) {
    const d = new Date(start);
    d.setDate(d.getDate() - i);
    days.push({ t: d.getTime(), n: 0 });
  }
  for (const r of recs) {
    if (!r.at || r.at < days[0].t) continue;
    for (let i = days.length - 1; i >= 0; i--) {
      if (r.at >= days[i].t) {
        days[i].n += 1;
        break;
      }
    }
  }
  const maxDay = Math.max(1, ...days.map((d) => d.n));
  const cols = $('muteDays');
  cols.textContent = '';
  const axis = document.createElement('div');
  axis.className = 'colx';
  for (const d of days) {
    const c = document.createElement('div');
    c.className = 'c' + (d.n ? '' : ' zero');
    const bar = document.createElement('i');
    bar.style.height = Math.round((d.n / maxDay) * 100) + '%';
    c.appendChild(bar);
    const date = new Date(d.t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    c.setAttribute('aria-label', date + ' : ' + accord(d.n, 'mute', 'mutes'));
    c.addEventListener('mousemove', (ev) => showTip(ev, [[date, accord(d.n, 'mute', 'mutes')]]));
    c.addEventListener('mouseleave', hideTip);
    cols.appendChild(c);
    const lab = document.createElement('span');
    lab.textContent = String(new Date(d.t).getDate());
    axis.appendChild(lab);
  }
  // Un seul axe x : celui du rendu précédent part avant qu'on pose le nouveau.
  cols.parentNode.querySelectorAll('.colx').forEach((x) => x.remove());
  cols.after(axis);

  // Par raison : les cinq familles, triées par volume, couleur fixe.
  const kindSel = $('muteKind').value;
  const byKind = new Map(KINDS.map((k) => [k.id, 0]));
  for (const r of recs) byKind.set(muteKind(r), byKind.get(muteKind(r)) + 1);
  const kindsBox = $('muteKinds');
  kindsBox.textContent = '';
  const kindRows = KINDS.filter((k) => byKind.get(k.id)).sort((a, b) => byKind.get(b.id) - byKind.get(a.id));
  const maxKind = Math.max(0, ...kindRows.map((k) => byKind.get(k.id)));
  if (!kindRows.length) kindsBox.appendChild(noneLine());
  for (const k of kindRows) {
    kindsBox.appendChild(
      hbar(k.label, byKind.get(k.id), maxKind, k.color, kindSel === k.id, () => {
        $('muteKind').value = kindSel === k.id ? '' : k.id;
        muteShown = MUTE_PAGE;
        renderMuteDash();
        renderMutes();
      })
    );
  }

  // Par chat : une seule série, une seule teinte ; 6 chats puis « autres ».
  const chanSel = $('muteChan').value;
  const byChan = new Map();
  for (const r of recs) byChan.set(r.channel || '', (byChan.get(r.channel || '') || 0) + 1);
  const chanRows = Array.from(byChan.entries()).sort((a, b) => b[1] - a[1]);
  const chanBox = $('muteChans');
  chanBox.textContent = '';
  if (!chanRows.length) chanBox.appendChild(noneLine());
  const maxChan = chanRows.length ? chanRows[0][1] : 0;
  for (const [c, n] of chanRows.slice(0, 6)) {
    chanBox.appendChild(
      hbar(chanLabel(c), n, maxChan, 'var(--series)', !!c && chanSel === c, () => {
        if (!c) return;
        $('muteChan').value = chanSel === c ? '' : c;
        muteShown = MUTE_PAGE;
        renderMuteDash();
        renderMutes();
      }, c ? '' : 'Mutés avant que le chat soit noté')
    );
  }
  if (chanRows.length > 6) {
    const rest = chanRows.slice(6).reduce((s, [, n]) => s + n, 0);
    const p = document.createElement('p');
    p.className = 'none';
    p.textContent = extraChanLine(chanRows.length - 6, rest);
    chanBox.appendChild(p);
  }
}

function muteChannels(rec) {
  const out = [];
  if (rec && rec.sites) {
    for (const s of ['kick', 'twitch']) {
      const ch = rec.sites[s] && rec.sites[s].channel;
      if (ch && out.indexOf(ch) === -1) out.push(ch);
    }
  }
  if (rec && rec.channel && out.indexOf(rec.channel) === -1) out.push(rec.channel);
  return out;
}

function extraChanLine(extra, rest) {
  return '+ ' + accord(extra, 'autre chat', 'autres chats') + ' · ' + accord(rest, 'muté', 'mutés');
}

function noneLine() {
  const p = document.createElement('p');
  p.className = 'none';
  p.textContent = 'Personne muté.';
  return p;
}

function renderLiveMutes() {
  const reasons = { threat: 'Menace', doxxing: 'Divulgation privée', slur: 'Haine ciblée',
    sexual_harassment: 'Harcèlement sexuel', targeted_insult: 'Insulte grave',
    sustained_harassment: 'Harcèlement répété' };
  const rows = Object.values(liveMutedCache).filter((r) =>
    r && Number(r.expiresAt) > Date.now() && Number(r.sessionUntil) > Date.now());
  $('cMutes').textContent = String(Object.keys(mutedCache).length + rows.length);
  const box = $('liveMutesBox');
  box.classList.toggle('hidden', !rows.length);
  const body = $('liveMuteRows');
  body.textContent = '';
  for (const rec of rows.sort((a, b) => Number(a.expiresAt) - Number(b.expiresAt))) {
    const tr = document.createElement('tr');
    tr.appendChild(td(rec.author, 'who bad'));
    tr.appendChild(td(chanLabel(rec.channel)));
    tr.appendChild(td(reasons[rec.category] || 'IA'));
    const until = Math.min(Number(rec.expiresAt), Number(rec.sessionUntil));
    const when = td(new Date(until).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), 'num');
    when.title = new Date(until).toLocaleString();
    tr.appendChild(when);
    const act = td('', 'act');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Annuler';
    button.title = 'Annule tous les mutes temporaires et suspend le pilote automatique';
    button.addEventListener('click', async () => {
      button.disabled = true;
      const result = await send({ type: 'CSG_LIVE_UNDO', channel: rec.channel, author: rec.author });
      if (!result || !result.ok) {
        $('liveMuteError').textContent = (result && result.err) || 'Annulation indisponible. Réessaie.';
        $('liveMuteError').classList.remove('hidden');
        button.disabled = false;
      } else {
        $('liveMuteError').classList.add('hidden');
        loadMutes();
      }
    });
    act.appendChild(button);
    tr.appendChild(act);
    body.appendChild(tr);
  }
}

function renderMutes() {
  const q = $('muteSearch').value.trim().toLowerCase();
  const platform = $('mutePlatform') ? $('mutePlatform').value : '';
  const chan = $('muteChan').value;
  const kind = $('muteKind').value;
  const permOnly = $('mutePerm').checked;
  const notedOnly = $('muteNoted') && $('muteNoted').checked;
  const sort = $('muteSort') ? $('muteSort').value : 'date';
  const time = $('muteTime') ? $('muteTime').value : '';
  const now = Date.now();
  let timeLimit = 0;
  if (time === '1h') timeLimit = now - 60 * 60 * 1000;
  else if (time === '24h') timeLimit = now - 24 * 60 * 60 * 1000;
  else if (time === '7d') timeLimit = now - 7 * 24 * 60 * 60 * 1000;
  else if (time === '30d') timeLimit = now - 30 * 24 * 60 * 60 * 1000;
  const rows = Object.entries(mutedCache)
    .filter(
      ([name, rec]) =>
        (!q || name.includes(q) || String((rec && rec.strikes) || '').toLowerCase().includes(q) || (typeof authorNotesCache !== 'undefined' && authorNotesCache && authorNotesCache[name.toLowerCase()] && authorNotesCache[name.toLowerCase()].text.toLowerCase().includes(q))) &&
        (!platform || muteChannels(rec).some((c) => splitChan(c).site === platform)) &&
        (!chan || muteChannels(rec).indexOf(chan) !== -1) &&
        (!kind || muteKind(rec) === kind) &&
        (!permOnly || (rec && rec.perm)) &&
        (!notedOnly || (typeof authorNotesCache !== 'undefined' && authorNotesCache && authorNotesCache[name.toLowerCase()] && authorNotesCache[name.toLowerCase()].text)) &&
        (!timeLimit || ((rec && rec.at) && rec.at >= timeLimit))
    )
    .sort((a, b) => {
      if (sort === 'score') {
        const sa = Number(a[1] && a[1].pct) || 0;
        const sb = Number(b[1] && b[1].pct) || 0;
        if (sb !== sa) return sb - sa;
      } else if (sort === 'name') {
        return a[0].localeCompare(b[0]);
      }
      return ((b[1] && b[1].at) || 0) - ((a[1] && a[1].at) || 0);
    });
  const total = Object.keys(mutedCache).length;
  $('muteCount').textContent = rows.length === total
    ? accord(total, 'muté', 'mutés')
    : rows.length + ' / ' + accord(total, 'muté', 'mutés');
  const body = $('muteRows');
  body.textContent = '';
  $('muteEmpty').style.display = rows.length ? 'none' : '';
  $('muteEmpty').textContent = total ? 'Aucun muté ne correspond au filtre.' : 'Personne muté.';
  const more = $('muteMore');
  const left = rows.length - muteShown;
  more.classList.toggle('hidden', left <= 0);
  more.textContent = 'Afficher ' + Math.min(MUTE_PAGE, Math.max(0, left)) + ' de plus · ' + Math.max(0, left) + ' restants';
  for (const [name, rec] of rows.slice(0, muteShown)) {
    const r = rec || {};
    const tr = document.createElement('tr');
    const who = td(name, 'who bad');
    who.style.cursor = 'pointer';
    who.title = 'Inspecter cet auteur (double-clic pour copier)';
    who.addEventListener('click', () => {
      $('authorQuery').value = name;
      goTab('author');
      showAuthor(name);
    });
    who.addEventListener('dblclick', async (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(name);
          who.title = 'Copié ✓';
          setTimeout(() => { who.title = 'Inspecter cet auteur (double-clic pour copier)'; }, 1500);
        }
      } catch (_) {}
    });
    if (r.perm) {
      const p = document.createElement('span');
      p.className = 'perm';
      p.textContent = 'perma';
      p.title = 'Mute permanent : jamais levé automatiquement';
      who.appendChild(p);
    }
    if (typeof authorNotesCache !== 'undefined' && authorNotesCache && authorNotesCache[name.toLowerCase()]) {
      const noteBadge = document.createElement('span');
      noteBadge.className = 'chip';
      noteBadge.style.fontSize = '9px';
      noteBadge.style.marginLeft = '4px';
      noteBadge.style.padding = '0 3px';
      noteBadge.textContent = '📝';
      noteBadge.title = 'Note : ' + authorNotesCache[name.toLowerCase()].text;
      who.appendChild(noteBadge);
    }
    tr.appendChild(who);
    const k = KIND_BY_ID[muteKind(r)];
    const rs = document.createElement('span');
    rs.className = 'rs';
    const sw = document.createElement('i');
    sw.style.background = k.color;
    rs.appendChild(sw);
    rs.appendChild(document.createTextNode(k.label));
    const raw = String(r.strikes == null ? '' : r.strikes);
    if (raw && raw.toLowerCase() !== k.label.toLowerCase()) {
      const sm = document.createElement('small');
      sm.textContent = '· ' + raw;
      rs.appendChild(sm);
    }
    tr.appendChild(td(rs));
    const where = document.createElement('td');
    const chans = muteChannels(r);
    if (!chans.length) where.textContent = '—';
    else {
      for (const ch of chans) {
        const chip = chanChip(ch);
        if (chip && chip.addEventListener) {
          chip.style.cursor = 'pointer';
          chip.title = 'Filtrer les mutés sur ce chat';
          chip.addEventListener('click', (ev) => {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            if ($('muteChan')) {
              $('muteChan').value = ch;
              refilterMutes();
            }
          });
        }
        where.appendChild(chip);
      }
    }
    tr.appendChild(where);
    const pct = Number(r.pct);
    if (r.pct != null && Number.isFinite(pct)) {
      const m = document.createElement('span');
      m.className = 'meter';
      const track = document.createElement('span');
      const fill = document.createElement('i');
      fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
      track.appendChild(fill);
      m.appendChild(track);
      m.title = FILTER_INDEX_HINT;
      m.appendChild(document.createTextNode(filterIndex(pct, 1)));
      tr.appendChild(td(m, 'num'));
    } else tr.appendChild(td('—', 'num'));
    const when = td(r.at ? 'il y a ' + ago(r.at) : '—', 'num');
    if (r.at) when.title = new Date(r.at).toLocaleString();
    tr.appendChild(when);
    const act = td('', 'act');
    const view = document.createElement('button');
    view.type = 'button';
    view.textContent = 'Voir';
    view.addEventListener('click', () => {
      $('authorQuery').value = name;
      goTab('author');
      showAuthor(name);
    });
    const un = document.createElement('button');
    un.type = 'button';
    un.textContent = 'Démuter';
    un.addEventListener('click', async () => {
      un.disabled = true;
      await send({ type: 'CSG_MUTE_REMOVE', key: name });
      loadMutes();
    });
    const wl = document.createElement('button');
    wl.type = 'button';
    wl.textContent = 'Protéger';
    wl.title = 'Ajoute ' + name + ' à la whitelist (protégé contre tout mute) et le retire des mutés';
    wl.addEventListener('click', async () => {
      wl.disabled = true;
      await send({ type: 'CSG_WHITELIST', names: [name], on: true });
      loadMutes();
    });
    const noteBtn = document.createElement('button');
    noteBtn.type = 'button';
    noteBtn.className = 'btn-mute-note';
    const noteRec = typeof authorNotesCache !== 'undefined' && authorNotesCache && authorNotesCache[name.toLowerCase()];
    noteBtn.textContent = noteRec ? '📝 Note' : '+ Note';
    noteBtn.title = noteRec ? 'Modifier la note mémo (' + noteRec.text + ')' : 'Ajouter une note mémo sur cet auteur';
    noteBtn.addEventListener('click', async () => {
      const ask = typeof window !== 'undefined' && typeof window.prompt === 'function' ? window.prompt : (typeof prompt === 'function' ? prompt : null);
      const cur = noteRec ? noteRec.text : '';
      const input = ask ? ask('Note mémo pour ' + name + ' (laisser vide pour effacer) :', cur) : null;
      if (input === null) return;
      const clean = input.trim();
      noteBtn.disabled = true;
      const res = await send({ type: 'CSG_AUTHOR_NOTE_SET', author: name, text: clean });
      noteBtn.disabled = false;
      if (res && res.ok) {
        if (typeof authorNotesCache === 'undefined' || !authorNotesCache) authorNotesCache = {};
        if (clean) {
          authorNotesCache[name.toLowerCase()] = { text: clean, ts: Date.now() };
        } else {
          delete authorNotesCache[name.toLowerCase()];
        }
        renderMutes();
      }
    });
    act.appendChild(view);
    act.appendChild(un);
    act.appendChild(wl);
    act.appendChild(noteBtn);
    tr.appendChild(act);
    body.appendChild(tr);
  }
}

function refilterMutes() {
  muteShown = MUTE_PAGE;
  renderMuteDash();
  renderMutes();
}
$('muteSearch').addEventListener('input', refilterMutes);
if ($('mutePlatform')) $('mutePlatform').addEventListener('change', refilterMutes);
$('muteChan').addEventListener('change', refilterMutes);
$('muteKind').addEventListener('change', refilterMutes);
$('mutePerm').addEventListener('change', refilterMutes);
if ($('muteNoted')) $('muteNoted').addEventListener('change', refilterMutes);
if ($('muteSort')) $('muteSort').addEventListener('change', refilterMutes);
if ($('muteTime')) $('muteTime').addEventListener('change', refilterMutes);
$('muteMore').addEventListener('click', () => {
  muteShown += MUTE_PAGE;
  renderMutes();
});

// ------------------------------------------------------------ archive disque
// Pastille d'en-tête : les messages partent-ils bien sur le disque ? Un clic
// force un envoi tout de suite.
function renderDisk(res) {
  const pill = $('diskPill');
  const label = pill.querySelector('span');
  const d = res && res.ok ? res.disk : null;
  pill.classList.remove('ok', 'err');
  if (!d) {
    label.textContent = 'Disque : service worker endormi';
    pill.title = 'Rouvre le popup pour réveiller l’extension.';
    return;
  }
  const late = Math.max(0, (d.archived || 0) - (d.sent || 0));
  const fmt = (n) => Number(n || 0).toLocaleString();
  if (d.err) {
    pill.classList.add('err');
    label.textContent = 'Disque : serveur coupé · ' + fmt(late) + ' en attente';
  } else if (d.ok) {
    pill.classList.add('ok');
    label.textContent = late ? 'Disque : ' + fmt(late) + ' en cours d’envoi' : 'Disque à jour · ' + fmt(d.total || d.sent) + ' messages';
  } else {
    label.textContent = 'Disque : jamais contacté';
  }
  pill.title = [
    'Archive à vie en JSONL, écrite par archive-server/server.mjs (' + d.url + ').',
    fmt(d.sent) + ' / ' + fmt(d.archived) + ' lignes archivées envoyées, ' + fmt(d.window) + ' encore dans la fenêtre du journal.',
    d.at ? 'Dernier envoi : ' + new Date(d.at).toLocaleString() : 'Aucun envoi réussi.',
    d.err ? 'Erreur : ' + d.err : '',
    'Clic : envoyer maintenant.'
  ]
    .filter(Boolean)
    .join('\n');
}

async function loadDisk(push) {
  renderDisk(await send({ type: 'CSG_DISK_STATUS', push: !!push }));
}

$('diskPill').addEventListener('click', async () => {
  const pill = $('diskPill');
  pill.disabled = true;
  pill.querySelector('span').textContent = 'Envoi…';
  await loadDisk(true);
  pill.disabled = false;
});

// ------------------------------------------------------------ alerte sonore
let audioCtx = null;
function playNotificationChime(isUrgent) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    if (isUrgent) {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
      osc.frequency.exponentialRampToValueAtTime(1320, now + 0.24);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.45);
    } else {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.35);
    }
  } catch (_) {}
}

let soundAlertOn = false;
try {
  soundAlertOn = localStorage.getItem('csg_sound_alert') === '1';
} catch (_) {}
try {
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({ csg_sound_alert: soundAlertOn }, (v) => {
      if (v && v.csg_sound_alert !== undefined) {
        soundAlertOn = !!v.csg_sound_alert;
        renderSoundPill();
      }
    });
  }
} catch (_) {}

function renderSoundPill() {
  const pill = $('soundPill');
  if (!pill) return;
  const label = pill.querySelector('span');
  if (soundAlertOn) {
    pill.classList.add('ok');
    if (label) label.textContent = 'Son actif';
    pill.title = 'Alerte sonore active lors des détections critiques (clique pour couper)';
  } else {
    pill.classList.remove('ok');
    if (label) label.textContent = 'Son coupé';
    pill.title = 'Alerte sonore coupée (clique pour activer)';
  }
}
renderSoundPill();

if ($('soundPill')) {
  $('soundPill').addEventListener('click', () => {
    soundAlertOn = !soundAlertOn;
    try {
      localStorage.setItem('csg_sound_alert', soundAlertOn ? '1' : '0');
    } catch (_) {}
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ csg_sound_alert: soundAlertOn });
      }
      if (chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.get({ csg_settings: {} }, ({ csg_settings }) => {
          chrome.storage.sync.set({ csg_settings: Object.assign({}, csg_settings, { soundAlert: soundAlertOn }) });
        });
      }
    } catch (_) {}
    renderSoundPill();
    if (soundAlertOn) playNotificationChime();
  });
}
if ($('exportMutes')) {
  $('exportMutes').addEventListener('click', () => {
    const all = Object.entries(mutedCache);
    if (!all.length) {
      alert('Aucun auteur muté à exporter.');
      return;
    }
    const filteredAuthors = getFilteredMuteAuthors();
    if (!filteredAuthors.length) {
      alert('Aucun auteur muté ne correspond au filtre.');
      return;
    }
    const wanted = new Set(filteredAuthors);
    const list = all.filter(([name]) => wanted.has(name));
    const headers = ['Date_Heure', 'Horodatage_ms', 'Pseudo', 'Chat', 'Raison', 'Famille', 'Indice', 'Permanent', 'Note_Moderateur'];
    const data = list.map(([author, rec]) => {
      const r = rec || {};
      const chans = muteChannels(r);
      const k = KIND_BY_ID[muteKind(r)];
      const note = (typeof authorNotesCache !== 'undefined' && authorNotesCache && authorNotesCache[author.toLowerCase()] && authorNotesCache[author.toLowerCase()].text) || '';
      return [
        r.at ? new Date(r.at).toLocaleString('fr-FR') : '',
        r.at || '',
        author,
        chans.join('; '),
        String(r.strikes == null ? '' : r.strikes),
        k ? k.label : muteKind(r),
        r.pct != null && Number.isFinite(Number(r.pct)) ? Math.round(Number(r.pct)) + '/100' : '',
        r.perm ? 'Oui' : 'Non',
        note
      ];
    });
    downloadCsv(headers, data, 'csg-mutes');
  });
}
if ($('exportMutesJson')) {
  $('exportMutesJson').addEventListener('click', () => {
    const all = Object.entries(mutedCache);
    if (!all.length) {
      alert('Aucun auteur muté à exporter.');
      return;
    }
    const filteredAuthors = getFilteredMuteAuthors();
    if (!filteredAuthors.length) {
      alert('Aucun auteur muté ne correspond au filtre.');
      return;
    }
    const wanted = new Set(filteredAuthors);
    const list = all.filter(([name]) => wanted.has(name));
    const data = list.map(([author, rec]) => {
      const r = rec || {};
      const chans = muteChannels(r);
      const k = KIND_BY_ID[muteKind(r)];
      const note = (typeof authorNotesCache !== 'undefined' && authorNotesCache && authorNotesCache[author.toLowerCase()] && authorNotesCache[author.toLowerCase()].text) || '';
      return {
        author,
        at: r.at || null,
        date: r.at ? new Date(r.at).toISOString() : null,
        channels: chans,
        reason: String(r.strikes == null ? '' : r.strikes),
        kind: k ? k.label : muteKind(r),
        kindId: muteKind(r),
        pct: r.pct != null && Number.isFinite(Number(r.pct)) ? Number(r.pct) : null,
        permanent: !!r.perm,
        note: note || null
      };
    });
    downloadJson(data, 'csg-mutes');
  });
}

function getFilteredMuteAuthors() {
  const q = ($('muteSearch') ? $('muteSearch').value.trim().toLowerCase() : '');
  const platform = ($('mutePlatform') ? $('mutePlatform').value : '');
  const chan = ($('muteChan') ? $('muteChan').value : '');
  const kind = ($('muteKind') ? $('muteKind').value : '');
  const perm = ($('mutePerm') ? $('mutePerm').checked : false);
  const time = ($('muteTime') ? $('muteTime').value : '');
  const now = Date.now();
  let timeLimit = 0;
  if (time === '1h') timeLimit = now - 60 * 60 * 1000;
  else if (time === '24h') timeLimit = now - 24 * 60 * 60 * 1000;
  else if (time === '7d') timeLimit = now - 7 * 24 * 60 * 60 * 1000;
  else if (time === '30d') timeLimit = now - 30 * 24 * 60 * 60 * 1000;
  return Object.entries(mutedCache)
    .filter(([name, r]) =>
      (!q || name.includes(q) || String((r && r.strikes) || '').toLowerCase().includes(q)) &&
      (!platform || muteChannels(r).some((c) => splitChan(c).site === platform)) &&
      (!chan || muteChannels(r).includes(chan)) &&
      (!kind || muteKind(r) === kind) &&
      (!perm || (r && r.perm)) &&
      (!timeLimit || ((r && r.at) && r.at >= timeLimit))
    )
    .map(([name]) => name);
}

if ($('copyMuteNames')) {
  $('copyMuteNames').addEventListener('click', async () => {
    const authors = getFilteredMuteAuthors();
    if (!authors.length) {
      alert('Aucun auteur muté à copier.');
      return;
    }
    const text = authors.join('\n');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        const btn = $('copyMuteNames');
        const prev = btn.textContent;
        btn.textContent = authors.length + ' copié' + (authors.length > 1 ? 's' : '') + ' ✓';
        setTimeout(() => { btn.textContent = prev; }, 1500);
      }
    } catch (_) {}
  });
}

function openMuteModal(defaultAuthor, defaultChan, defaultReason) {
  const modal = $('muteModal');
  if (!modal) return;
  const authorInput = $('muteModalAuthor');
  const chanSelect = $('muteModalChan');
  const reasonInput = $('muteModalReason');
  const permCheck = $('muteModalPerm');
  const errBox = $('muteModalErr');

  if (errBox) {
    errBox.textContent = '';
    errBox.classList.add('hidden');
  }
  const chosenReason = defaultReason || 'manuel';
  if (authorInput) authorInput.value = defaultAuthor || '';
  if (reasonInput) reasonInput.value = chosenReason;
  if (permCheck) permCheck.checked = true;

  const noteInput = $('muteModalNote');
  if (noteInput) {
    const curNote = (typeof authorNotesCache !== 'undefined' && authorNotesCache && defaultAuthor && authorNotesCache[String(defaultAuthor).toLowerCase()]);
    noteInput.value = curNote ? curNote.text : '';
  }
  updateMuteModalPresetHighlights(chosenReason);

  if (chanSelect) {
    if ($('muteChan')) chanSelect.innerHTML = $('muteChan').innerHTML;
    const want = String(defaultChan || '');
    // Le menu ne liste que les chats déjà mutés. Sans cette option, un
    // <select> ignore twitch/demo et le mute est enregistré sans salon.
    if (want && chanSelect.options && ![...chanSelect.options].some((o) => o.value === want)) {
      const o = document.createElement('option');
      o.value = want;
      const cut = want.indexOf('/');
      o.textContent = cut > 0 ? (want.slice(0, cut) === 'kick' ? 'Kick' : 'Twitch') + ' · ' + want.slice(cut + 1) : want;
      chanSelect.appendChild(o);
    }
    chanSelect.value = want || ($('muteChan') && $('muteChan').value) || '';
  }

  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.classList.remove('hidden');
  }
  if (authorInput && authorInput.focus) authorInput.focus();
}

function closeMuteModal() {
  const modal = $('muteModal');
  if (!modal) return;
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.classList.add('hidden');
  }
}

function updateMuteModalPresetHighlights(reason) {
  const container = $('muteModalPresets');
  if (!container || !container.querySelectorAll) return;
  const btns = container.querySelectorAll('.preset-btn') || [];
  for (const b of btns) {
    if (b && b.classList) {
      b.classList.toggle('on', b.dataset && b.dataset.reason === reason);
    }
  }
}

function openHelpModal() {
  const modal = $('helpModal');
  if (!modal) return;
  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.classList.remove('hidden');
  }
}

function closeHelpModal() {
  const modal = $('helpModal');
  if (!modal) return;
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.classList.add('hidden');
  }
}

if ($('helpPill')) $('helpPill').addEventListener('click', openHelpModal);
if ($('helpModalClose')) $('helpModalClose').addEventListener('click', closeHelpModal);
if ($('helpModalOk')) $('helpModalOk').addEventListener('click', closeHelpModal);
const helpModalEl = $('helpModal');
if (helpModalEl) {
  helpModalEl.addEventListener('click', (e) => {
    if (e.target === helpModalEl) closeHelpModal();
  });
}

// ------------------------------------------------------------ whitelist
let whitelistCache = {};

async function loadWhitelist() {
  try {
    if (chrome.storage && chrome.storage.local) {
      const v = await new Promise((r) => chrome.storage.local.get({ csg_whitelist: {} }, r));
      whitelistCache = v.csg_whitelist || {};
    }
  } catch (_) {}
  renderWhitelist();
}

function renderWhitelist() {
  const container = $('whitelistChips');
  const countEl = $('whitelistCount');
  const emptyEl = $('whitelistEmpty');
  if (!container) return;
  container.textContent = '';

  const q = ($('whitelistSearch') ? $('whitelistSearch').value.trim().toLowerCase() : '');
  const allNames = Object.keys(whitelistCache).sort();
  const filtered = allNames.filter((name) => !q || name.toLowerCase().includes(q));

  if (countEl) {
    countEl.textContent = allNames.length + ' ' + (allNames.length > 1 ? 'auteurs protégés' : 'auteur protégé');
  }

  if (emptyEl) {
    emptyEl.classList.toggle('hidden', filtered.length > 0);
    emptyEl.textContent = allNames.length ? 'Aucun résultat pour cette recherche.' : 'Aucun auteur dans la whitelist.';
  }

  for (const name of filtered) {
    const chip = document.createElement('div');
    chip.className = 'wl-chip';
    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = name;
    nameEl.title = 'Inspecter le dossier de ' + name;
    nameEl.addEventListener('click', () => {
      closeWhitelistModal();
      $('authorQuery').value = name;
      goTab('author');
      showAuthor(name);
    });
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove';
    removeBtn.innerHTML = '&times;';
    removeBtn.title = 'Retirer ' + name + ' de la whitelist';
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      removeBtn.disabled = true;
      delete whitelistCache[name];
      renderWhitelist();
      await send({ type: 'CSG_WHITELIST', names: [name], on: false });
      loadWhitelist();
    });
    chip.appendChild(nameEl);
    chip.appendChild(removeBtn);
    container.appendChild(chip);
  }
}

function openWhitelistModal() {
  const modal = $('whitelistModal');
  if (!modal) return;
  if ($('whitelistAddInput')) $('whitelistAddInput').value = '';
  if ($('whitelistSearch')) $('whitelistSearch').value = '';
  loadWhitelist();
  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.classList.remove('hidden');
  if ($('whitelistAddInput') && $('whitelistAddInput').focus) $('whitelistAddInput').focus();
}

function closeWhitelistModal() {
  const modal = $('whitelistModal');
  if (!modal) return;
  if (typeof modal.close === 'function') modal.close();
  else modal.classList.add('hidden');
}

if ($('whitelistBtn')) $('whitelistBtn').addEventListener('click', openWhitelistModal);
if ($('whitelistModalClose')) $('whitelistModalClose').addEventListener('click', closeWhitelistModal);
if ($('whitelistModalOk')) $('whitelistModalOk').addEventListener('click', closeWhitelistModal);
const wlModalEl = $('whitelistModal');
if (wlModalEl) {
  wlModalEl.addEventListener('click', (e) => {
    if (e.target === wlModalEl) closeWhitelistModal();
  });
}

if ($('whitelistSearch')) $('whitelistSearch').addEventListener('input', renderWhitelist);

if ($('whitelistCopyBtn')) {
  $('whitelistCopyBtn').addEventListener('click', async () => {
    const allNames = Object.keys(whitelistCache).sort();
    if (!allNames.length) {
      if (typeof alert === 'function') alert('Aucun auteur dans la whitelist.');
      return;
    }
    const q = ($('whitelistSearch') ? $('whitelistSearch').value.trim().toLowerCase() : '');
    const names = q ? allNames.filter((name) => name.toLowerCase().includes(q)) : allNames;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(names.join('\n'));
        const btn = $('whitelistCopyBtn');
        const prev = btn.textContent;
        btn.textContent = 'Copié ✓';
        if (typeof setTimeout === 'function') setTimeout(() => { btn.textContent = prev; }, 1500);
      }
    } catch (_) {}
  });
}

if ($('whitelistClearBtn')) {
  $('whitelistClearBtn').addEventListener('click', async () => {
    const allNames = Object.keys(whitelistCache);
    if (!allNames.length) return;
    if (typeof confirm === 'function' && !confirm('Retirer tous les ' + allNames.length + ' auteur' + (allNames.length > 1 ? 's' : '') + ' de la whitelist ?')) {
      return;
    }
    whitelistCache = {};
    renderWhitelist();
    await send({ type: 'CSG_WHITELIST', names: allNames, on: false });
    loadWhitelist();
  });
}

if ($('whitelistAddBtn')) {
  $('whitelistAddBtn').addEventListener('click', async () => {
    const input = $('whitelistAddInput');
    if (!input) return;
    const raw = input.value.trim();
    if (!raw) return;
    const names = raw.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!names.length) return;
    input.value = '';
    for (const n of names) whitelistCache[n] = { at: Date.now() };
    renderWhitelist();
    await send({ type: 'CSG_WHITELIST', names, on: true });
    loadWhitelist();
  });
}
if ($('whitelistAddInput')) {
  $('whitelistAddInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if ($('whitelistAddBtn')) $('whitelistAddBtn').click();
    }
  });
}

// ------------------------------------------------------------ mots bannis
function updateWordsCount(val) {
  const countEl = $('wordsCount');
  if (!countEl) return;
  const words = String(val || '').split(/[,;\n\r]+/).map((w) => w.trim()).filter(Boolean);
  let kept = 0;
  let short = 0;
  for (const w of words) {
    if (w.length >= 3) kept++;
    else short++;
  }
  const parts = [kept + ' ' + (kept > 1 ? 'mots valides' : 'mot valide')];
  if (short) parts.push(short + ' trop court' + (short > 1 ? 's' : ''));
  countEl.textContent = parts.join(' · ');
}

function openWordsModal() {
  const modal = $('wordsModal');
  if (!modal) return;
  try {
    if (chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get({ csg_settings: {} }, ({ csg_settings }) => {
        if ($('wordsInput')) {
          $('wordsInput').value = (csg_settings && csg_settings.extraWords) || '';
          updateWordsCount($('wordsInput').value);
        }
      });
    }
  } catch (_) {}
  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.classList.remove('hidden');
  if ($('wordsInput') && $('wordsInput').focus) $('wordsInput').focus();
}

function closeWordsModal() {
  const modal = $('wordsModal');
  if (!modal) return;
  if (typeof modal.close === 'function') modal.close();
  else modal.classList.add('hidden');
}

if ($('wordsBtn')) $('wordsBtn').addEventListener('click', openWordsModal);
if ($('wordsModalClose')) $('wordsModalClose').addEventListener('click', closeWordsModal);
if ($('wordsModalSave')) {
  $('wordsModalSave').addEventListener('click', () => {
    const val = $('wordsInput') ? $('wordsInput').value : '';
    try {
      if (chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.get({ csg_settings: {} }, ({ csg_settings }) => {
          chrome.storage.sync.set({ csg_settings: Object.assign({}, csg_settings, { extraWords: val }) });
        });
      }
    } catch (_) {}
    closeWordsModal();
  });
}
if ($('wordsInput')) {
  $('wordsInput').addEventListener('input', (e) => {
    updateWordsCount(e.target.value);
  });
}
if ($('wordsCopyBtn')) {
  $('wordsCopyBtn').addEventListener('click', async () => {
    const input = $('wordsInput');
    const val = input ? input.value.trim() : '';
    if (!val) {
      alert('Aucun mot banni à copier.');
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(val);
        const btn = $('wordsCopyBtn');
        const prev = btn.textContent;
        btn.textContent = 'Copié ✓';
        setTimeout(() => { btn.textContent = prev; }, 1500);
      } else {
        alert(val);
      }
    } catch (_) {
      alert(val);
    }
  });
}
if ($('wordsExportTxt')) {
  $('wordsExportTxt').addEventListener('click', () => {
    const input = $('wordsInput');
    const val = input ? input.value.trim() : '';
    if (!val) {
      alert('Aucun mot banni à exporter.');
      return;
    }
    const blob = new Blob([val + '\n'], { type: 'text/plain;charset=utf-8' });
    saveBlob(blob, 'refchat-mots-bannis-' + new Date().toISOString().slice(0, 10) + '.txt');
  });
}
if ($('wordsClearBtn')) {
  $('wordsClearBtn').addEventListener('click', () => {
    const input = $('wordsInput');
    if (!input || !input.value.trim()) return;
    if (confirm('Effacer tous les mots bannis ?')) {
      input.value = '';
      updateWordsCount('');
      input.focus();
    }
  });
}
const wordsModalEl = $('wordsModal');
if (wordsModalEl) {
  wordsModalEl.addEventListener('click', (e) => {
    if (e.target === wordsModalEl) closeWordsModal();
  });
}

if ($('addMuteBtn')) {
  $('addMuteBtn').addEventListener('click', () => {
    openMuteModal('', $('muteChan') ? $('muteChan').value : '');
  });
}
if ($('muteModalClose')) {
  $('muteModalClose').addEventListener('click', closeMuteModal);
}
if ($('muteModalCancel')) {
  $('muteModalCancel').addEventListener('click', closeMuteModal);
}
if ($('muteModalForm')) {
  $('muteModalForm').addEventListener('submit', async (ev) => {
    if (ev && ev.preventDefault) ev.preventDefault();
    const authorInput = $('muteModalAuthor');
    const raw = authorInput ? authorInput.value : '';
    const name = (raw || '').trim().toLowerCase().replace(/^@+/, '');
    const errBox = $('muteModalErr');
    if (!name) {
      if (errBox) {
        errBox.textContent = 'Veuillez saisir un pseudo valide.';
        errBox.classList.remove('hidden');
      }
      return;
    }
    const chan = $('muteModalChan') ? $('muteModalChan').value : '';
    const reason = ($('muteModalReason') && $('muteModalReason').value.trim()) || 'manuel';
    const perm = $('muteModalPerm') ? $('muteModalPerm').checked : true;
    const submitBtn = $('muteModalSubmit');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const res = await send({
        type: 'CSG_LOCAL_MUTE',
        author: name,
        score: 1,
        reason,
        channel: chan,
        perm
      });
      if (!res || res.ok === false) {
        if (errBox) {
          errBox.textContent = 'Le mute n’a pas été confirmé. Réessaie.';
          errBox.classList.remove('hidden');
        }
        return;
      }
      if (res.applied === false) {
        if (errBox) {
          errBox.textContent = 'Impossible de muter ' + name + ' (auteur déjà muté, dans la whitelist ou nom réservé).';
          errBox.classList.remove('hidden');
        }
        return;
      }
      const noteInput = $('muteModalNote');
      const noteText = noteInput ? noteInput.value.trim() : '';
      if (noteText) {
        await send({ type: 'CSG_AUTHOR_NOTE_SET', author: name, text: noteText });
        if (typeof authorNotesCache === 'undefined' || !authorNotesCache) authorNotesCache = {};
        authorNotesCache[name] = { text: noteText, ts: Date.now() };
      }
      if (typeof recordAuditAction === 'function') {
        recordAuditAction({
          type: 'mute',
          target: name,
          detail: (reason || 'manuel') + (perm ? ' (permanent)' : ''),
          channel: chan
        });
      }
      closeMuteModal();
      loadMutes();
    } catch (e) {
      if (errBox) {
        errBox.textContent = 'Erreur lors du mute : ' + String((e && e.message) || e);
        errBox.classList.remove('hidden');
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}
if ($('muteModalWhitelist')) {
  $('muteModalWhitelist').addEventListener('click', async () => {
    const authorInput = $('muteModalAuthor');
    const raw = authorInput ? authorInput.value : '';
    const name = (raw || '').trim().toLowerCase().replace(/^@+/, '');
    const errBox = $('muteModalErr');
    if (!name) {
      if (errBox) {
        errBox.textContent = 'Veuillez saisir un pseudo à protéger.';
        errBox.classList.remove('hidden');
      }
      return;
    }
    const btn = $('muteModalWhitelist');
    btn.disabled = true;
    try {
      await send({ type: 'CSG_WHITELIST', names: [name], on: true });
      const noteInput = $('muteModalNote');
      const noteText = noteInput ? noteInput.value.trim() : '';
      if (noteText) {
        await send({ type: 'CSG_AUTHOR_NOTE_SET', author: name, text: noteText });
        if (typeof authorNotesCache === 'undefined' || !authorNotesCache) authorNotesCache = {};
        authorNotesCache[name] = { text: noteText, ts: Date.now() };
      }
      if (typeof recordAuditAction === 'function') {
        recordAuditAction({
          type: 'whitelist',
          target: name,
          detail: 'protégé depuis modal mute'
        });
      }
      closeMuteModal();
      loadMutes();
    } catch (e) {
      if (errBox) {
        errBox.textContent = 'Erreur : ' + String((e && e.message) || e);
        errBox.classList.remove('hidden');
      }
    } finally {
      btn.disabled = false;
    }
  });
}
if ($('muteModalPresets')) {
  $('muteModalPresets').addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.preset-btn') : (e.target && e.target.classList && e.target.classList.contains('preset-btn') ? e.target : null);
    if (!btn || !btn.dataset || !btn.dataset.reason) return;
    if ($('muteModalReason')) {
      $('muteModalReason').value = btn.dataset.reason;
    }
    updateMuteModalPresetHighlights(btn.dataset.reason);
  });
}
if ($('muteModalReason')) {
  $('muteModalReason').addEventListener('input', () => {
    updateMuteModalPresetHighlights($('muteModalReason').value.trim());
  });
}
$('clearMutes').addEventListener('click', async () => {
  const n = Object.keys(mutedCache).length;
  if (!n || !confirm('Réhabiliter les ' + n + ' auteurs mutés ?')) return;
  await send({ type: 'CSG_MUTE_CLEAR' });
  loadMutes();
});

// -------------------------------------------------------------- dossier
// File des cas extrêmes (menaces, doxx, suicide bait, insultes graves)
// capturés par le service worker. Un dossier = un auteur × un chat. Le
// signalement reste MANUEL : on prépare le texte, Twitch n'a aucune API
// publique de report et un bot reporteur serait du brigading.
let repCache = {};
let repReloadT = null;
const repAuditing = new Set();
const repAuditErr = {};
let repBarBusy = false;

async function loadReports() {
  const res = await send({ type: 'CSG_REPORT_DUMP' });
  if (res && res.ok) repCache = res.reports || {};
  else {
    // Service worker endormi : lecture directe du stockage persisté.
    const v = await new Promise((r) => chrome.storage.local.get({ csg_reports: {} }, r));
    repCache = v.csg_reports || {};
  }
  if ($('repChan')) {
    const chans = new Set();
    for (const e of Object.values(repCache)) if (e && e.channel) chans.add(e.channel);
    if ($('repChan') && $('repChan').value) chans.add($('repChan').value);
    fillChanSelect($('repChan'), chans, true);
  }
  renderReports();
}

function loadReportsSoon() {
  if (repReloadT) return;
  repReloadT = setTimeout(() => {
    repReloadT = null;
    loadReports();
  }, 800);
}

function visibleReportKeys() {
  const q = $('repSearch').value.trim().toLowerCase();
  const platform = $('repPlatform') ? $('repPlatform').value : '';
  const showDone = $('repDone').checked;
  const chan = $('repChan') ? $('repChan').value : '';
  const verdict = $('repVerdict') ? $('repVerdict').value : '';
  return Object.entries(repCache)
    .filter(([_, e]) => e && (!q ||
      String(e.author || '').toLowerCase().includes(q) ||
      String(e.channel || '').toLowerCase().includes(q) ||
      (Array.isArray(e.msgs) && e.msgs.some((m) => String(m.text || '').toLowerCase().includes(q)))
    ))
    .filter(([_, e]) => !platform || splitChan(e.channel).site === platform)
    .filter(([_, e]) => !chan || e.channel === chan)
    .filter(([_, e]) => {
      if (!verdict) return true;
      if (verdict === 'report') return !!(e.audit && e.audit.report === true);
      if (verdict === 'fp') return !!(e.audit && e.audit.report === false);
      if (verdict === 'none') return !(e.audit && typeof e.audit.report === 'boolean');
      return true;
    })
    .filter(([_, e]) => showDone || !e.done)
    .sort((a, b) =>
      ((a[1].done ? 1 : 0) - (b[1].done ? 1 : 0)) ||
      ((b[1].lastAt || 0) - (a[1].lastAt || 0))
    )
    .map(([key]) => key);
}

async function auditReport(key) {
  if (!key || repAuditing.has(key)) return;
  repAuditing.add(key);
  delete repAuditErr[key];
  renderReports();
  const r = await send({ type: 'CSG_REPORT_AUDIT', key });
  repAuditing.delete(key);
  if (r && r.ok && r.entry) repCache[key] = r.entry;
  else repAuditErr[key] = (r && r.err) || 'échec de l’analyse (service worker endormi ?)';
  renderReports();
}

function splitSite(c) {
  const { site, name } = splitChan(c);
  return (site === 'kick' ? 'Kick' : 'Twitch') + (name ? ' · ' + name : '');
}

// Le texte prêt à coller dans le formulaire Twitch. Une seule pièce, un
// dossier par signalement : Twitch traite une plainte par auteur.
function dossierText(e) {
  const msgs = (e && e.msgs) || [];
  const first = e.firstAt ? new Date(e.firstAt) : null;
  const last = e.lastAt ? new Date(e.lastAt) : null;
  const fmt = (d) => d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const motif = Number(e.ext) > 0
    ? 'Attaque grave à vérifier (menace, préjudice, harcèlement, haine ou doxx)'
    : 'Ajout manuel — motif à vérifier avant signalement';
  const lines = [
    'Signalement — @' + (e.author || '?') + ' · chat ' + splitSite(e.channel),
    'Preuves sélectionnées dans Refchat — à relire avant tout signalement.',
    'Période : ' + (first && last ? fmt(first) + ' → ' + fmt(last) : fmt(last || first)) + ' · ' + accord(msgs.length, 'message capturé', 'messages capturés'),
    'Motif : ' + motif + '.'
  ];
  for (const m of msgs) {
    const when = m.ts ? new Date(m.ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—';
    const sc = m.score != null && Number.isFinite(Number(m.score)) ? ' · indice ' + filterIndex(m.score) : '';
    lines.push('[' + when + sc + '] ' + m.text);
  }
  return lines.join('\n');
}

function fillReportAudit(box, r, key) {
  box.textContent = '';
  if (!r) {
    box.className = 'audit hidden';
    return;
  }
  if (r.err && typeof r.report !== 'boolean') {
    box.className = 'audit err';
    const msg = document.createElement('span');
    msg.textContent = '⚠ ' + r.err;
    box.appendChild(msg);
    if (key) {
      const again = document.createElement('button');
      again.type = 'button';
      again.className = 'rep-audit-btn';
      again.textContent = 'Réanalyser';
      again.addEventListener('click', () => auditReport(key));
      box.appendChild(again);
    }
    return;
  }
  const report = !!r.report;
  box.className = 'audit ' + (report ? 'bad' : 'ok');
  const head = document.createElement('div');
  head.className = 'audit-head';
  const chip = document.createElement('span');
  chip.className = 'chip ' + (report ? 'mute' : 'keep');
  chip.textContent = report
    ? 'à signaler' + (r.kind && r.kind !== 'faux-positif' ? ' · ' + r.kind : '')
    : 'faux positif';
  head.appendChild(chip);
  const sc = document.createElement('b');
  sc.textContent = filterIndex(r.score);
  sc.title = FILTER_INDEX_HINT;
  head.appendChild(sc);
  const meta = document.createElement('small');
  const web = r.web || {};
  meta.textContent =
    (r.model || 'juge') +
    ' · raisonnement ' + (r.effort || '?') +
    (web.on
      ? web.searched
        ? ' · ' + web.searched + ' recherche' + (web.searched > 1 ? 's' : '') + ' web'
        : ' · web dispo, non utilisé'
      : ' · sans web');
  head.appendChild(meta);
  box.appendChild(head);
  if (r.why) {
    const p = document.createElement('p');
    p.className = 'audit-why';
    p.textContent = r.why;
    box.appendChild(p);
  }
  if (r.evidence && r.evidence.length) {
    const h = document.createElement('div');
    h.className = 'audit-ev-h';
    h.textContent = 'Preuves citées';
    box.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'audit-ev';
    for (const ev of r.evidence) {
      const li = document.createElement('li');
      li.textContent = ev;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  if (web.sources && web.sources.length) {
    const h = document.createElement('div');
    h.className = 'audit-ev-h';
    h.textContent = 'Sources consultées';
    box.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'audit-ev';
    for (const s of web.sources) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      a.textContent = s.title || s.url;
      li.appendChild(a);
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  if (key) {
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'rep-audit-btn';
    again.disabled = repAuditing.has(key);
    again.textContent = again.disabled ? 'Analyse…' : 'Réanalyser';
    again.addEventListener('click', () => auditReport(key));
    box.appendChild(again);
  }
}

async function copyReport(e, btn) {
  const txt = dossierText(e);
  let ok = true;
  try {
    await navigator.clipboard.writeText(txt);
  } catch (_) {
    ok = false;
  }
  if (!ok && btn) {
    // Presse-papier refusé (contexte non focalisé) : on ne perd pas le dossier,
    // on le télécharge comme les exports du journal.
    const blob = new Blob([txt + '\n'], { type: 'text/plain;charset=utf-8' });
    saveBlob(blob, 'refchat-dossier-' + (e.author || 'auteur') + '-' + new Date().toISOString().slice(0, 10) + '.txt');
  }
  if (btn) {
    const was = btn.textContent;
    btn.textContent = ok ? 'Copié ✓' : 'Téléchargé';
    setTimeout(() => {
      btn.textContent = was;
    }, 1500);
  }
}

function renderReports() {
  const q = $('repSearch').value.trim().toLowerCase();
  const platform = $('repPlatform') ? $('repPlatform').value : '';
  const showDone = $('repDone').checked;
  const chan = $('repChan') ? $('repChan').value : '';
  const verdict = $('repVerdict') ? $('repVerdict').value : '';
  const entries = Object.entries(repCache)
    .filter(([key, e]) => e && (!q ||
      String(e.author || '').toLowerCase().includes(q) ||
      String(e.channel || '').toLowerCase().includes(q) ||
      (Array.isArray(e.msgs) && e.msgs.some((m) => String(m.text || '').toLowerCase().includes(q)))
    ))
    .filter(([key, e]) => !platform || splitChan(e.channel).site === platform)
    .filter(([key, e]) => !chan || e.channel === chan)
    .filter(([key, e]) => {
      if (!verdict) return true;
      if (verdict === 'report') return !!(e.audit && e.audit.report === true);
      if (verdict === 'fp') return !!(e.audit && e.audit.report === false);
      if (verdict === 'none') return !(e.audit && typeof e.audit.report === 'boolean');
      return true;
    })
    .sort((a, b) =>
      ((a[1].done ? 1 : 0) - (b[1].done ? 1 : 0)) ||
      ((b[1].lastAt || 0) - (a[1].lastAt || 0))
    );
  const all = Object.values(repCache).filter(Boolean);
  const todo = all.filter((e) => !e.done).length;
  const msgs = all.reduce((s, e) => s + ((e.msgs && e.msgs.length) || 0), 0);
  $('cReports').textContent = String(todo);
  $('cReports').classList.toggle('warn', todo > 0);
  const tabBadge = $('cReportsTab');
  if (tabBadge) {
    tabBadge.textContent = String(todo);
    tabBadge.classList.toggle('hidden', todo <= 0);
    tabBadge.classList.toggle('warn', todo > 0);
  }
  $('repCount').textContent =
    todo + ' dossier' + (todo > 1 ? 's' : '') + ' à examiner · ' + msgs + ' preuve' + (msgs > 1 ? 's' : '') + (all.length - todo ? ' · ' + (all.length - todo) + ' fait' + (all.length - todo > 1 ? 's' : '') : '');
  const box = $('repCards');
  box.textContent = '';
  // Les dossiers faits sont écartés ici, pas plus bas : sinon la liste est vide
  // et le message « aucun dossier » reste masqué.
  const visible = entries.filter((pair) => showDone || !pair[1].done);
  $('repEmpty').style.display = visible.length ? 'none' : '';
  $('repEmpty').textContent = all.length ? 'Aucun dossier ne correspond au filtre.' : 'Aucun cas extrême en attente.';
  for (const [key, e] of visible) {
    const card = document.createElement('div');
    card.className = 'card rep-card' + (e.done ? ' rep-done' : '');

    const h = document.createElement('h3');
    const who = document.createElement('span');
    who.className = 'who bad rep-who';
    who.textContent = '@' + (e.author || '?');
    who.style.cursor = 'pointer';
    who.title = 'Voir tout l’historique de cet auteur';
    who.addEventListener('click', () => {
      $('authorQuery').value = e.author || '';
      goTab('author');
      showAuthor(e.author || '');
    });
    h.appendChild(who);
    h.appendChild(chanChip(e.channel));
    const authorKey = (e.author || '').trim().toLowerCase();
    const isMuted = typeof mutedCache !== 'undefined' && mutedCache && !!mutedCache[authorKey];
    if (isMuted) {
      const muteChip = document.createElement('span');
      muteChip.className = 'chip mute';
      muteChip.textContent = 'muté';
      muteChip.style.fontSize = '10px';
      muteChip.title = 'Cet auteur fait déjà l’objet d’une sanction active';
      h.appendChild(muteChip);
    }
    if (e.audit && typeof e.audit.report === 'boolean') {
      const chip = document.createElement('span');
      chip.className = 'chip ' + (e.audit.report ? 'mute' : 'keep');
      chip.textContent = e.audit.report ? 'à signaler' : 'faux positif';
      h.appendChild(chip);
    }
    card.appendChild(h);

    const acts = document.createElement('div');
    acts.className = 'rep-acts';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copier le dossier';
    copy.addEventListener('click', () => copyReport(e, copy));

    const site = (typeof splitChan === 'function' ? splitChan(e.channel).site : (String(e.channel || '').startsWith('kick/') ? 'kick' : 'twitch'));
    const isKick = site === 'kick';
    const signal = document.createElement('button');
    signal.type = 'button';
    signal.textContent = isKick ? 'Signaler à Kick' : 'Signaler à Twitch';
    signal.title = isKick ? 'Copie le dossier puis ouvre les règles de modération Kick.' : 'Copie le dossier puis ouvre le formulaire officiel Twitch.';
    signal.addEventListener('click', async () => {
      if (e.audit && e.audit.report === false) {
        if (!confirm('L’analyse 1.3 a classé ce dossier en faux positif.\nOuvrir le formulaire quand même ?')) return;
      }
      await copyReport(e, copy);
      window.open(isKick ? 'https://kick.com/community-guidelines' : 'https://help.twitch.tv/s/twitch-user-report', '_blank');
    });

    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = isMuted ? 'ghost small' : 'danger small';
    muteBtn.textContent = isMuted ? 'Sanctionné' : 'Muter';
    muteBtn.title = isMuted ? 'L’auteur est déjà sanctionné. Cliquez pour ouvrir la liste des mutés.' : 'Ouvrir la boîte de dialogue pour muter cet auteur.';
    muteBtn.addEventListener('click', () => {
      if (isMuted) {
        if ($('muteSearch')) $('muteSearch').value = e.author || '';
        goTab('mutes');
        if (typeof refilterMutes === 'function') refilterMutes();
      } else {
        if (typeof openMuteModal === 'function') {
          openMuteModal(e.author, e.channel);
          if ($('muteModalReason')) {
            $('muteModalReason').value = 'signalement' + ((e.audit && e.audit.reason) ? ': ' + e.audit.reason : '');
          }
        }
      }
    });

    const analyze = document.createElement('button');
    analyze.type = 'button';
    analyze.className = 'rep-audit-btn';
    const busy = repAuditing.has(key);
    analyze.textContent = busy ? 'Analyse… (jusqu’à 2 min)' : (e.audit ? 'Réanalyser' : 'Analyser (1.3)');
    analyze.disabled = busy;
    analyze.title = 'Le modèle choisi relit les preuves. Manuel, jusqu’à 2 min. Ne signale rien tout seul.';
    analyze.addEventListener('click', () => auditReport(key));
    const done = document.createElement('button');
    done.type = 'button';
    done.textContent = e.done ? 'Refaire' : 'Fait';
    done.title = e.done ? 'Remettre dans la pile à signaler' : 'Signalé — passe en fond de pile';
    done.addEventListener('click', async () => {
      await send({ type: 'CSG_REPORT_DONE', key, done: e.done ? 0 : 1 });
      loadReports();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Retirer';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      await send({ type: 'CSG_REPORT_REMOVE', key });
      loadReports();
    });
    const dossierBtn = document.createElement('button');
    dossierBtn.type = 'button';
    dossierBtn.className = 'rep-dossier-btn';
    dossierBtn.textContent = 'Dossier';
    dossierBtn.title = 'Inspecter le dossier complet et l’historique de cet auteur';
    dossierBtn.addEventListener('click', () => {
      $('authorQuery').value = e.author || '';
      goTab('author');
      showAuthor(e.author || '');
    });
    acts.appendChild(analyze);
    acts.appendChild(copy);
    acts.appendChild(signal);
    acts.appendChild(muteBtn);
    acts.appendChild(done);
    acts.appendChild(remove);
    acts.appendChild(dossierBtn);
    card.appendChild(acts);

    if (repAuditErr[key] || e.audit) {
      const auditBox = document.createElement('div');
      fillReportAudit(auditBox, repAuditErr[key] ? { err: repAuditErr[key] } : e.audit, key);
      card.appendChild(auditBox);
    }

    const list = document.createElement('div');
    list.className = 'rep-msgs';
    for (const m of (e.msgs || []).slice().reverse()) {
      const d = document.createElement('div');
      d.className = 'am';
      const at = document.createElement('div');
      at.className = 'at';
      at.textContent = (m.ts ? new Date(m.ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
      if (m.score != null && Number.isFinite(Number(m.score))) {
        const s = document.createElement('span');
        s.className = 'rep-sc';
        s.textContent = ' · indice ' + filterIndex(m.score);
        s.title = FILTER_INDEX_HINT + (m.src ? ' · source ' + m.src : '');
        at.appendChild(s);
      } else if (m.src) {
        const s = document.createElement('span');
        s.textContent = ' · ' + m.src;
        at.appendChild(s);
      }
      const t = document.createElement('div');
      t.className = 't streamer-redact';
      t.textContent = m.text || '';
      d.appendChild(at);
      d.appendChild(t);
      list.appendChild(d);
    }
    card.appendChild(list);
    box.appendChild(card);
  }
  if (!repBarBusy) {
    const bar = $('repAudit');
    bar.disabled = !visibleReportKeys().length;
  }
}

$('repSearch').addEventListener('input', renderReports);
if ($('repPlatform')) $('repPlatform').addEventListener('change', renderReports);
if ($('repChan')) $('repChan').addEventListener('change', renderReports);
if ($('repVerdict')) $('repVerdict').addEventListener('change', renderReports);
$('repDone').addEventListener('change', renderReports);
$('repAudit').addEventListener('click', async () => {
  const keys = visibleReportKeys();
  if (!keys.length) return;
  const b = $('repAudit');
  repBarBusy = true;
  b.disabled = true;
  try {
    for (let i = 0; i < keys.length; i++) {
      b.textContent = 'Analyse… ' + (i + 1) + '/' + keys.length;
      await auditReport(keys[i]);
    }
  } finally {
    repBarBusy = false;
    b.disabled = !visibleReportKeys().length;
    b.textContent = 'Réanalyser (1.3)';
  }
});
if ($('repCopyNames')) {
  $('repCopyNames').addEventListener('click', async () => {
    const keys = visibleReportKeys();
    const names = Array.from(new Set(keys.map((k) => (repCache[k] && repCache[k].author) || '').filter(Boolean))).sort();
    if (!names.length) return;
    try {
      await navigator.clipboard.writeText(names.join('\n'));
      $('repCopyNames').textContent = '✓ ' + names.length + ' copiés';
    } catch (_) {
      downloadJsonl(names, 'csg-report-pseudos');
      $('repCopyNames').textContent = 'Téléchargé';
    }
    setTimeout(() => {
      if ($('repCopyNames')) $('repCopyNames').textContent = 'Copier pseudos';
    }, 1500);
  });
}
$('repCopyAll').addEventListener('click', async () => {
  const showDone = $('repDone').checked;
  const keys = visibleReportKeys();
  const list = keys.map((k) => repCache[k]).filter((e) => e && (showDone || !e.done));
  if (!list.length) return;
  const txt = list.map(dossierText).join('\n\n' + '———'.repeat(12) + '\n\n');
  try {
    await navigator.clipboard.writeText(txt);
    $('repCopyAll').textContent = 'Copié ✓';
  } catch (_) {
    downloadJsonl(list, 'csg-dossiers');
    $('repCopyAll').textContent = 'Téléchargé';
  }
  setTimeout(() => {
    if ($('repCopyAll')) $('repCopyAll').textContent = 'Tout copier';
  }, 1500);
});
if ($('repMarkAllDone')) {
  $('repMarkAllDone').addEventListener('click', async () => {
    const keys = visibleReportKeys().filter((k) => repCache[k] && !repCache[k].done);
    if (!keys.length) {
      alert('Aucun dossier non fait parmi les dossiers visibles.');
      return;
    }
    if (!confirm('Marquer ' + keys.length + ' dossier' + (keys.length > 1 ? 's' : '') + ' comme fait' + (keys.length > 1 ? 's' : '') + ' ?')) {
      return;
    }
    await Promise.all(keys.map((k) => send({ type: 'CSG_REPORT_DONE', key: k, done: 1 })));
    loadReports();
  });
}
if ($('repExportCsv')) {
  $('repExportCsv').addEventListener('click', () => {
    const keys = visibleReportKeys();
    if (!keys.length) {
      alert('Aucun dossier ne correspond au filtre.');
      return;
    }
    const headers = [
      'Date_Dernier_Message',
      'Date_Premier_Message',
      'Pseudo',
      'Chat',
      'Plateforme',
      'Statut',
      'Verdict_IA',
      'Motif',
      'Nb_Preuves',
      'Messages_Preuves'
    ];
    const data = keys.map((key) => {
      const e = repCache[key] || {};
      const msgs = e.msgs || [];
      const proofs = msgs
        .map((m) => '[' + (m.ts ? new Date(m.ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—') + '] ' + String(m.text || '').replace(/\r?\n/g, ' ') + (m.score != null ? ' (indice ' + m.score + ')' : ''))
        .join(' | ');
      const verdict = e.audit && typeof e.audit.report === 'boolean'
        ? (e.audit.report ? 'À signaler' : 'Faux positif')
        : 'Non audité';
      return [
        e.lastAt ? new Date(e.lastAt).toLocaleString('fr-FR') : '',
        e.firstAt ? new Date(e.firstAt).toLocaleString('fr-FR') : '',
        e.author || '',
        e.channel || '',
        splitSite(e.channel || ''),
        e.done ? 'Fait' : 'À examiner',
        verdict,
        Number(e.ext) > 0 ? 'Attaque grave détectée' : 'Ajout manuel',
        msgs.length,
        proofs
      ];
    });
    downloadCsv(headers, data, 'csg-signalements');
  });
}
if ($('repExportJson')) {
  $('repExportJson').addEventListener('click', () => {
    const keys = visibleReportKeys();
    if (!keys.length) {
      alert('Aucun dossier ne correspond au filtre.');
      return;
    }
    const list = keys.map((k) => {
      const e = repCache[k];
      if (!e) return null;
      return {
        key: k,
        author: e.author || '',
        channel: e.channel || '',
        platform: splitSite(e.channel || ''),
        done: !!e.done,
        firstAt: e.firstAt || null,
        lastAt: e.lastAt || null,
        ext: e.ext || 0,
        audit: e.audit || null,
        messages: (e.msgs || []).map((m) => ({
          ts: m.ts || null,
          text: m.text || '',
          score: m.score != null ? m.score : null
        }))
      };
    }).filter(Boolean);
    downloadJson(list, 'csg-signalements');
  });
}
$('repClear').addEventListener('click', async () => {
  const n = Object.keys(repCache).length;
  if (!n || !confirm('Vider le dossier ?\n\nLes ' + n + ' entrées disparaissent de la file — l’archive du journal, elle, garde tout.')) return;
  await send({ type: 'CSG_REPORT_CLEAR' });
  loadReports();
});
if ($('repAddManual')) {
  $('repAddManual').addEventListener('click', async () => {
    const ask = typeof window !== 'undefined' && typeof window.prompt === 'function' ? window.prompt : (typeof prompt === 'function' ? prompt : null);
    const author = ask ? ask('Pseudo de l’auteur à ajouter aux signalements (recherche ses rejets récents) :') : null;
    if (!author || !author.trim()) return;
    const key = author.trim();
    $('repAddManual').disabled = true;
    const res = await send({ type: 'CSG_REPORT_ADD', author: key });
    $('repAddManual').disabled = false;
    if (res && res.ok) {
      await loadReports();
      if ($('repSearch')) $('repSearch').value = key;
      renderReports();
    } else {
      if (typeof alert === 'function') alert(res && res.err ? 'Impossible d’ajouter : ' + res.err : 'Aucun message rejeté en mémoire pour cet auteur.');
    }
  });
}

// ---------------------------------------------------------------- journal
let logCache = [];
let logTotal = 0;
let logLoading = false;
const LOG_PAGE_SIZE = 100;
let logPage = 0;
let logReadingCache = null;
let logReadingTotal = 0;

function setLogAutoRefresh(follow) {
  $('logAutoRefresh').checked = follow;
  const dot = $('logLiveDot');
  if (dot) {
    if (dot.classList && typeof dot.classList.toggle === 'function') dot.classList.toggle('paused', !follow);
    dot.title = follow ? 'Flux en direct actif' : 'Actualisation en pause';
  }
  if (follow) {
    logReadingCache = null;
    logPage = 0;
  } else if (!logReadingCache) {
    // Keep the same rows while reading, even if another tab refreshes its data.
    logReadingCache = logCache;
    logReadingTotal = logTotal;
  }
}

async function loadLog() {
  if (logLoading) return;
  logLoading = true;
  const res = await send({ type: 'CSG_FT_DUMP' });
  logLoading = false;
  if (res && res.ok && Array.isArray(res.log)) {
    logCache = res.log;
    logTotal = Number(res.total) || logCache.length;
  } else {
    // Service worker endormi : on lit la fenêtre persistée.
    const v = await new Promise((r) => chrome.storage.local.get({ csg_ft_log: [] }, r));
    logCache = Array.isArray(v.csg_ft_log) ? v.csg_ft_log : [];
    logTotal = logCache.length;
  }
  const chans = new Set();
  for (const row of logReadingCache || logCache) if (row && row.channel) chans.add(row.channel);
  if ($('logChan') && $('logChan').value) chans.add($('logChan').value);
  fillChanSelect($('logChan'), chans, true);
  renderLog();
  renderChats();
}

function rowLabel(row) {
  if (row && row.codexJudged) return row.codexVerdict === 'mute' ? 'review' : 'keep';
  return String((row && (row.label || row.verdict)) || 'pending').toLowerCase();
}

function highlightText(container, text, query) {
  if (!query || !text || !document.createTextNode) {
    container.textContent = text || '';
    return;
  }
  const str = String(text);
  const qLower = query.toLowerCase();
  const firstIdx = str.toLowerCase().indexOf(qLower);
  if (firstIdx === -1) {
    container.textContent = str;
    return;
  }
  container.textContent = '';
  let cur = 0;
  while (cur < str.length) {
    const next = str.toLowerCase().indexOf(qLower, cur);
    if (next === -1) {
      container.appendChild(document.createTextNode(str.slice(cur)));
      break;
    }
    if (next > cur) {
      container.appendChild(document.createTextNode(str.slice(cur, next)));
    }
    const mark = document.createElement('mark');
    mark.className = 'hl';
    mark.textContent = str.slice(next, next + query.length);
    container.appendChild(mark);
    cur = next + query.length;
  }
}

function renderLog() {
  const cache = logReadingCache || logCache;
  const total = logReadingCache ? logReadingTotal : logTotal;
  const q = $('logSearch').value.trim().toLowerCase();
  const platform = $('logPlatform') ? $('logPlatform').value : '';
  const chan = $('logChan').value;
  const lab = $('logLabel').value;
  const time = $('logTime') ? $('logTime').value : '';
  const now = Date.now();
  let timeLimit = 0;
  if (time === '15m') timeLimit = now - 15 * 60 * 1000;
  else if (time === '1h') timeLimit = now - 60 * 60 * 1000;
  else if (time === '24h') timeLimit = now - 24 * 60 * 60 * 1000;

  const matching = [];
  for (let i = cache.length - 1; i >= 0; i--) {
    const r = cache[i];
    if (!r) continue;
    if (platform && splitChan(r.channel).site !== platform) continue;
    if (chan && r.channel !== chan) continue;
    if (timeLimit && (!r.ts || r.ts < timeLimit)) continue;
    if (lab === 'politique') {
      if (String(r.source || '') !== 'politique' && rowLabel(r) !== 'politique') continue;
    } else if (lab && rowLabel(r) !== lab) continue;
    if (q && !(
      String(r.text || '').toLowerCase().includes(q) ||
      String(r.author || '').toLowerCase().includes(q) ||
      (typeof authorNotesCache !== 'undefined' && authorNotesCache && authorNotesCache[(r.author || '').toLowerCase()] && authorNotesCache[(r.author || '').toLowerCase()].text.toLowerCase().includes(q))
    )) continue;
    matching.push(r);
  }
  const pageCount = Math.max(1, Math.ceil(matching.length / LOG_PAGE_SIZE));
  logPage = Math.min(logPage, pageCount - 1);
  const start = logPage * LOG_PAGE_SIZE;
  const rows = matching.slice(start, start + LOG_PAGE_SIZE);
  $('cLog').textContent = String(logCache.length);
  $('logMeta').textContent =
    (cache.length === 1 ? '1 message' : cache.length + ' messages') + ' en mémoire' + (total > cache.length ? ' · ' + total + ' vus au total' : '') +
    (q || platform || chan || lab || time ? ' · ' + matching.length + ' correspondent aux filtres' : '') +
    (logReadingCache ? ' · actualisation en pause' : '');
  $('logPage').textContent = matching.length ? (start + 1) + '–' + (start + rows.length) + ' sur ' + matching.length : '0 résultat';
  $('logNewer').disabled = logPage === 0;
  $('logOlder').disabled = logPage >= pageCount - 1;
  const jumpBtn = $('logJumpLive');
  if (jumpBtn && jumpBtn.classList) {
    if (logPage > 0) jumpBtn.classList.remove('hidden');
    else jumpBtn.classList.add('hidden');
  }
  let cMute = 0, cKeep = 0, cReview = 0, cPending = 0, cSkip = 0, cDropped = 0, cPol = 0;
  for (const r of matching) {
    const lbl = rowLabel(r);
    if (lbl === 'mute') cMute++;
    else if (lbl === 'keep') cKeep++;
    else if (lbl === 'review') cReview++;
    else if (lbl === 'skip') cSkip++;
    else if (lbl === 'dropped') cDropped++;
    else if (lbl !== 'politique') cPending++;
    if (String(r.source || '') === 'politique' || lbl === 'politique') cPol++;
  }
  const statEl = $('logStats');
  if (statEl) {
    if (matching.length) {
      // Le pourcentage ne compte que les lignes jugées. Une ligne en attente,
      // ignorée ou abandonnée n'est pas un accept : « 0 rejeté (0 %) » faisait
      // croire que le filtre avait tout lu.
      const decided = cMute + cKeep + cReview;
      const parts = [];
      if (decided) {
        const pct = Math.round((cMute / decided) * 100);
        parts.push(cMute + ' rejeté' + (cMute > 1 ? 's' : '') + ' (' + pct + '%)');
        parts.push(cKeep + ' accepté' + (cKeep > 1 ? 's' : ''));
        if (cReview) parts.push(cReview + ' signalé' + (cReview > 1 ? 's' : ''));
      }
      if (cPending) parts.push(cPending + ' en attente');
      if (cSkip) parts.push(cSkip + ' ignoré' + (cSkip > 1 ? 's' : ''));
      if (cDropped) parts.push(cDropped + ' abandonné' + (cDropped > 1 ? 's' : ''));
      if (cPol) parts.push(cPol + ' pol');
      statEl.textContent = parts.join(' · ');
    } else {
      statEl.textContent = '';
    }
  }
  const body = $('logRows');
  body.textContent = '';
  $('logEmpty').style.display = rows.length ? 'none' : '';
  $('logEmpty').textContent = cache.length ? 'Aucun message ne correspond aux filtres.' : 'Aucun message capturé pour le moment.';
  for (const r of rows) {
    const tr = document.createElement('tr');
    const lbl = rowLabel(r);
    tr.dataset.label = lbl;
    tr.appendChild(td(r.ts ? new Date(r.ts).toLocaleTimeString() : '—', 'num'));
    const chip = chanChip(r.channel);
    if (chip && chip.addEventListener) {
      chip.style.cursor = 'pointer';
      chip.title = 'Filtrer le journal sur ce chat';
      chip.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if ($('logChan')) {
          $('logChan').value = r.channel || '';
          refilterLog();
        }
      });
    }
    tr.appendChild(td(chip));
    const who = td(r.author || '?', 'who' + (rowLabel(r) === 'mute' ? ' bad' : ''));
    who.style.cursor = 'pointer';
    who.title = 'Clic : voir le dossier · Alt+clic : filtrer · Clic droit : muter';
    who.addEventListener('click', (e) => {
      if (e && e.altKey) {
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        $('logSearch').value = r.author || '';
        refilterLog();
        return;
      }
      $('authorQuery').value = r.author || '';
      goTab('author');
      showAuthor(r.author || '');
    });
    who.addEventListener('contextmenu', (e) => {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      openMuteModal(r.author || '', r.channel || '');
    });
    if (typeof authorNotesCache !== 'undefined' && authorNotesCache && authorNotesCache[(r.author || '').toLowerCase()]) {
      const noteBadge = document.createElement('span');
      noteBadge.className = 'chip';
      noteBadge.style.fontSize = '9px';
      noteBadge.style.marginLeft = '4px';
      noteBadge.style.padding = '0 3px';
      noteBadge.textContent = '📝';
      noteBadge.title = 'Note : ' + authorNotesCache[(r.author || '').toLowerCase()].text;
      who.appendChild(noteBadge);
    }
    tr.appendChild(who);
    const txtCell = td(r.text || '', 'txt');
    if (lbl === 'mute') txtCell.classList.add('streamer-redact');
    if (q && document.createTextNode && typeof r.text === 'string' && r.text.toLowerCase().includes(q)) {
      highlightText(txtCell, r.text, q);
    }
    txtCell.title = 'Double-clic pour copier le texte';
    txtCell.addEventListener('dblclick', async (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(r.text || '');
        }
      } catch (_) {}
    });
    tr.appendChild(txtCell);
    tr.appendChild(td(labelChip(rowLabel(r), r.codexJudged ? 'codex' : r.source)));
    tr.appendChild(td(r.codexJudged ? 'Codex · ' + (r.codexReason || 'jugé') :
      (r.source || '') + (r.score != null && r.score !== '' ? ' · indice ' + filterIndex(r.score) : ''), 'num'));
    body.appendChild(tr);
  }
}

function updateLogPresets() {
  if (typeof document.querySelectorAll !== 'function') return;
  const lab = $('logLabel') ? $('logLabel').value : '';
  const time = $('logTime') ? $('logTime').value : '';
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    const p = btn.dataset ? btn.dataset.preset : (btn.getAttribute && btn.getAttribute('data-preset'));
    let active = false;
    if (p === 'all') active = !lab && !time;
    else if (p === 'mute') active = lab === 'mute';
    else if (p === 'review') active = lab === 'review';
    else if (p === 'pol') active = lab === 'politique';
    else if (p === '15m') active = time === '15m';
    else if (p === '1h') active = time === '1h';
    if (btn.classList && typeof btn.classList.toggle === 'function') {
      btn.classList.toggle('on', active);
    }
  });
}

function refilterLog() {
  logPage = 0;
  updateLogPresets();
  renderLog();
}
$('logSearch').addEventListener('input', refilterLog);
if ($('logPlatform')) $('logPlatform').addEventListener('change', refilterLog);
$('logChan').addEventListener('change', refilterLog);
$('logLabel').addEventListener('change', refilterLog);
if ($('logTime')) $('logTime').addEventListener('change', refilterLog);
if ($('logReset')) {
  $('logReset').addEventListener('click', () => {
    $('logSearch').value = '';
    if ($('logPlatform')) $('logPlatform').value = '';
    $('logChan').value = '';
    $('logLabel').value = '';
    if ($('logTime')) $('logTime').value = '';
    refilterLog();
  });
}
$('logOlder').addEventListener('click', () => {
  setLogAutoRefresh(false);
  logPage++;
  renderLog();
});
$('logNewer').addEventListener('click', () => {
  logPage = Math.max(0, logPage - 1);
  renderLog();
});
$('logAutoRefresh').addEventListener('change', () => {
  setLogAutoRefresh($('logAutoRefresh').checked);
  renderLog();
  if ($('logAutoRefresh').checked) loadLog();
});
if (typeof document.querySelectorAll === 'function') {
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.dataset ? btn.dataset.preset : (btn.getAttribute && btn.getAttribute('data-preset'));
      if (p === 'all') {
        if ($('logLabel')) $('logLabel').value = '';
        if ($('logTime')) $('logTime').value = '';
      } else if (p === 'mute' || p === 'review' || p === 'pol') {
        if ($('logLabel')) $('logLabel').value = p === 'pol' ? 'politique' : p;
      } else if (p === '15m' || p === '1h') {
        if ($('logTime')) $('logTime').value = p;
      }
      refilterLog();
    });
  });
}
if ($('logJumpLive')) {
  $('logJumpLive').addEventListener('click', () => {
    logPage = 0;
    setLogAutoRefresh(true);
    renderLog();
    loadLog();
  });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Hors du document, Chrome ignore souvent l'attribut download.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function downloadJsonl(rows, prefix) {
  const jsonl = (Array.isArray(rows) ? rows : []).map((row) => JSON.stringify(row)).join('\n');
  const blob = new Blob([jsonl ? jsonl + '\n' : ''], { type: 'application/jsonl;charset=utf-8' });
  saveBlob(blob, prefix + '-' + new Date().toISOString().slice(0, 10) + '.jsonl');
}

function escapeCsv(val) {
  if (val == null) return '';
  const s = String(val);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function downloadCsv(headers, rows, prefix) {
  let csv = '\uFEFF' + headers.map(escapeCsv).join(',') + '\r\n';
  for (const r of rows) {
    csv += r.map(escapeCsv).join(',') + '\r\n';
  }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  saveBlob(blob, prefix + '-' + new Date().toISOString().slice(0, 10) + '.csv');
}

function downloadJson(data, prefix) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json ? json + '\n' : ''], { type: 'application/json;charset=utf-8' });
  saveBlob(blob, prefix + '-' + new Date().toISOString().slice(0, 10) + '.json');
}

function getFilteredLogRows() {
  const cache = logReadingCache || logCache;
  const q = $('logSearch').value.trim().toLowerCase();
  const platform = $('logPlatform') ? $('logPlatform').value : '';
  const chan = $('logChan').value;
  const lab = $('logLabel').value;
  const time = $('logTime') ? $('logTime').value : '';
  const now = Date.now();
  let timeLimit = 0;
  if (time === '15m') timeLimit = now - 15 * 60 * 1000;
  else if (time === '1h') timeLimit = now - 60 * 60 * 1000;
  else if (time === '24h') timeLimit = now - 24 * 60 * 60 * 1000;

  const matching = [];
  for (let i = cache.length - 1; i >= 0; i--) {
    const r = cache[i];
    if (!r) continue;
    if (platform && splitChan(r.channel).site !== platform) continue;
    if (chan && r.channel !== chan) continue;
    if (timeLimit && (!r.ts || r.ts < timeLimit)) continue;
    if (lab === 'politique') {
      if (String(r.source || '') !== 'politique' && rowLabel(r) !== 'politique') continue;
    } else if (lab && rowLabel(r) !== lab) continue;
    if (q && !(String(r.text || '').toLowerCase().includes(q) || String(r.author || '').toLowerCase().includes(q))) continue;
    matching.push(r);
  }
  return matching;
}

function formatLogCsvRows(rows) {
  const headers = ['Date_Heure', 'Horodatage_ms', 'Chat', 'Auteur', 'Message', 'Verdict', 'Source', 'Indice', 'Raison_Codex'];
  const data = (Array.isArray(rows) ? rows : []).map((r) => [
    r.ts ? new Date(r.ts).toLocaleString('fr-FR') : '',
    r.ts || '',
    r.channel || '',
    r.author || '',
    r.text || '',
    rowLabel(r),
    r.source || '',
    r.score != null && r.score !== '' ? filterIndex(r.score) : '',
    r.codexReason || ''
  ]);
  return { headers, data };
}

$('exportFt').addEventListener('click', async () => {
  // full: archive complète, pas seulement la fenêtre mémoire.
  const res = await send({ type: 'CSG_FT_DUMP', full: true });
  downloadJsonl(res && res.ok ? res.log : logCache, 'csg-moderation');
});
if ($('exportCsv')) {
  $('exportCsv').addEventListener('click', async () => {
    const res = await send({ type: 'CSG_FT_DUMP', full: true });
    const rows = res && res.ok && Array.isArray(res.log) ? res.log : logCache;
    const { headers, data } = formatLogCsvRows(rows);
    downloadCsv(headers, data, 'csg-moderation');
  });
}
if ($('exportFiltered')) {
  $('exportFiltered').addEventListener('click', () => {
    const rows = getFilteredLogRows();
    if (!rows.length) {
      alert('Aucun message ne correspond aux filtres actuels.');
      return;
    }
    const { headers, data } = formatLogCsvRows(rows);
    downloadCsv(headers, data, 'csg-moderation-selection');
  });
}
$('exportBeh').addEventListener('click', async () => {
  const res = await send({ type: 'CSG_BEH_DUMP' });
  if (res && res.ok) return downloadJsonl(res.log, 'csg-behavior');
  chrome.storage.local.get({ csg_beh_log: [] }, (v) => downloadJsonl(v.csg_beh_log, 'csg-behavior'));
});
$('clearFt').addEventListener('click', async () => {
  if (!confirm('Vider l’affichage du journal ?\n\nLes messages ne sont pas supprimés : ils partent à l’archive, puis sur le disque.')) return;
  await send({ type: 'CSG_FT_CLEAR' });
  loadLog();
});

// ---------------------------------------------------------------- par chat
let lastRenderedChans = [];
function renderChats() {
  const by = new Map();
  for (const r of logCache) {
    if (!r) continue;
    const c = r.channel || '';
    let s = by.get(c);
    if (!s) by.set(c, (s = { total: 0, mute: 0, keep: 0, review: 0, pending: 0, dropped: 0, skip: 0, authors: new Map(), last: 0 }));
    s.total += 1;
    const l = rowLabel(r);
    if (l === 'mute') {
      s.mute += 1;
      const a = String(r.author || '?').toLowerCase();
      s.authors.set(a, (s.authors.get(a) || 0) + 1);
    } else if (l === 'keep') s.keep += 1;
    else if (l === 'review') s.review += 1;
    // Les abandonnés ne sont pas « en attente » : les compter comme tels
    // gonflerait indéfiniment le pending d'un chat qui a connu une hype.
    else if (l === 'dropped') s.dropped += 1;
    else if (l === 'skip') s.skip += 1;
    else s.pending += 1;
    if (r.ts > s.last) s.last = r.ts;
  }
  const box = $('chatCards');
  box.textContent = '';
  if (!by.size) {
    lastRenderedChans = [];
    if ($('chatCount')) $('chatCount').textContent = '0 chats';
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Aucun message encore.';
    box.appendChild(p);
    return;
  }
  const q = $('chatSearch') ? $('chatSearch').value.trim().toLowerCase() : '';
  const platform = $('chatPlatform') ? $('chatPlatform').value.toLowerCase() : '';
  const minRate = $('chatMinRate') ? Number($('chatMinRate').value) || 0 : 0;
  const sort = $('chatSort') ? $('chatSort').value : 'total';
  const list = Array.from(by.entries())
    .filter(([chan, s]) => {
      const { site, name } = splitChan(chan);
      if (platform) {
        const chanSite = site ? site.toLowerCase() : 'twitch';
        if (chanSite !== platform) return false;
      }
      if (minRate > 0) {
        const decided = s.mute + s.keep;
        const pct = decided ? Math.round((s.mute / decided) * 100) : 0;
        if (pct < minRate) return false;
      }
      if (!q) return true;
      // Les vieux journaux n'ont pas de préfixe : la carte dit quand même
      // « Twitch · … ». Chercher « twitch » ne doit pas les faire disparaître.
      const pretty = site ? (site === 'kick' ? 'Kick' : 'Twitch') + ' · ' + name : name;
      return (String(chan || '') + ' ' + pretty).toLowerCase().includes(q);
    })
    .sort((a, b) => {
      if (sort === 'rate') {
        const da = a[1].mute + a[1].keep;
        const db = b[1].mute + b[1].keep;
        const ra = da ? a[1].mute / da : 0;
        const rb = db ? b[1].mute / db : 0;
        if (rb !== ra) return rb - ra;
      } else if (sort === 'name') {
        return a[0].localeCompare(b[0]);
      }
      return b[1].total - a[1].total;
    });
  lastRenderedChans = list.map(([chan]) => chan);
  if ($('chatCount')) {
    const noun = by.size === 1 ? 'chat' : 'chats';
    $('chatCount').textContent = list.length === by.size
      ? by.size + ' ' + noun
      : list.length + ' / ' + by.size + ' ' + noun;
  }
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Aucun chat ne correspond au filtre.';
    box.appendChild(p);
    return;
  }
  for (const [chan, s] of list) {
    const card = document.createElement('div');
    card.className = 'card';
    const h = document.createElement('h3');
    h.appendChild(chanChip(chan));
    const when = document.createElement('small');
    when.style.color = 'var(--muted)';
    when.style.fontWeight = '400';
    when.textContent = s.last ? ' · dernier il y a ' + ago(s.last) : '';
    h.appendChild(when);

    const decided = s.mute + s.keep;
    const pct = decided ? Math.round((s.mute / decided) * 100) : 0;
    const badge = document.createElement('span');
    badge.className = 'badge-rate ' + (pct >= 30 ? 'bad' : pct >= 10 ? 'warn' : 'ok');
    badge.textContent = pct + ' % rejet';
    badge.title = decided ? pct + ' % de rejets sur les verdicts rendus' : 'Aucun verdict rendu';
    h.appendChild(badge);

    const chanReports = (typeof repCache !== 'undefined' && repCache ? Object.values(repCache) : []).filter((e) => e && e.channel === chan && !e.done);
    if (chanReports.length) {
      const repBadge = document.createElement('span');
      repBadge.className = 'chip mute';
      repBadge.style.fontSize = '10px';
      repBadge.style.marginLeft = '4px';
      repBadge.textContent = chanReports.length + ' signalement' + (chanReports.length > 1 ? 's' : '');
      repBadge.title = chanReports.length + ' cas extrême(s) actif(s) sur ce chat';
      h.appendChild(repBadge);
    }

    card.appendChild(h);

    const nums = document.createElement('div');
    nums.className = 'nums';
    // total compte aussi les lignes encore en attente. Les afficher comme
    // « analysés » faisait passer un journal non lu pour déjà jugé.
    const analyzed = s.mute + s.keep + s.review;
    const cells = [['analysés', analyzed, ''], ['acceptés', s.keep, 'ok'], ['rejetés', s.mute, 'bad']];
    if (s.pending) cells.push(['en attente', s.pending, 'warn']);
    if (s.review) cells.push(['signalés', s.review, 'warn']);
    // « perdus » et pas « abandonnés » : la case fait 48px au plus étroit.
    if (s.dropped) cells.push(['perdus', s.dropped, 'warn']);
    if (s.skip) cells.push(['ignorés', s.skip, 'warn']);
    for (const [k, v, cls] of cells) {
      const d = document.createElement('div');
      if (cls) d.className = cls;
      const b = document.createElement('b');
      b.textContent = String(v);
      d.appendChild(b);
      d.appendChild(document.createTextNode(k));
      nums.appendChild(d);
    }
    card.appendChild(nums);

    const rate = document.createElement('div');
    rate.className = 'rate';
    rate.title = decided ? pct + ' % de rejets sur les verdicts rendus' : '';
    const fill = document.createElement('i');
    fill.style.width = pct + '%';
    rate.appendChild(fill);
    card.appendChild(rate);

    const top = Array.from(s.authors.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const t3 = document.createElement('div');
    t3.className = 'top3';
    if (top.length) {
      t3.appendChild(document.createTextNode('Plus rejetés : '));
      top.forEach(([a, n], i) => {
        const b = document.createElement('b');
        b.textContent = a;
        b.style.cursor = 'pointer';
        b.addEventListener('click', () => {
          $('authorQuery').value = a;
          goTab('author');
          showAuthor(a);
        });
        t3.appendChild(b);
        t3.appendChild(document.createTextNode(' ×' + n + (i < top.length - 1 ? ', ' : '')));
      });
    } else t3.textContent = 'Aucun rejet.';
    card.appendChild(t3);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';
    actions.style.margin = '10px 0 0';
    actions.style.flexWrap = 'wrap';

    const btnLog = document.createElement('button');
    btnLog.type = 'button';
    btnLog.textContent = 'Voir dans le journal';
    btnLog.title = 'Filtrer le journal sur ' + chan;
    btnLog.style.fontSize = '11px';
    btnLog.style.height = '24px';
    btnLog.style.padding = '0 8px';
    btnLog.addEventListener('click', () => {
      rememberChan($('logChan'), chan);
      goTab('log');
      refilterLog();
    });
    actions.appendChild(btnLog);

    const btnMutes = document.createElement('button');
    btnMutes.type = 'button';
    btnMutes.textContent = 'Voir mutés';
    btnMutes.title = 'Filtrer les mutés sur ' + chan;
    btnMutes.style.fontSize = '11px';
    btnMutes.style.height = '24px';
    btnMutes.style.padding = '0 8px';
    btnMutes.addEventListener('click', () => {
      rememberChan($('muteChan'), chan);
      goTab('mutes');
      if (typeof refilterMutes === 'function') refilterMutes();
    });
    actions.appendChild(btnMutes);

    const btnMute = document.createElement('button');
    btnMute.type = 'button';
    btnMute.textContent = 'Muter sur ce chat…';
    btnMute.title = 'Muter manuellement un viewer sur ' + chan;
    btnMute.style.fontSize = '11px';
    btnMute.style.height = '24px';
    btnMute.style.padding = '0 8px';
    btnMute.addEventListener('click', () => {
      openMuteModal('', chan);
    });
    actions.appendChild(btnMute);

    const btnRep = document.createElement('button');
    btnRep.type = 'button';
    btnRep.textContent = chanReports.length ? 'Signalements (' + chanReports.length + ')' : 'Signalements';
    btnRep.title = chanReports.length
      ? chanReports.length + ' cas extrême' + (chanReports.length > 1 ? 's' : '') + ' à examiner sur ce chat'
      : 'Voir les signalements de ce chat';
    btnRep.style.fontSize = '11px';
    btnRep.style.height = '24px';
    btnRep.style.padding = '0 8px';
    if (chanReports.length) btnRep.style.color = 'var(--warn)';
    btnRep.addEventListener('click', () => {
      rememberChan($('repChan'), chan);
      goTab('report');
      renderReports();
    });
    actions.appendChild(btnRep);

    const { site, name } = splitChan(chan);
    const liveUrl = site === 'kick'
      ? 'https://kick.com/' + encodeURIComponent(name)
      : 'https://twitch.tv/' + encodeURIComponent(name);
    const btnLive = document.createElement('a');
    btnLive.href = liveUrl;
    btnLive.target = '_blank';
    btnLive.rel = 'noopener noreferrer';
    btnLive.className = 'btn small btn-live';
    btnLive.textContent = 'Live ↗';
    btnLive.title = 'Ouvrir le live ' + (site === 'kick' ? 'Kick' : 'Twitch') + ' de ' + name + ' dans un nouvel onglet';
    btnLive.style.fontSize = '11px';
    btnLive.style.height = '24px';
    btnLive.style.lineHeight = '24px';
    btnLive.style.padding = '0 8px';
    btnLive.style.display = 'inline-flex';
    btnLive.style.alignItems = 'center';
    btnLive.style.textDecoration = 'none';
    actions.appendChild(btnLive);

    if (top.length) {
      const btnCopyTop = document.createElement('button');
      btnCopyTop.type = 'button';
      btnCopyTop.textContent = 'Copier récidivistes';
      btnCopyTop.title = 'Copier les pseudos les plus rejetés sur ce chat';
      btnCopyTop.style.fontSize = '11px';
      btnCopyTop.style.height = '24px';
      btnCopyTop.style.padding = '0 8px';
      btnCopyTop.addEventListener('click', async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(top.map(([a]) => a).join('\n'));
            const prev = btnCopyTop.textContent;
            btnCopyTop.textContent = 'Copié ✓';
            setTimeout(() => { btnCopyTop.textContent = prev; }, 1500);
          }
        } catch (_) {}
      });
      actions.appendChild(btnCopyTop);
    }

    const btnExport = document.createElement('button');
    btnExport.type = 'button';
    btnExport.textContent = 'Exporter CSV';
    btnExport.title = 'Télécharger tous les messages de ce chat au format CSV';
    btnExport.style.fontSize = '11px';
    btnExport.style.height = '24px';
    btnExport.style.padding = '0 8px';
    btnExport.addEventListener('click', async () => {
      const res = await send({ type: 'CSG_FT_DUMP', full: true });
      const allRows = res && res.ok && Array.isArray(res.log) ? res.log : logCache;
      const chanRows = (Array.isArray(allRows) ? allRows : []).filter((r) => r && r.channel === chan);
      if (!chanRows.length) {
        alert('Aucun message à exporter pour ' + chan);
        return;
      }
      const { headers, data } = formatLogCsvRows(chanRows);
      const safeName = chan.replace(/[^a-z0-9_-]/gi, '_');
      downloadCsv(headers, data, 'csg-chat-' + safeName);
    });
    actions.appendChild(btnExport);

    card.appendChild(actions);
    box.appendChild(card);
  }
}
if ($('chatSearch')) $('chatSearch').addEventListener('input', renderChats);
if ($('chatPlatform')) $('chatPlatform').addEventListener('change', renderChats);
if ($('chatMinRate')) $('chatMinRate').addEventListener('change', renderChats);
if ($('chatSort')) $('chatSort').addEventListener('change', renderChats);
if ($('copyAllChanNames')) {
  $('copyAllChanNames').addEventListener('click', async () => {
    if (!lastRenderedChans.length) {
      alert('Aucune chaîne affichée.');
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(lastRenderedChans.join('\n'));
        const btn = $('copyAllChanNames');
        const prev = btn.textContent;
        btn.textContent = '✓ ' + lastRenderedChans.length + ' chaînes';
        setTimeout(() => { btn.textContent = prev; }, 1500);
      }
    } catch (_) {}
  });
}

// ---------------------------------------------------------------- auteur
let authorCurrentMsgs = [];
let authorNotesCache = {};

async function loadAuthorNotes() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    const v = await new Promise((r) => chrome.storage.local.get({ csg_author_notes: {} }, r));
    authorNotesCache = (v && typeof v.csg_author_notes === 'object' && v.csg_author_notes) || {};
  }
}

function renderRecentAuthors() {
  const box = $('authorRecentChips');
  const wrap = $('authorRecent');
  const empty = $('authorRecentEmpty');
  if (!box || !wrap) return;

  const names = new Set();
  const suspects = [];

  // 1. Dossiers de signalement en cours
  if (typeof repCache !== 'undefined' && repCache) {
    for (const [key, e] of Object.entries(repCache)) {
      if (e && e.author && !e.done && !names.has(e.author.toLowerCase())) {
        names.add(e.author.toLowerCase());
        suspects.push({ author: e.author, badge: 'signalé', cls: 'mute' });
      }
    }
  }

  // 2. Derniers mutés
  if (typeof mutedCache !== 'undefined' && mutedCache) {
    const mutesSorted = Object.entries(mutedCache).sort((a, b) => ((b[1] && b[1].at) || 0) - ((a[1] && a[1].at) || 0));
    for (const [name, rec] of mutesSorted) {
      if (name && !names.has(name.toLowerCase())) {
        names.add(name.toLowerCase());
        suspects.push({ author: name, badge: (rec && rec.perm) ? 'perma' : 'muté', cls: 'bad' });
        if (suspects.length >= 12) break;
      }
    }
  }

  // 3. Derniers rejets dans le journal
  if (suspects.length < 12 && typeof logCache !== 'undefined' && Array.isArray(logCache)) {
    for (let i = logCache.length - 1; i >= 0; i--) {
      const r = logCache[i];
      if (r && r.author && (r.label === 'mute' || r.verdict === 'mute') && !names.has(r.author.toLowerCase())) {
        names.add(r.author.toLowerCase());
        suspects.push({ author: r.author, badge: 'rejet', cls: 'bad' });
        if (suspects.length >= 12) break;
      }
    }
  }

  box.textContent = '';
  if (!suspects.length) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  for (const s of suspects) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'btn small author-chip';
    chip.style.display = 'inline-flex';
    chip.style.alignItems = 'center';
    chip.style.gap = '4px';
    chip.style.fontSize = '11px';
    chip.style.padding = '2px 8px';
    chip.title = 'Inspecter l\'historique de ' + s.author;

    const nameSpan = document.createElement('b');
    nameSpan.textContent = '@' + s.author;
    chip.appendChild(nameSpan);

    const bSpan = document.createElement('span');
    bSpan.className = 'chip ' + (s.cls || '');
    bSpan.style.fontSize = '9.5px';
    bSpan.style.padding = '0 4px';
    bSpan.textContent = s.badge;
    chip.appendChild(bSpan);

    if (typeof authorNotesCache !== 'undefined' && authorNotesCache && authorNotesCache[s.author.toLowerCase()]) {
      const nSpan = document.createElement('span');
      nSpan.className = 'chip';
      nSpan.style.fontSize = '9.5px';
      nSpan.style.padding = '0 3px';
      nSpan.textContent = '📝';
      nSpan.title = 'Note : ' + authorNotesCache[s.author.toLowerCase()].text;
      chip.appendChild(nSpan);
    }

    chip.addEventListener('click', () => {
      if ($('authorQuery')) $('authorQuery').value = s.author;
      showAuthor(s.author);
    });
    box.appendChild(chip);
  }
}

async function showAuthor(name) {
  const key = String(name || '').trim().toLowerCase();
  const meta = $('authorMeta');
  const box = $('authorMsgs');
  const un = $('authorUnmute');
  const mu = $('authorMute');
  const wl = $('authorWhitelist');
  const repBtn = $('authorReportBtn');
  const twLink = $('authorProfileTwitch');
  const kickLink = $('authorProfileKick');
  const noteBox = $('authorNoteBox');
  if (un) un.classList.add('hidden');
  if (mu) mu.classList.add('hidden');
  if (wl) wl.classList.add('hidden');
  if (repBtn) repBtn.classList.add('hidden');
  if (twLink) twLink.classList.add('hidden');
  if (kickLink) kickLink.classList.add('hidden');
  if (noteBox) noteBox.classList.add('hidden');
  if (!key) {
    meta.textContent = '';
    box.textContent = '';
    authorCurrentMsgs = [];
    if ($('authorFilterBar')) $('authorFilterBar').classList.add('hidden');
    if ($('authorRecent')) $('authorRecent').classList.remove('hidden');
    if (typeof renderRecentAuthors === 'function') renderRecentAuthors();
    return;
  }
  if ($('authorRecent')) $('authorRecent').classList.add('hidden');
  meta.textContent = 'Chargement…';
  box.textContent = '';
  const res = await send({ type: 'CSG_AUTHOR_HISTORY', author: key, limit: 60 });
  if (!res || !res.ok) {
    meta.textContent = 'Le service worker ne répond pas — réessaie.';
    authorCurrentMsgs = [];
    if ($('authorFilterBar')) $('authorFilterBar').classList.add('hidden');
    return;
  }
  const msgs = res.msgs || [];
  authorCurrentMsgs = msgs;
  const toxic = res.toxic;
  const isWl = !!res.whitelisted;
  const isMuted = !!res.muted;
  const statusStr = isWl ? 'WHITELISTÉ' : (isMuted ? 'MUTÉ' : 'suivi');
  const bits = [key, accord(msgs.length, 'message', 'messages') + ' en mémoire (30 min)', statusStr];
  const nRejets = msgs.filter((m) => rowLabel(m) === 'mute' || (m && m.codexVerdict === 'mute')).length;
  if (nRejets > 0) bits.push(nRejets + ' ' + accord(nRejets, 'rejet', 'rejets'));
  if (toxic && toxic.verdict) bits.push('profil IA : ' + (toxic.verdict.toxic ? (toxic.verdict.kind === 'simp' ? 'simp' : 'toxique') : 'ok') + ' · indice ' + filterIndex(toxic.verdict.score));
  const hasReport = typeof repCache !== 'undefined' && repCache && Object.values(repCache).some((e) => e && String(e.author || '').toLowerCase() === key && !e.done);
  if (hasReport) {
    bits.push('⚠ SIGNALEMENT EN COURS');
    if (repBtn) {
      repBtn.classList.remove('hidden');
      repBtn.textContent = 'Dossier signalement';
      repBtn.title = 'Ouvrir le dossier de signalement de cet auteur';
      repBtn.onclick = () => {
        if ($('repSearch')) $('repSearch').value = key;
        if ($('repChan')) $('repChan').value = '';
        if ($('repVerdict')) $('repVerdict').value = '';
        goTab('report');
        renderReports();
      };
    }
  } else if (nRejets > 0) {
    if (repBtn) {
      repBtn.classList.remove('hidden');
      repBtn.textContent = '+ Signaler';
      repBtn.title = 'Constituer un dossier de signalement à partir des messages rejetés de cet auteur';
      repBtn.onclick = async () => {
        repBtn.disabled = true;
        const lastChan = (msgs[msgs.length - 1] && msgs[msgs.length - 1].channel) || '';
        const res = await send({ type: 'CSG_REPORT_ADD', author: key, channel: lastChan });
        repBtn.disabled = false;
        if (res && res.ok) {
          if (typeof loadReports === 'function') await loadReports();
          showAuthor(key);
        } else {
          if (typeof alert === 'function') alert(res && res.err ? 'Impossible de créer le signalement : ' + res.err : 'Aucun message rejeté en mémoire pour cet auteur.');
        }
      };
    }
  }

  // Note modérateur
  if (res && res.note && !authorNotesCache[key]) {
    authorNotesCache[key] = res.note;
  }
  const curNote = (typeof authorNotesCache !== 'undefined' && authorNotesCache && authorNotesCache[key]) || (res && res.note) || null;
  if (curNote && curNote.text) {
    bits.push('📝 ' + curNote.text);
  }
  if (noteBox) {
    noteBox.classList.remove('hidden');
    if ($('authorNoteInput')) $('authorNoteInput').value = curNote ? curNote.text : '';
    if ($('authorNoteDelete')) $('authorNoteDelete').classList.toggle('hidden', !curNote);
    if ($('authorNoteTime')) {
      $('authorNoteTime').textContent = curNote && curNote.ts ? (typeof ago === 'function' ? 'enregistré il y a ' + ago(curNote.ts) : 'enregistré') : '';
    }
  }

  // Liens profils externes
  if (twLink) {
    twLink.href = 'https://twitch.tv/' + encodeURIComponent(key);
    twLink.classList.remove('hidden');
  }
  if (kickLink) {
    kickLink.href = 'https://kick.com/' + encodeURIComponent(key);
    kickLink.classList.remove('hidden');
  }

  meta.textContent = bits.join(' · ');

  if (wl) {
    wl.classList.remove('hidden');
    wl.textContent = isWl ? 'Retirer de la whitelist' : 'Whitelister';
    wl.title = isWl ? 'Retirer cet auteur de la whitelist Refchat' : 'Refchat ignorera cet auteur (aucun mute)';
    wl.onclick = async () => {
      wl.disabled = true;
      await send({ type: 'CSG_WHITELIST', names: [key], on: !isWl });
      wl.disabled = false;
      loadMutes();
      showAuthor(key);
    };
  }

  if (isMuted) {
    if (un) {
      un.classList.remove('hidden');
      un.onclick = async () => {
        un.disabled = true;
        await send({ type: 'CSG_MUTE_REMOVE', key });
        un.disabled = false;
        loadMutes();
        showAuthor(key);
      };
    }
  } else if (!isWl) {
    if (mu) {
      mu.classList.remove('hidden');
      mu.onclick = async () => {
        mu.disabled = true;
        const lastChan = (msgs[msgs.length - 1] && msgs[msgs.length - 1].channel) || '';
        const res = await send({ type: 'CSG_LOCAL_MUTE', author: key, score: 1, reason: 'manuel', channel: lastChan, perm: true });
        mu.disabled = false;
        if (!res || res.ok === false) {
          alert('Le mute n’a pas été confirmé. Réessaie.');
        } else if (res.applied === false) {
          alert('Impossible de muter ' + key + ' (auteur déjà muté, dans la whitelist ou nom réservé).');
        }
        loadMutes();
        showAuthor(key);
      };
    }
  }

  if ($('authorMsgFilter')) $('authorMsgFilter').value = '';
  if ($('authorMsgVerdict')) $('authorMsgVerdict').value = '';
  if (typeof fillChanSelect === 'function' && $('authorMsgChan')) {
    const chans = new Set();
    for (const m of msgs) if (m && m.channel) chans.add(m.channel);
    fillChanSelect($('authorMsgChan'), chans, false);
  }
  renderAuthorMsgs();
}

function renderAuthorMsgs() {
  const box = $('authorMsgs');
  const filterBar = $('authorFilterBar');
  const countEl = $('authorMsgCount');
  if (!box) return;
  box.textContent = '';

  const msgs = authorCurrentMsgs || [];
  if (!msgs.length) {
    if (filterBar) filterBar.classList.add('hidden');
    if (countEl) countEl.textContent = '';
    const p = document.createElement('div');
    p.className = 'am';
    p.textContent = 'Aucun message en mémoire.';
    box.appendChild(p);
    return;
  }

  if (filterBar) filterBar.classList.remove('hidden');

  const q = ($('authorMsgFilter') ? $('authorMsgFilter').value.trim().toLowerCase() : '');
  const verdict = ($('authorMsgVerdict') ? $('authorMsgVerdict').value : '');
  const chan = ($('authorMsgChan') ? $('authorMsgChan').value : '');

  const filtered = msgs.filter((m) => {
    if (chan && m.channel !== chan) return false;
    if (q) {
      const text = String(m.t || m.text || '').toLowerCase();
      if (!text.includes(q)) return false;
    }
    if (verdict) {
      const lbl = rowLabel(m);
      if (verdict === 'mute') {
        if (lbl !== 'mute' && !(m && m.codexVerdict === 'mute')) return false;
      } else if (verdict === 'keep') {
        if (lbl !== 'keep' && !(m && m.codexVerdict === 'keep')) return false;
      } else if (verdict === 'review') {
        if (lbl !== 'review' && !(m && m.codexJudged)) return false;
      }
    }
    return true;
  });

  if (countEl) {
    if (q || verdict || chan) {
      countEl.textContent = filtered.length + ' / ' + msgs.length + ' affiché' + (filtered.length > 1 ? 's' : '');
    } else {
      countEl.textContent = accord(msgs.length, 'message', 'messages');
    }
  }

  if (!filtered.length) {
    const p = document.createElement('div');
    p.className = 'am';
    p.textContent = 'Aucun message ne correspond aux filtres.';
    box.appendChild(p);
    return;
  }

  for (const m of filtered.slice().reverse()) {
    const d = document.createElement('div');
    d.className = 'am';
    d.title = 'Double-clic pour copier ce message';
    d.addEventListener('dblclick', async (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(m.t || m.text || '');
          const prevTitle = d.title;
          d.title = 'Message copié !';
          d.classList.add('copied');
          setTimeout(() => {
            d.title = prevTitle;
            d.classList.remove('copied');
          }, 1500);
        }
      } catch (_) {}
    });
    const at = document.createElement('div');
    at.className = 'at';
    at.textContent = new Date(m.ts || Date.now()).toLocaleTimeString() + ' · ';
    const chip = chanChip(m.channel);
    if (chip && chip.addEventListener && m.channel) {
      chip.style.cursor = 'pointer';
      chip.title = 'Voir ce chat dans le journal';
      chip.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if ($('logChan')) $('logChan').value = m.channel;
        goTab('log');
        refilterLog();
      });
    }
    at.appendChild(chip);
    const lbl = rowLabel(m);
    if (lbl && lbl !== 'pending') {
      at.appendChild(document.createTextNode(' · '));
      at.appendChild(labelChip(lbl, m.codexJudged ? 'codex' : m.source));
    }
    const t = document.createElement('div');
    t.className = (lbl === 'mute' || (m && m.codexVerdict === 'mute')) ? 't streamer-redact' : 't';
    if (q) {
      highlightText(t, m.t || m.text || '', q);
    } else {
      t.textContent = m.t || m.text || '';
    }
    d.appendChild(at);
    d.appendChild(t);
    box.appendChild(d);
  }
}

if ($('authorMsgFilter')) $('authorMsgFilter').addEventListener('input', renderAuthorMsgs);
if ($('authorMsgVerdict')) $('authorMsgVerdict').addEventListener('change', renderAuthorMsgs);
if ($('authorMsgChan')) $('authorMsgChan').addEventListener('change', renderAuthorMsgs);

if ($('authorNoteSave')) {
  $('authorNoteSave').addEventListener('click', async () => {
    const key = $('authorQuery') ? $('authorQuery').value.trim().toLowerCase() : '';
    if (!key) return;
    const input = $('authorNoteInput');
    const text = input ? input.value.trim() : '';
    const result = await send({ type: 'CSG_AUTHOR_NOTE_SET', author: key, note: text });
    if (!result || !result.ok) {
      if ($('authorNoteTime')) $('authorNoteTime').textContent = 'Note non enregistrée · réessayer';
      return;
    }
    if (text) {
      authorNotesCache[key] = { text: text.slice(0, 500), ts: Date.now() };
    } else {
      delete authorNotesCache[key];
    }
    const btn = $('authorNoteSave');
    const prev = btn.textContent;
    btn.textContent = 'Enregistré ✓';
    if (typeof setTimeout === 'function') setTimeout(() => { btn.textContent = prev; }, 1500);
    if ($('authorNoteDelete')) $('authorNoteDelete').classList.toggle('hidden', !text);
    if ($('authorNoteTime')) $('authorNoteTime').textContent = text ? 'enregistré à l\'instant' : '';
    if (typeof renderRecentAuthors === 'function') renderRecentAuthors();
    if (typeof renderMutes === 'function') renderMutes();
    if (typeof showAuthor === 'function' && key) showAuthor(key);
  });
}
if ($('authorNoteInput')) {
  $('authorNoteInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if ($('authorNoteSave')) $('authorNoteSave').click();
    }
  });
}
if ($('authorNoteDelete')) {
  $('authorNoteDelete').addEventListener('click', async () => {
    const key = $('authorQuery') ? $('authorQuery').value.trim().toLowerCase() : '';
    if (!key) return;
    const result = await send({ type: 'CSG_AUTHOR_NOTE_SET', author: key, note: '' });
    if (!result || !result.ok) {
      if ($('authorNoteTime')) $('authorNoteTime').textContent = 'Note non supprimée · réessayer';
      return;
    }
    delete authorNotesCache[key];
    if ($('authorNoteInput')) $('authorNoteInput').value = '';
    if ($('authorNoteDelete')) $('authorNoteDelete').classList.add('hidden');
    if ($('authorNoteTime')) $('authorNoteTime').textContent = '';
    if (typeof renderRecentAuthors === 'function') renderRecentAuthors();
    if (typeof renderMutes === 'function') renderMutes();
    if (typeof showAuthor === 'function' && key) showAuthor(key);
  });
}

$('authorLookup').addEventListener('click', () => showAuthor($('authorQuery').value));
$('authorQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    showAuthor(e.target.value);
  }
});
$('authorQuery').addEventListener('input', (e) => {
  if (!e.target.value.trim()) showAuthor('');
});
$('authorRecheck').addEventListener('click', async () => {
  const q = $('authorQuery').value.trim();
  if (!q) return;
  const b = $('authorRecheck');
  b.disabled = true;
  b.textContent = 'Analyse…';
  await send({ type: 'CSG_AUTHOR_CHECK', author: q });
  setTimeout(() => {
    b.disabled = false;
    b.textContent = 'Relire l’historique';
    showAuthor(q);
  }, 1200);
});
if ($('authorInLog')) {
  $('authorInLog').addEventListener('click', () => {
    const q = $('authorQuery').value.trim();
    if (!q) return;
    $('logSearch').value = q;
    goTab('log');
    refilterLog();
  });
}
if ($('authorCopyHistory')) {
  $('authorCopyHistory').addEventListener('click', async () => {
    const q = $('authorQuery').value.trim();
    if (!authorCurrentMsgs || !authorCurrentMsgs.length) {
      alert('Aucun message en mémoire pour cet auteur.');
      return;
    }
    const filterTxt = ($('authorMsgFilter') ? $('authorMsgFilter').value.trim().toLowerCase() : '');
    const verdict = ($('authorMsgVerdict') ? $('authorMsgVerdict').value : '');
    const chan = ($('authorMsgChan') ? $('authorMsgChan').value : '');
    const targetMsgs = (filterTxt || verdict || chan) ? authorCurrentMsgs.filter((m) => {
      if (chan && m.channel !== chan) return false;
      if (filterTxt && !String(m.t || m.text || '').toLowerCase().includes(filterTxt)) return false;
      if (verdict) {
        const lbl = rowLabel(m);
        if (verdict === 'mute') {
          if (lbl !== 'mute' && !(m && m.codexVerdict === 'mute')) return false;
        } else if (verdict === 'keep') {
          if (lbl !== 'keep' && !(m && m.codexVerdict === 'keep')) return false;
        } else if (verdict === 'review') {
          if (lbl !== 'review' && !(m && m.codexJudged)) return false;
        }
      }
      return true;
    }) : authorCurrentMsgs;
    if (!targetMsgs.length) {
      alert('Aucun message ne correspond aux filtres.');
      return;
    }
    const lines = targetMsgs.map((m) => {
      const time = new Date(m.ts || Date.now()).toLocaleTimeString();
      return '[' + time + '] ' + (m.channel || '') + ' : ' + (m.t || m.text || '');
    });
    const header = 'Historique Refchat — ' + (q || 'auteur') + ' (' + lines.length + ' message' + (lines.length > 1 ? 's' : '') + ') :';
    const text = header + '\n' + lines.join('\n');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        const btn = $('authorCopyHistory');
        const prev = btn.textContent;
        btn.textContent = 'Copié ✓';
        setTimeout(() => { btn.textContent = prev; }, 1500);
      }
    } catch (_) {}
  });
}
if ($('authorExportCsv')) {
  $('authorExportCsv').addEventListener('click', () => {
    const q = $('authorQuery').value.trim() || 'auteur';
    if (!authorCurrentMsgs || !authorCurrentMsgs.length) {
      alert('Aucun message en mémoire pour cet auteur.');
      return;
    }
    const filterTxt = ($('authorMsgFilter') ? $('authorMsgFilter').value.trim().toLowerCase() : '');
    const verdict = ($('authorMsgVerdict') ? $('authorMsgVerdict').value : '');
    const chan = ($('authorMsgChan') ? $('authorMsgChan').value : '');
    const targetMsgs = (filterTxt || verdict || chan) ? authorCurrentMsgs.filter((m) => {
      if (chan && m.channel !== chan) return false;
      if (filterTxt && !String(m.t || m.text || '').toLowerCase().includes(filterTxt)) return false;
      if (verdict) {
        const lbl = rowLabel(m);
        if (verdict === 'mute') {
          if (lbl !== 'mute' && !(m && m.codexVerdict === 'mute')) return false;
        } else if (verdict === 'keep') {
          if (lbl !== 'keep' && !(m && m.codexVerdict === 'keep')) return false;
        } else if (verdict === 'review') {
          if (lbl !== 'review' && !(m && m.codexJudged)) return false;
        }
      }
      return true;
    }) : authorCurrentMsgs;
    if (!targetMsgs.length) {
      alert('Aucun message ne correspond aux filtres.');
      return;
    }
    const { headers, data } = formatLogCsvRows(targetMsgs);
    downloadCsv(headers, data, 'csg-auteur-' + q);
  });
}
if ($('authorCopySummary')) {
  $('authorCopySummary').addEventListener('click', async () => {
    const q = $('authorQuery').value.trim();
    if (!q) {
      alert('Veuillez d’abord renseigner ou sélectionner un pseudo.');
      return;
    }
    const key = q.toLowerCase();
    const isWl = typeof whitelistCache !== 'undefined' && !!whitelistCache[key];
    const muteRec = typeof mutedCache !== 'undefined' && mutedCache[key];
    const isMuted = !!muteRec;
    const statusStr = isWl ? 'WHITELISTÉ (protégé)' : (isMuted ? 'MUTÉ (' + (muteRec.strikes || 'sanctionné') + ')' : 'Suivi (non sanctionné)');
    const note = (typeof authorNotesCache !== 'undefined' && authorNotesCache[key] && authorNotesCache[key].text) || '';
    const hasReport = typeof repCache !== 'undefined' && repCache && Object.values(repCache).some((e) => e && String(e.author || '').toLowerCase() === key && !e.done);
    const msgs = authorCurrentMsgs || [];
    const nRejets = msgs.filter((m) => rowLabel(m) === 'mute' || (m && m.codexVerdict === 'mute')).length;
    const chans = Array.from(new Set(msgs.map((m) => m && m.channel).filter(Boolean)));

    const lines = [
      '📋 FICHE MODÉRATEUR REFCHAT — @' + q,
      '• Statut : ' + statusStr,
      chans.length ? '• Chat(s) récent(s) : ' + chans.join(', ') : '',
      note ? '• 📝 Note modérateur : ' + note : '',
      hasReport ? '• ⚠ Signalement : DOSSIER EN COURS DE TRAITEMENT' : '',
      '• Activité récente (30 min) : ' + msgs.length + ' message' + (msgs.length > 1 ? 's' : '') + ' (dont ' + nRejets + ' rejet' + (nRejets > 1 ? 's' : '') + (msgs.length ? ' · ' + Math.round((nRejets / msgs.length) * 100) + '% rejet' : '') + ')'
    ].filter(Boolean);

    if (msgs.length) {
      lines.push('• Derniers messages observés :');
      for (const m of msgs.slice(-5).reverse()) {
        const time = new Date(m.ts || Date.now()).toLocaleTimeString();
        const lbl = rowLabel(m);
        const tag = lbl === 'mute' ? ' [REJETÉ]' : '';
        lines.push('  - [' + time + '] ' + (m.channel || '') + ' : "' + (m.t || m.text || '') + '"' + tag);
      }
    }

    const text = lines.join('\n');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        const btn = $('authorCopySummary');
        const prev = btn.textContent;
        btn.textContent = 'Fiche copiée ✓';
        setTimeout(() => { btn.textContent = prev; }, 1500);
      } else {
        alert(text);
      }
    } catch (_) {
      alert(text);
    }
  });
}
if ($('authorExportJson')) {
  $('authorExportJson').addEventListener('click', () => {
    const q = $('authorQuery').value.trim();
    if (!q) {
      alert('Veuillez d’abord renseigner ou sélectionner un pseudo.');
      return;
    }
    const key = q.toLowerCase();
    const isWl = typeof whitelistCache !== 'undefined' && !!whitelistCache[key];
    const muteRec = typeof mutedCache !== 'undefined' && mutedCache[key];
    const isMuted = !!muteRec;
    const note = (typeof authorNotesCache !== 'undefined' && authorNotesCache[key]) || null;
    const report = (typeof repCache !== 'undefined' && repCache && Object.values(repCache).find((e) => e && String(e.author || '').toLowerCase() === key)) || null;
    const msgs = authorCurrentMsgs || [];
    const nRejets = msgs.filter((m) => rowLabel(m) === 'mute' || (m && m.codexVerdict === 'mute')).length;

    const data = {
      author: q,
      exportedAt: new Date().toISOString(),
      status: {
        whitelisted: isWl,
        muted: isMuted,
        strikes: muteRec ? (muteRec.strikes || null) : null,
        permanent: muteRec ? !!muteRec.perm : false,
        at: muteRec ? (muteRec.at || null) : null
      },
      note: note ? { text: note.text, ts: note.ts || null } : null,
      report: report ? {
        channel: report.channel || '',
        done: !!report.done,
        ext: report.ext || 0,
        audit: report.audit || null,
        msgsCount: (report.msgs || []).length
      } : null,
      stats: {
        totalMessages: msgs.length,
        rejectedCount: nRejets,
        rejectionRate: msgs.length ? Math.round((nRejets / msgs.length) * 100) + '%' : '0%'
      },
      messages: msgs.map((m) => ({
        ts: m.ts || null,
        channel: m.channel || '',
        text: m.t || m.text || '',
        verdict: rowLabel(m),
        source: m.source || ''
      }))
    };
    downloadJson(data, 'refchat-author-' + key);
  });
}
if ($('authorCopyName')) {
  $('authorCopyName').addEventListener('click', async () => {
    const q = $('authorQuery').value.trim();
    if (!q) {
      alert('Veuillez d’abord renseigner ou sélectionner un pseudo.');
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(q);
        const btn = $('authorCopyName');
        const prev = btn.textContent;
        btn.textContent = 'Copié ✓';
        setTimeout(() => { btn.textContent = prev; }, 1500);
      }
    } catch (_) {}
  });
}

// ------------------------------------------------------------ audit complet
function renderAudit(r, who) {
  const box = $('authorAuditBox');
  box.textContent = '';
  box.classList.remove('hidden');
  if (!r || !r.ok) {
    box.className = 'audit err';
    box.textContent = '⚠ ' + ((r && r.err) || 'échec de l’audit');
    return;
  }
  box.className = 'audit ' + (r.mute ? 'bad' : 'ok');

  const head = document.createElement('div');
  head.className = 'audit-head';
  const chip = document.createElement('span');
  chip.className = 'chip ' + (r.mute ? 'mute' : 'keep');
  chip.textContent = r.mute
    ? (r.kind === 'inutile' ? 'à muter · bruit' : r.kind === 'simp' ? 'à muter · simp' : 'à muter · toxique')
    : 'à garder';
  head.appendChild(chip);
  const sc = document.createElement('b');
  sc.textContent = filterIndex(r.score);
  sc.title = FILTER_INDEX_HINT;
  head.appendChild(sc);
  const meta = document.createElement('small');
  const web = r.web || {};
  meta.textContent =
    r.n + ' messages relus · raisonnement ' + (r.effort || '?') +
    (web.on
      ? web.searched
        ? ' · ' + web.searched + ' recherche' + (web.searched > 1 ? 's' : '') + ' web'
        : ' · web dispo, non utilisé'
      : ' · sans web') +
    (r.mute && !r.applied ? ' · mute NON appliqué (score sous le seuil, ou déjà muté)' : '') +
    (r.applied ? ' · @' + who + ' muté' : '');
  head.appendChild(meta);
  box.appendChild(head);

  if (r.why) {
    const p = document.createElement('p');
    p.className = 'audit-why';
    p.textContent = r.why;
    box.appendChild(p);
  }
  if (r.evidence && r.evidence.length) {
    const h = document.createElement('div');
    h.className = 'audit-ev-h';
    h.textContent = 'Messages cités';
    box.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'audit-ev';
    for (const e of r.evidence) {
      const li = document.createElement('li');
      li.textContent = e;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  // Le point du dispositif : montrer ce que le fast a gagné, sinon le retour
  // vers la liste locale est invisible et personne ne sait s'il a lieu.
  const gained = r.learned || {};
  if ((gained.added && gained.added.length) || (gained.rejected && gained.rejected.length)) {
    const h = document.createElement('div');
    h.className = 'audit-ev-h';
    h.textContent = 'Redescendu vers la liste locale';
    box.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'audit-ev';
    for (const w of gained.added || []) {
      const li = document.createElement('li');
      li.textContent = '✅ « ' + w +' » — bloqué désormais sans appel réseau';
      ul.appendChild(li);
    }
    for (const rj of gained.rejected || []) {
      const li = document.createElement('li');
      li.textContent = '✕ « ' + rj.w + ' » — refusé : ' + rj.why;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  if (web.sources && web.sources.length) {
    const h = document.createElement('div');
    h.className = 'audit-ev-h';
    h.textContent = 'Sources consultées';
    box.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'audit-ev';
    for (const s of web.sources) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      a.textContent = s.title || s.url;
      li.appendChild(a);
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
}

// La sonde repond a UNE question : la passerelle relaie-t-elle web_search ?
// Trois issues, trois conclusions distinctes — sans elle, « non utilisé » ne
// permet pas de distinguer « rien à chercher » de « outil silencieusement ignoré ».
function renderProbe(r) {
  const box = $('authorAuditBox');
  box.textContent = '';
  box.classList.remove('hidden');
  if (!r || !r.ok) {
    box.className = 'audit err';
    box.textContent = (r && r.rejected === 'web')
      ? '❌ La passerelle REFUSE l’outil : ' + r.err
      : '⚠ ' + ((r && r.err) || 'échec de la sonde');
    return;
  }
  box.className = 'audit ' + (r.searched ? 'ok' : 'bad');
  const head = document.createElement('div');
  head.className = 'audit-head';
  const chip = document.createElement('span');
  chip.className = 'chip ' + (r.searched ? 'keep' : 'mute');
  chip.textContent = r.searched ? 'web actif' : 'web inerte';
  head.appendChild(chip);
  const small = document.createElement('small');
  small.textContent = r.searched
    ? r.searched + ' recherche' + (r.searched > 1 ? 's' : '') + ' — la passerelle relaie bien web_search'
    : 'aucune recherche alors qu’elle était imposée — la passerelle ignore `tools` en silence'
      + (r.cut ? ' (réponse coupée : ' + r.cut + ')' : '');
  head.appendChild(small);
  box.appendChild(head);
  if (r.text) {
    const p = document.createElement('p');
    p.className = 'audit-why';
    p.textContent = r.text;
    box.appendChild(p);
  }
  if (r.sources && r.sources.length) {
    const h = document.createElement('div');
    h.className = 'audit-ev-h';
    h.textContent = 'Sources consultées';
    box.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'audit-ev';
    for (const s of r.sources) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      a.textContent = s.title || s.url;
      li.appendChild(a);
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
}

$('webProbe').addEventListener('click', async () => {
  const b = $('webProbe');
  b.disabled = true;
  b.textContent = 'Test…';
  renderProbe(await send({ type: 'CSG_WEB_PROBE' }));
  b.disabled = false;
  b.textContent = 'Tester le web';
});

$('authorAudit').addEventListener('click', async () => {
  const q = $('authorQuery').value.trim();
  if (!q) return;
  const b = $('authorAudit');
  b.disabled = true;
  b.textContent = 'Audit… (jusqu’à 2 min)';
  $('authorAuditBox').classList.add('hidden');
  const r = await send({ type: 'CSG_AUTHOR_AUDIT', author: q });
  b.disabled = false;
  b.textContent = 'Audit complet';
  renderAudit(r, q.toLowerCase());
  loadMutes();
  showAuthor(q);
});

// ----------------------------------------------------------- audit en masse
let bulkTimer = null;
let grokWasRunning = false;

function renderBulk(st, minMsgs) {
  const box = $('bulkBox');
  const stop = $('auditAllStop');
  if (!st || (!st.running && !st.total && !st.err)) {
    box.classList.add('hidden');
    stop.classList.add('hidden');
    $('auditAll').disabled = false;
    return;
  }
  // Rien à analyser : le panneau complet disait « analyse arrêtée · 0 personne mutée ».
  if (!st.running && !st.stopping && !Number(st.total) && !(Number(st.peopleTotal) > 0) && st.err && !(st.results && st.results.length)) {
    box.className = 'audit err';
    box.textContent = '';
    stop.classList.add('hidden');
    $('auditAll').disabled = false;
    const note = document.createElement('p');
    note.textContent = st.err;
    box.appendChild(note);
    return;
  }
  const codex = st.source === 'codex';
  box.className = 'audit' + (st.err ? ' err' : st.running ? '' : ' ok');
  box.textContent = '';
  stop.classList.toggle('hidden', codex || (!st.running && !st.stopping));
  stop.disabled = !!st.stopping;
  stop.textContent = st.stopping ? 'Arrêt en cours…' : 'Arrêter l’analyse';
  $('auditAll').disabled = !!(st.running || st.stopping);

  const head = document.createElement('div');
  head.className = 'audit-head';
  const b = document.createElement('b');
  const peopleDone = Number.isFinite(Number(st.peopleDone)) ? Number(st.peopleDone) : Number(st.done) || 0;
  const peopleTotal = Number.isFinite(Number(st.peopleTotal)) && Number(st.peopleTotal) > 0 ? Number(st.peopleTotal) : Number(st.total) || 0;
  b.textContent = peopleDone + ' / ' + peopleTotal + ' personne' + (peopleTotal > 1 ? 's' : '');
  head.appendChild(b);
  const small = document.createElement('small');
  const muted = Number(codex ? st.flaggedPeople : st.muted) || 0;
  const failed = codex ? 0 : (st.results || []).filter((r) => !r.ok).length;
  const bits = [];
  if (st.stopping) bits.push('arrêt en cours…');
  else if (st.running) bits.push(st.current ? (codex ? 'Codex · ' : 'en cours : ') + st.current : 'démarrage…');
  else if (!codex && st.err) bits.push('analyse arrêtée');
  else if (codex && st.err) bits.push('Codex · erreur');
  else if (codex && peopleDone < peopleTotal) bits.push('Codex · en attente du prochain passage');
  else bits.push(codex ? 'Codex · terminé' : 'terminé');
  bits.push(muted + ' personne' + (muted > 1 ? 's' : '') + (codex ? ' signalée' : ' mutée') + (muted > 1 ? 's' : ''));
  if (failed) bits.push(failed + ' échec' + (failed > 1 ? 's' : ''));
  bits.push(codex ? 'aucun mute appliqué' : 'toutes les captures en attente sont conservées');
  if (st.err) bits.push('⚠ ' + st.err);
  small.textContent = bits.join(' · ');
  head.appendChild(small);
  box.appendChild(head);

  const rate = document.createElement('div');
  rate.className = 'rate';
  const fill = document.createElement('i');
  fill.style.width = (peopleTotal ? Math.round((peopleDone / peopleTotal) * 100) : 0) + '%';
  rate.appendChild(fill);
  box.appendChild(rate);

  // Montrer les lignes rejetées les plus récentes.
  const flagged = (st.results || []).filter((r) => r.mute).reverse();
  if (flagged.length) {
    const h = document.createElement('div');
    h.className = 'audit-ev-h';
    h.textContent = 'Signalés';
    box.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'audit-ev';
    for (const r of flagged.slice(0, 25)) {
      const li = document.createElement('li');
      li.textContent = codex
        ? '@' + r.a + (r.text ? ' · « ' + r.text + ' »' : '') + (r.why ? ' — ' + r.why : '') + ' · à examiner'
        : '@' + r.a + ' · verdict de mute' + (r.why ? ' — ' + r.why : '');
      li.style.cursor = 'pointer';
      li.title = 'Ouvrir cet auteur';
      li.addEventListener('click', () => {
        $('authorQuery').value = r.a;
        // La liste vit maintenant dans l'onglet Mutés : sans la bascule, showAuthor
        // remplirait un panneau caché et le clic ne ferait rien de visible.
        goTab('author');
        showAuthor(r.a);
      });
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  box.classList.remove('hidden');
}

async function pollBulk() {
  clearTimeout(bulkTimer);
  const r = await send({ type: 'CSG_AUDIT_ALL_STATUS' });
  if (!r || !r.ok) return;
  const grok = r.status || {};
  const hadGrokRun = grokWasRunning;
  grokWasRunning = !!(grok.running || grok.stopping);
  let shown = grok;
  let bridgeEnabled = false;
  if (!grok.running && !grok.stopping && !grok.err) {
    const codex = await send({ type: 'CSG_CODEX_BRIDGE_STATUS' });
    bridgeEnabled = !!(codex && codex.enabled);
    if (bridgeEnabled) {
      shown = codex.ok
        ? Object.assign({ source: 'codex' }, codex.status || {})
        : { source: 'codex', running: false, done: 0, total: 0, peopleDone: 0, peopleTotal: 0,
            err: codex.err || 'relais local indisponible' };
    }
  }
  renderBulk(shown, r.minMsgs);
  if (!grok.running && (hadGrokRun || !bridgeEnabled)) loadMutes();
  const pane = document.querySelector('.pane.on');
  if (pane && pane.id === 'tab-mutes' && (grok.running || grok.stopping || bridgeEnabled)) {
    bulkTimer = setTimeout(pollBulk, shown && (shown.running || shown.stopping) ? 3000 : 15000);
  }
}

$('auditAll').addEventListener('click', async () => {
  // Le clic déclenche l'analyse ; le fond répond immédiatement et publie la progression.
  const pre = await send({ type: 'CSG_AUDIT_ALL_STATUS' });
  const planned = (pre && pre.planned) || 0;
  if (!planned) {
    renderBulk(
      { running: false, done: 0, total: 0, err: 'aucun message à analyser dans le journal courant' },
      (pre && pre.minMsgs) || 0
    );
    return;
  }
  await send({ type: 'CSG_AUDIT_ALL_START' });
  pollBulk();
});

$('auditAllStop').addEventListener('click', async () => {
  await send({ type: 'CSG_AUDIT_ALL_STOP' });
  pollBulk();
});

// ------------------------------------------------------------- apprentissage
let learnCache = { learned: [], log: [] };

async function loadLearn() {
  const res = await send({ type: 'CSG_LEARN_DUMP' });
  if (!res || !res.ok) {
    // Service worker endormi : on lit ce qui est persisté.
    const v = await new Promise((r) =>
      chrome.storage.local.get({ csg_learned: [], csg_learn_log: [] }, r)
    );
    learnCache = { learned: v.csg_learned || [], log: v.csg_learn_log || [] };
    $('learnMeta').textContent = '';
  } else {
    learnCache = res;
    const bits = [];
    bits.push(res.candidates + ' faux négatifs en base');
    if (res.lastAt) bits.push('dernière passe il y a ' + ago(res.lastAt));
    if (res.busy) bits.push('analyse en cours…');
    else bits.push('déclenchement manuel');
    if (res.err) bits.push('⚠ ' + res.err);
    $('learnMeta').textContent = bits.join(' · ');
  }
  renderLearn();
}

// --- Ignorés : les lots dont la réponse du modèle n'a pas pu être lue --------
// C'est le seul endroit où l'on voit POURQUOI. `finish` tranche : budget épuisé
// (length / incomplete:max_output_tokens), réponse hors format (stop/completed
// avec une taille > 0), ou réponse vide (taille 0 = le raisonnement a tout pris).
let skipCache = [];
let skipRescue = {};

function loadSkips() {
  chrome.storage.local.get({ csg_skips: [], csg_skip_rescue: null, csg_audit: null }, (v) => {
    skipCache = Array.isArray(v.csg_skips) ? v.csg_skips : [];
    skipRescue = (v.csg_skip_rescue && typeof v.csg_skip_rescue === 'object')
      ? v.csg_skip_rescue
      : ((v.csg_audit && v.csg_audit.skipRescue) || {});
    renderSkips();
  });
}

function renderSkipRescue() {
  const meta = $('skipRescueMeta');
  const box = $('skipRescueBox');
  const q = Number(skipRescue.q) || 0;
  const done = Number(skipRescue.done) || 0;
  const log = Array.isArray(skipRescue.log) ? skipRescue.log : [];
  const bits = [];
  if (skipRescue.busy) bits.push('GLM 4.7 relit…');
  if (q) bits.push(q + ' en file');
  if (done) bits.push(done + ' relue' + (done > 1 ? 's' : ''));
  if (skipRescue.err) bits.push('⚠ ' + skipRescue.err);
  if (!bits.length) bits.push('Aucune reprise automatique en mode one-click');
  meta.textContent = bits.join(' · ');

  if (!log.length && !skipRescue.busy) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  box.className = 'audit' + (skipRescue.err ? ' err' : skipRescue.busy ? '' : ' ok');
  box.textContent = '';
  const head = document.createElement('div');
  head.className = 'audit-head';
  const chip = document.createElement('span');
  chip.className = 'chip ' + (skipRescue.busy ? 'pending' : skipRescue.err ? 'mute' : 'keep');
  chip.textContent = skipRescue.busy ? 'reprise' : skipRescue.err ? 'échec' : '4.7';
  head.appendChild(chip);
  const small = document.createElement('small');
  small.textContent = skipRescue.lane || 'glm-4.7-flash';
  head.appendChild(small);
  box.appendChild(head);
  if (log.length) {
    const ul = document.createElement('ul');
    ul.className = 'audit-ev';
    for (const r of log.slice(0, 8)) {
      const li = document.createElement('li');
      const act = r.action === 'mute' ? 'muté' : r.action === 'keep' ? 'gardé' : 'échec';
      li.textContent = act + ' · @' + (r.author || '?') + ' — ' + (r.preview || r.err || '');
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
}

function renderSkips() {
  const rows = skipCache;
  $('cSkips').textContent = String(rows.length);
  // Objectif 0 : le compteur de l'onglet s'allume dès le premier lot illisible.
  $('cSkips').classList.toggle('warn', rows.length > 0);
  renderSkipRescue();
  const body = $('skipRows');
  body.textContent = '';
  $('skipEmpty').style.display = rows.length ? 'none' : '';
  for (const r of rows) {
    if (!r) continue;
    const tr = document.createElement('tr');
    tr.appendChild(td(ago(r.at)));
    tr.appendChild(td(String(r.lane || '—')));
    tr.appendChild(td(String(r.n == null ? '—' : r.n)));
    // Le budget épuisé et la réponse vide sont les deux cas qui se soignent :
    // on les signale plutôt que de les noyer dans la colonne.
    const bad = /length|max_output_tokens/i.test(String(r.finish || '')) || Number(r.len) === 0;
    tr.appendChild(td(String(r.finish || '—'), bad ? 'bad' : ''));
    tr.appendChild(td(String(r.len == null ? '—' : r.len)));
    const raw = td(r.len ? String(r.raw || '') : '(vide)');
    raw.title = String(r.raw || '');
    tr.appendChild(raw);
    body.appendChild(tr);
  }
}

// Le diagnostic sert a etre COLLE quelque part : dans un rapport, dans une
// discussion. Un tableau HTML ne se copie pas proprement, du TSV si.
const TAB = '\t';
const NL = '\n';
$('copySkips').addEventListener('click', async () => {
  const head = ['heure', 'modele', 'msgs', 'finish', 'taille', 'brut'];
  const lines = [head.join(TAB)].concat(
    skipCache.filter(Boolean).map((r) =>
      [
        new Date(r.at || 0).toISOString(),
        r.lane || '',
        r.n == null ? '' : r.n,
        r.finish || '',
        r.len == null ? '' : r.len,
        String(r.raw || '').replace(/\s+/g, ' ')
      ].join(TAB)
    )
  );
  const txt = lines.join(NL);
  const btn = $('copySkips');
  try {
    await navigator.clipboard.writeText(txt);
    btn.textContent = 'Copie';
  } catch (_) {
    // clipboard peut etre refuse selon le contexte : on ne perd pas la donnee.
    downloadJsonl(skipCache, 'csg-ignores');
    btn.textContent = 'Telecharge';
  }
  setTimeout(() => {
    btn.textContent = 'Copier';
  }, 1500);
});

function renderLearn() {
  const terms = Array.isArray(learnCache.learned) ? learnCache.learned : [];
  $('cLearn').textContent = String(terms.length);
  const box = $('learnTerms');
  box.textContent = '';
  $('learnEmpty').style.display = terms.length ? 'none' : '';
  for (const t of terms.slice().reverse()) {
    if (!t || !t.w) continue;
    const chip = document.createElement('span');
    chip.className = 'term';
    const w = document.createElement('b');
    w.textContent = t.w;
    chip.appendChild(w);
    if (t.hits) {
      const n = document.createElement('i');
      n.textContent = t.hits + '×';
      n.title = 'Vu dans ' + t.hits + ' messages rejetés par le modèle';
      chip.appendChild(n);
    }
    // Compteur de révélations : c'est le terme qui est en sursis, pas le message.
    if (t.reveals) {
      const r = document.createElement('i');
      r.className = 'warn';
      r.textContent = '👁 ' + t.reveals + '/3';
      r.title = 'Révélé ' + t.reveals + ' fois — retiré automatiquement à 3';
      chip.appendChild(r);
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = 'Retirer et ne plus jamais reproposer';
    x.addEventListener('click', async () => {
      x.disabled = true;
      await send({ type: 'CSG_LEARN_REVOKE', w: t.w });
      loadLearn();
    });
    chip.appendChild(x);
    if (t.why) chip.title = t.why;
    box.appendChild(chip);
  }

  const rows = (Array.isArray(learnCache.log) ? learnCache.log : []).slice().reverse();
  const body = $('learnRows');
  body.textContent = '';
  $('learnLogEmpty').style.display = rows.length ? 'none' : '';
  for (const r of rows) {
    if (!r) continue;
    const tr = document.createElement('tr');
    tr.appendChild(td(r.at ? new Date(r.at).toLocaleString() : '—', 'num'));
    const act = document.createElement('span');
    act.className = 'chip ' + (r.action === 'add' ? 'keep' : r.action === 'revoke' ? 'mute' : 'dropped');
    act.textContent = r.action === 'add' ? 'ajouté' : r.action === 'revoke' ? 'révoqué' : 'refusé';
    tr.appendChild(td(act));
    tr.appendChild(td(r.w || '', 'txt'));
    tr.appendChild(td((r.reason || '') + (r.hits ? ' · ' + r.hits + ' preuves' : ''), 'txt'));
    body.appendChild(tr);
  }
}

$('learnRun').addEventListener('click', async () => {
  const b = $('learnRun');
  b.disabled = true;
  b.textContent = 'Analyse…';
  const r = await send({ type: 'CSG_LEARN_RUN' });
  b.disabled = false;
  b.textContent = 'Analyser maintenant';
  if (r && !r.ok && r.err) $('learnMeta').textContent = '⚠ ' + r.err;
  loadLearn();
});

// ------------------------------------------------------------- relecture
// La relecture hors live avait sept facons de rendre la main sans rien faire,
// et aucune ne se voyait. Cet onglet montre laquelle a parle, ce qui reste a
// relire, et surtout quels verdicts ont change d'avis.

function statLine(label, value, title) {
  const d = document.createElement('div');
  d.className = 'idle-stat';
  const k = document.createElement('span');
  k.textContent = label;
  const v = document.createElement('b');
  v.textContent = value;
  if (title) d.title = title;
  d.appendChild(k);
  d.appendChild(v);
  return d;
}

function renderIdle(idle) {
  const box = $('idleState');
  box.textContent = '';
  if (!idle) {
    box.textContent = 'Service worker endormi — rouvre le popup pour le réveiller.';
    return;
  }

  // Une ligne en clair AVANT les compteurs : c'est la reponse a « pourquoi il
  // ne se passe rien ».
  const head = document.createElement('p');
  head.className = 'idle-why';
  if (idle.busy) {
    head.textContent = '⏳ Relecture en cours' + (idle.reader ? ' · ' + idle.reader : '');
    head.classList.add('on');
  } else if (idle.err) {
    head.textContent = '⚠ Dernière erreur : ' + idle.err;
    head.classList.add('bad');
  } else if (idle.why) {
    head.textContent = 'ℹ ' + idle.why;
  } else {
    head.textContent = '✓ Prête — un lot ne part qu’avec « Relire maintenant ».';
    head.classList.add('on');
  }
  box.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'idle-grid';
  grid.appendChild(
    statLine(
      'À relire',
      String(idle.pending || 0) + (idle.pending >= 50 ? '+' : ''),
      idle.full
        ? 'Vérification complète : les verdicts locaux et les lignes relues il y a plus d’un jour sont comptés aussi. Compté jusqu’à 50.'
        : 'Messages du journal encore jamais relus. Compté jusqu’à 50.'
    )
  );
  grid.appendChild(
    statLine(
      'Portée',
      idle.full ? 'complète' : 'nouveaux',
      idle.full
        ? 'Relit aussi ce que la liste locale et les mots appris ont tranché seuls, et repasse une fois par jour. Un blocage démenti lève le mute et met en cause le terme fautif.'
        : 'Seules les lignes jamais relues, hors verdicts locaux.'
    )
  );
  grid.appendChild(statLine('Par lot', String(idle.batch || 0), 'Nombre de messages envoyés par appel.'));
  grid.appendChild(statLine('Relus', String(idle.reviewed || 0), 'Depuis le démarrage du service worker.'));
  grid.appendChild(statLine('Recherches web', String(idle.web || 0), 'Appels web_search de la lane profonde sur les mots inconnus.'));
  grid.appendChild(statLine('Relecteur', idle.reader || '—', 'Lane gratuite qui fait le premier passage.'));
  box.appendChild(grid);

  $('idleMeta').textContent = idle.lastRun ? 'dernier lot il y a ' + ago(idle.lastRun) : 'aucun lot depuis le démarrage';
}

function renderIdleTrail(trail) {
  const body = $('idleRows');
  const rows = Array.isArray(trail) ? trail : [];
  body.textContent = '';
  $('idleEmpty').classList.toggle('hidden', rows.length > 0);
  $('cIdle').textContent = String(rows.length);
  for (const r of rows) {
    const tr = document.createElement('tr');
    // Un verdict qui bascule est la seule chose qui justifie la relecture :
    // on le marque pour qu'il saute aux yeux dans la liste.
    if (r.act === 'mute' || r.act === 'revise') tr.className = 'idle-changed';
    tr.appendChild(td(ago(r.at)));
    tr.appendChild(td(r.author || '—'));
    const txt = td(r.text || '', 'txt');
    txt.title = r.text || '';
    tr.appendChild(txt);
    tr.appendChild(td(labelChip(r.before)));
    const after = td(labelChip(r.after));
    if (r.act === 'mute') after.title = 'La relecture a rattrapé un message laissé passer en direct.';
    if (r.act === 'revise') after.title = 'La relecture a innocenté un message bloqué à tort.';
    tr.appendChild(after);
    const lane = document.createElement('span');
    lane.textContent = r.lane || '';
    if (r.esc) {
      const chip = document.createElement('span');
      chip.className = 'chip pol';
      chip.textContent = 'web';
      chip.title = 'Le relecteur gratuit ne connaissait pas un mot : cette ligne est repartie sur la lane profonde avec recherche web.';
      lane.appendChild(document.createTextNode(' '));
      lane.appendChild(chip);
    }
    tr.appendChild(td(lane, 'txt'));
    body.appendChild(tr);
  }
}

async function loadIdle() {
  const res = await send({ type: 'CSG_AUDIT_STATS' });
  const idle = res && res.idle;
  renderIdle(idle);
  renderIdleTrail(idle && idle.trail);
}

$('idleRun').addEventListener('click', async () => {
  const b = $('idleRun');
  b.disabled = true;
  b.textContent = 'Relecture…';
  const r = await send({ type: 'CSG_IDLE_RUN' });
  b.disabled = false;
  b.textContent = 'Relire maintenant';
  if (r && r.err) $('idleMeta').textContent = '⚠ ' + r.err;
  else if (r && r.n === 0) $('idleMeta').textContent = 'rien à relire';
  loadIdle();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.csg_settings && changes.csg_settings.newValue) {
    if (changes.csg_settings.newValue.soundAlert !== undefined) {
      soundAlertOn = !!changes.csg_settings.newValue.soundAlert;
      renderSoundPill();
    }
    if (changes.csg_settings.newValue.streamerMode !== undefined) {
      streamerModeOn = !!changes.csg_settings.newValue.streamerMode;
      renderPrivacyPill();
    }
  }
  if (area !== 'local') return;
  if (changes.csg_sound_alert) {
    soundAlertOn = !!changes.csg_sound_alert.newValue;
    renderSoundPill();
  }
  if (changes.csg_muted || changes.csg_live_muted) {
    if (soundAlertOn) {
      const oldM = changes.csg_muted && changes.csg_muted.oldValue ? Object.keys(changes.csg_muted.oldValue).length : 0;
      const newM = changes.csg_muted && changes.csg_muted.newValue ? Object.keys(changes.csg_muted.newValue).length : 0;
      const oldL = changes.csg_live_muted && changes.csg_live_muted.oldValue ? Object.keys(changes.csg_live_muted.oldValue).length : 0;
      const newL = changes.csg_live_muted && changes.csg_live_muted.newValue ? Object.keys(changes.csg_live_muted.newValue).length : 0;
      if (newM > oldM || newL > oldL) {
        playNotificationChime();
      }
    }
    loadMutesSoon();
  }
  if (changes.csg_whitelist) {
    loadWhitelist();
  }
  if (changes.csg_reports) {
    if (soundAlertOn) {
      const getPending = (val) => {
        if (!val) return 0;
        const list = Array.isArray(val) ? val : Object.values(val);
        return list.filter((r) => r && !r.done).length;
      };
      const oldPending = getPending(changes.csg_reports.oldValue);
      const newPending = getPending(changes.csg_reports.newValue);
      if (newPending > oldPending) {
        playNotificationChime(true);
      }
    }
    loadReportsSoon();
  }
  if (changes.csg_author_notes) {
    loadAuthorNotes();
  }
  if (changes.csg_audit_log) {
    loadAuditLog();
  }
  if (changes.csg_streamer_mode) {
    streamerModeOn = !!changes.csg_streamer_mode.newValue;
    renderPrivacyPill();
  }
});

setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  const on = document.querySelector('.pane.on');
  if (on && (on.id === 'tab-chats' || (on.id === 'tab-log' && $('logAutoRefresh').checked))) loadLog();
  if (on && on.id === 'tab-report') loadReports();
  if (on && on.id === 'tab-mutes') renderLiveMutes();
  // Pastille disque : une lecture par minute suffit, l'envoi part toutes les 5 min.
  if (++diskTick % 10 === 0) loadDisk(false);
  if (typeof renderSessionPill === 'function') renderSessionPill();
  if (typeof renderPresetPill === 'function') renderPresetPill();
  if (typeof renderMoodPill === 'function') renderMoodPill();
}, 6000);
let diskTick = 0;

function applyInitialRoute() {
  let tab = '';
  let author = '';
  let q = '';
  let verdict = '';
  try {
    if (typeof location !== 'undefined') {
      let rawHash = (location.hash || '').replace(/^#/, '').trim();
      let hashQuery = '';
      const qIdx = rawHash.indexOf('?');
      if (qIdx !== -1) {
        hashQuery = rawHash.slice(qIdx + 1);
        rawHash = rawHash.slice(0, qIdx);
      }
      const hash = rawHash.toLowerCase();
      const searchStr = (location.search ? location.search.replace(/^\?/, '') : '') || hashQuery;
      const params = typeof URLSearchParams !== 'undefined' && searchStr ? new URLSearchParams(searchStr) : null;
      tab = (params && params.get('tab') ? params.get('tab').toLowerCase() : '') || hash;
      author = params ? (params.get('author') || '') : '';
      q = params ? (params.get('q') || '') : '';
      verdict = params ? (params.get('verdict') || '') : '';
    }
  } catch (_) {}

  const validTabs = ['mutes', 'log', 'chats', 'author', 'report'];
  if (author) {
    if ($('authorQuery')) $('authorQuery').value = author;
    goTab('author');
    if (typeof showAuthor === 'function') showAuthor(author);
  } else if (tab && validTabs.includes(tab)) {
    goTab(tab);
    if (tab === 'mutes') {
      if (q && $('muteSearch')) $('muteSearch').value = q;
      if (typeof refilterMutes === 'function') refilterMutes();
    } else if (tab === 'log') {
      if (verdict && $('logLabel')) $('logLabel').value = verdict;
      if (q && $('logSearch')) $('logSearch').value = q;
      if (typeof refilterLog === 'function') refilterLog();
    } else if (tab === 'report') {
      if (verdict && $('repVerdict')) $('repVerdict').value = verdict;
      if (q && $('repSearch')) $('repSearch').value = q;
      if (typeof renderReports === 'function') renderReports();
    }
  }
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('hashchange', applyInitialRoute);
}

loadMutes();
loadDisk(false);
loadLog();
loadReports();
loadAuthorNotes();
pollBulk();
applyInitialRoute();
loadAuditLog();
loadStreamerMode();
loadSessionStart();
loadActivePreset();
if (typeof renderMoodPill === 'function') renderMoodPill();
if (typeof loadModMacros === 'function') loadModMacros();
if (typeof loadRegexRules === 'function') loadRegexRules();

// ---------------------------------------------------------------- sauvegarde & restauration
let pendingBackupData = null;

async function getFullBackupPayload() {
  let settings = {};
  try {
    if (chrome.storage && chrome.storage.sync) {
      const res = await new Promise((r) => chrome.storage.sync.get({ csg_settings: {} }, r));
      settings = (res && res.csg_settings) || {};
    }
  } catch (_) {}

  return {
    refchatBackup: true,
    version: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '3.35.44'),
    exportedAt: new Date().toISOString(),
    settings,
    whitelist: whitelistCache || {},
    authorNotes: authorNotesCache || {},
    muted: mutedCache || {}
  };
}

async function updateBackupExportSummary() {
  const summaryEl = $('backupExportSummary');
  if (!summaryEl) return;
  const nWl = Object.keys(whitelistCache || {}).length;
  const nNotes = Object.keys(authorNotesCache || {}).length;
  const nMuted = Object.keys(mutedCache || {}).length;
  let nWords = 0;
  try {
    if (chrome.storage && chrome.storage.sync) {
      const res = await new Promise((r) => chrome.storage.sync.get({ csg_settings: {} }, r));
      const s = (res && res.csg_settings && res.csg_settings.extraWords) || '';
      if (s) nWords = s.split(/[,;\n]+/).filter((w) => w.trim()).length;
    }
  } catch (_) {}
  summaryEl.textContent = 'Prêt à exporter : ' +
    nWl + ' ' + (nWl > 1 ? 'auteurs protégés' : 'auteur protégé') + ' · ' +
    nNotes + ' ' + (nNotes > 1 ? 'notes' : 'note') + ' · ' +
    nWords + ' ' + (nWords > 1 ? 'mots bannis' : 'mot banni') + ' · ' +
    nMuted + ' ' + (nMuted > 1 ? 'auteurs mutés' : 'auteur muté') + '.';
}

function openBackupModal() {
  const modal = $('backupModal');
  if (!modal) return;
  pendingBackupData = null;
  if ($('backupFileInput')) $('backupFileInput').value = '';
  if ($('backupFileName')) $('backupFileName').textContent = 'Aucun fichier sélectionné';
  if ($('backupPreviewBox')) $('backupPreviewBox').classList.add('hidden');
  if ($('backupStatus')) $('backupStatus').classList.add('hidden');
  updateBackupExportSummary();
  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.classList.remove('hidden');
}

function closeBackupModal() {
  const modal = $('backupModal');
  if (!modal) return;
  pendingBackupData = null;
  if (typeof modal.close === 'function') modal.close();
  else modal.classList.add('hidden');
}

if ($('backupPill')) $('backupPill').addEventListener('click', openBackupModal);
if ($('backupModalClose')) $('backupModalClose').addEventListener('click', closeBackupModal);
if ($('backupModalOk')) $('backupModalOk').addEventListener('click', closeBackupModal);
const backupModalEl = $('backupModal');
if (backupModalEl) {
  backupModalEl.addEventListener('click', (e) => {
    if (e.target === backupModalEl) closeBackupModal();
  });
}

if ($('backupExportBtn')) {
  $('backupExportBtn').addEventListener('click', async () => {
    const payload = await getFullBackupPayload();
    downloadJson(payload, 'refchat-backup');
    const statusEl = $('backupStatus');
    if (statusEl) {
      statusEl.textContent = 'Sauvegarde téléchargée avec succès ✓';
      statusEl.classList.remove('hidden');
      setTimeout(() => statusEl.classList.add('hidden'), 3000);
    }
  });
}

if ($('backupChooseBtn') && $('backupFileInput')) {
  $('backupChooseBtn').addEventListener('click', () => {
    $('backupFileInput').click();
  });
  $('backupFileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if ($('backupFileName')) $('backupFileName').textContent = file.name;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const raw = ev.target.result;
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object') throw new Error('Format JSON invalide');
        const nWl = Object.keys(data.whitelist || {}).length;
        const nNotes = Object.keys(data.authorNotes || {}).length;
        const nMuted = Object.keys(data.muted || {}).length;
        pendingBackupData = data;
        if ($('backupPreviewText')) {
          $('backupPreviewText').textContent = 'Fichier valide (v' + (data.version || '?') + ' du ' + (data.exportedAt ? new Date(data.exportedAt).toLocaleDateString() : 'date inconnue') + ') : ' +
            nWl + ' whitelist, ' + nNotes + ' notes, ' + nMuted + ' mutés.';
        }
        if ($('backupPreviewBox')) $('backupPreviewBox').classList.remove('hidden');
      } catch (err) {
        pendingBackupData = null;
        alert('Fichier de sauvegarde invalide : ' + (err.message || 'erreur de lecture'));
        if ($('backupPreviewBox')) $('backupPreviewBox').classList.add('hidden');
      }
    };
    reader.readAsText(file);
  });
}

async function applyBackupData(data, replaceMode) {
  if (!data || typeof data !== 'object') return;
  const statusEl = $('backupStatus');

  if (replaceMode) {
    if (typeof confirm === 'function' && !confirm('Attention : le mode "Remplacer tout" écrasera votre whitelist, vos notes, mutés et réglages par ceux du fichier. Continuer ?')) {
      return;
    }
  }

  // 1. Settings (sync)
  if (data.settings && typeof data.settings === 'object') {
    try {
      if (chrome.storage && chrome.storage.sync) {
        if (replaceMode) {
          await new Promise((r) => chrome.storage.sync.set({ csg_settings: data.settings }, r));
        } else {
          const cur = await new Promise((r) => chrome.storage.sync.get({ csg_settings: {} }, r));
          const merged = Object.assign({}, cur.csg_settings || {}, data.settings);
          await new Promise((r) => chrome.storage.sync.set({ csg_settings: merged }, r));
        }
      }
    } catch (_) {}
  }

  // 2. Whitelist (local)
  if (data.whitelist && typeof data.whitelist === 'object') {
    if (replaceMode) {
      whitelistCache = Object.assign({}, data.whitelist);
    } else {
      whitelistCache = Object.assign({}, whitelistCache || {}, data.whitelist);
    }
    try {
      if (chrome.storage && chrome.storage.local) {
        await new Promise((r) => chrome.storage.local.set({ csg_whitelist: whitelistCache }, r));
      }
    } catch (_) {}
    renderWhitelist();
  }

  // 3. Notes modérateur (local)
  if (data.authorNotes && typeof data.authorNotes === 'object') {
    if (replaceMode) {
      authorNotesCache = Object.assign({}, data.authorNotes);
    } else {
      authorNotesCache = Object.assign({}, authorNotesCache || {}, data.authorNotes);
    }
    try {
      if (chrome.storage && chrome.storage.local) {
        await new Promise((r) => chrome.storage.local.set({ csg_author_notes: authorNotesCache }, r));
      }
    } catch (_) {}
  }

  // 4. Mutes (local)
  if (data.muted && typeof data.muted === 'object') {
    if (replaceMode) {
      mutedCache = Object.assign({}, data.muted);
    } else {
      mutedCache = Object.assign({}, mutedCache || {}, data.muted);
    }
    try {
      if (chrome.storage && chrome.storage.local) {
        await new Promise((r) => chrome.storage.local.set({ csg_muted: mutedCache }, r));
      }
    } catch (_) {}
    renderMutes();
  }

  if (statusEl) {
    statusEl.textContent = 'Configuration ' + (replaceMode ? 'remplacée' : 'fusionnée') + ' avec succès ✓';
    statusEl.classList.remove('hidden');
  }
  if (typeof recordAuditAction === 'function') {
    recordAuditAction({
      type: 'config',
      target: 'sauvegarde',
      detail: replaceMode ? 'restauration complète (remplacement)' : 'restauration (fusion)'
    });
  }
  if ($('backupPreviewBox')) $('backupPreviewBox').classList.add('hidden');
  updateBackupExportSummary();
  loadMutes();
}

if ($('backupApplyMerge')) {
  $('backupApplyMerge').addEventListener('click', () => {
    if (!pendingBackupData) return;
    applyBackupData(pendingBackupData, false);
  });
}
if ($('backupApplyReplace')) {
  $('backupApplyReplace').addEventListener('click', () => {
    if (!pendingBackupData) return;
    applyBackupData(pendingBackupData, true);
  });
}

// ---------------------------------------------------------------- raccourcis clavier
window.addEventListener('keydown', (e) => {
  const target = e.target;
  const tag = target && target.tagName;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if (e.key === 'Escape') {
    const helpModal = $('helpModal');
    if (helpModal && (helpModal.open || !helpModal.classList.contains('hidden'))) {
      closeHelpModal();
      return;
    }
    const backupModal = $('backupModal');
    if (backupModal && (backupModal.open || !backupModal.classList.contains('hidden'))) {
      closeBackupModal();
      return;
    }
    const auditModal = $('auditModal');
    if (auditModal && (auditModal.open || !auditModal.classList.contains('hidden'))) {
      closeAuditModal();
      return;
    }
    const sessionModal = $('sessionModal');
    if (sessionModal && (sessionModal.open || !sessionModal.classList.contains('hidden'))) {
      closeSessionModal();
      return;
    }
    const presetModal = $('presetModal');
    if (presetModal && (presetModal.open || !presetModal.classList.contains('hidden'))) {
      closePresetModal();
      return;
    }
    const moodModal = $('moodModal');
    if (moodModal && (moodModal.open || !moodModal.classList.contains('hidden'))) {
      closeMoodModal();
      return;
    }
    const macrosModal = $('macrosModal');
    if (macrosModal && (macrosModal.open || !macrosModal.classList.contains('hidden'))) {
      closeMacrosModal();
      return;
    }
    const regexModal = $('regexModal');
    if (regexModal && (regexModal.open || !regexModal.classList.contains('hidden'))) {
      closeRegexModal();
      return;
    }
    const whitelistModal = $('whitelistModal');
    if (whitelistModal && (whitelistModal.open || !whitelistModal.classList.contains('hidden'))) {
      closeWhitelistModal();
      return;
    }
    const wordsModal = $('wordsModal');
    if (wordsModal && (wordsModal.open || !wordsModal.classList.contains('hidden'))) {
      closeWordsModal();
      return;
    }
    const muteModal = $('muteModal');
    if (muteModal && (muteModal.open || !muteModal.classList.contains('hidden'))) {
      closeMuteModal();
      return;
    }
    if (isInput) {
      target.blur();
    } else {
      const activeSearch = document.querySelector('.pane.on .search');
      if (activeSearch) {
        activeSearch.value = '';
        activeSearch.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    return;
  }

  if (e.key === '?' && !isInput) {
    e.preventDefault();
    openHelpModal();
    return;
  }

  if (e.key === '/' && !isInput) {
    e.preventDefault();
    const activeSearch = document.querySelector('.pane.on .search');
    if (activeSearch) {
      activeSearch.focus();
      activeSearch.select();
    }
    return;
  }

  if (isInput) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const keyLower = String(e.key || '').toLowerCase();
  if (keyLower === 's') {
    e.preventDefault();
    if ($('soundPill')) $('soundPill').click();
    return;
  }
  if (keyLower === 'm') {
    e.preventDefault();
    openMuteModal('', $('muteChan') ? $('muteChan').value : '');
    return;
  }
  if (keyLower === 'w') {
    e.preventDefault();
    openWhitelistModal();
    return;
  }
  if (keyLower === 'b') {
    e.preventDefault();
    openWordsModal();
    return;
  }
  if (keyLower === 'c') {
    e.preventDefault();
    openBackupModal();
    return;
  }
  if (keyLower === 'h') {
    e.preventDefault();
    openAuditModal();
    return;
  }
  if (keyLower === 'p') {
    e.preventDefault();
    toggleStreamerMode();
    return;
  }
  if (keyLower === 'l') {
    e.preventDefault();
    openSessionModal();
    return;
  }
  if (keyLower === 'o') {
    e.preventDefault();
    openPresetModal();
    return;
  }
  if (keyLower === 'u') {
    e.preventDefault();
    openMoodModal();
    return;
  }
  if (keyLower === 'k') {
    e.preventDefault();
    openMacrosModal();
    return;
  }
  if (keyLower === 'x') {
    e.preventDefault();
    openRegexModal();
    return;
  }
  if (keyLower === 'r') {
    e.preventDefault();
    const on = document.querySelector('.pane.on');
    if (on) {
      if (on.id === 'tab-log') loadLog();
      else if (on.id === 'tab-report') loadReports();
      else if (on.id === 'tab-mutes') loadMutes();
      else if (on.id === 'tab-chats') loadLog();
      else if (on.id === 'tab-author' && $('authorQuery') && $('authorQuery').value) showAuthor($('authorQuery').value);
    }
    return;
  }

  if (e.key === '1') {
    goTab('mutes');
  } else if (e.key === '2') {
    goTab('log');
  } else if (e.key === '3') {
    goTab('chats');
  } else if (e.key === '4') {
    goTab('author');
  } else if (e.key === '5') {
    goTab('report');
  } else if (e.key === 'ArrowLeft') {
    const on = document.querySelector('.pane.on');
    if (on && on.id === 'tab-log' && $('logNewer') && !$('logNewer').disabled) {
      $('logNewer').click();
    }
  } else if (e.key === 'ArrowRight') {
    const on = document.querySelector('.pane.on');
    if (on && on.id === 'tab-log' && $('logOlder') && !$('logOlder').disabled) {
      $('logOlder').click();
    }
  }
});

// ---------------------------------------------------------------- journal d'audit
let auditLogCache = [];

function getAuditLog() {
  return auditLogCache;
}

function recordAuditAction(entry) {
  if (!entry || !entry.type) return null;
  const action = {
    id: 'aud_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    ts: entry.ts || Date.now(),
    type: String(entry.type || 'action'),
    target: String(entry.target || ''),
    detail: String(entry.detail || ''),
    channel: String(entry.channel || '')
  };
  auditLogCache.unshift(action);
  if (auditLogCache.length > 500) auditLogCache.length = 500;

  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ csg_audit_log: auditLogCache });
    }
  } catch (_) {}

  renderAuditPill();
  if ($('auditModal') && $('auditModal').open) {
    renderAuditLog();
  }
  return action;
}

function loadAuditLog() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ csg_audit_log: [] }, (res) => {
        auditLogCache = (res && Array.isArray(res.csg_audit_log)) ? res.csg_audit_log : [];
        renderAuditPill();
        if ($('auditModal') && $('auditModal').open) {
          renderAuditLog();
        }
      });
    }
  } catch (_) {}
}

function renderAuditPill() {
  const pill = $('auditPill');
  const countEl = $('auditPillCount');
  const count = auditLogCache ? auditLogCache.length : 0;
  if (countEl) countEl.textContent = String(count);
  if (pill) {
    pill.title = "Journal d'audit et historique des actions de modération (" + count + " actions) [H]";
  }
}

function openAuditModal() {
  const modal = $('auditModal');
  if (!modal) return;
  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.classList.remove('hidden');
  }
  modal.open = true;
  renderAuditLog();
}

function closeAuditModal() {
  const modal = $('auditModal');
  if (!modal) return;
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.classList.add('hidden');
  }
  modal.open = false;
}

function getFilteredAuditLogs() {
  const q = ($('auditSearch') ? $('auditSearch').value : '').trim().toLowerCase();
  const filterType = $('auditTypeFilter') ? $('auditTypeFilter').value : 'all';

  return auditLogCache.filter((item) => {
    if (!item) return false;
    if (filterType !== 'all') {
      if (filterType === 'mute' && item.type !== 'mute') return false;
      if (filterType === 'unmute' && item.type !== 'unmute') return false;
      if (filterType === 'whitelist' && !item.type.startsWith('whitelist')) return false;
      if (filterType === 'note' && !item.type.startsWith('note')) return false;
      if (filterType === 'report' && !item.type.startsWith('report')) return false;
      if (filterType === 'config' && item.type !== 'config' && item.type !== 'backup' && item.type !== 'words') return false;
    }
    if (q) {
      const matchTarget = (item.target || '').toLowerCase().includes(q);
      const matchDetail = (item.detail || '').toLowerCase().includes(q);
      const matchChan = (item.channel || '').toLowerCase().includes(q);
      const matchType = (item.type || '').toLowerCase().includes(q);
      if (!matchTarget && !matchDetail && !matchChan && !matchType) return false;
    }
    return true;
  });
}

function getAuditTypeBadge(type) {
  switch (type) {
    case 'mute':
      return { text: '🔴 Mute', cls: 'mute' };
    case 'unmute':
      return { text: '🟢 Démute', cls: 'unmute' };
    case 'whitelist':
    case 'whitelist_add':
      return { text: '🛡️ Whitelist', cls: 'whitelist' };
    case 'whitelist_remove':
      return { text: '🔓 Retiré WL', cls: 'whitelist' };
    case 'note':
    case 'note_set':
      return { text: '📝 Note', cls: 'note' };
    case 'note_delete':
      return { text: '🗑️ Note effacée', cls: 'note' };
    case 'report':
    case 'report_done':
      return { text: '✅ Signalement', cls: 'report' };
    case 'config':
    case 'backup':
    case 'words':
      return { text: '⚙️ Config', cls: 'config' };
    default:
      return { text: '⚡ ' + type, cls: 'config' };
  }
}

function renderAuditLog() {
  const listEl = $('auditList');
  const emptyEl = $('auditEmpty');
  const countEl = $('auditCount');
  if (!listEl) return;

  const filtered = getFilteredAuditLogs();
  const total = auditLogCache.length;

  if (countEl) {
    if (filtered.length === total) {
      countEl.textContent = total + (total > 1 ? ' actions' : ' action');
    } else {
      countEl.textContent = filtered.length + ' sur ' + total + (total > 1 ? ' actions' : ' action');
    }
  }

  listEl.innerHTML = '';
  if (filtered.length === 0) {
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');

  for (const item of filtered) {
    const row = document.createElement('div');
    row.className = 'audit-entry';
    row.dataset.id = item.id || '';

    const timeEl = document.createElement('span');
    timeEl.className = 'audit-time';
    const d = new Date(item.ts || Date.now());
    const hours = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    const secs = String(d.getSeconds()).padStart(2, '0');
    timeEl.textContent = hours + ':' + mins + ':' + secs;
    row.appendChild(timeEl);

    const badge = getAuditTypeBadge(item.type);
    const badgeEl = document.createElement('span');
    badgeEl.className = 'audit-badge ' + badge.cls;
    badgeEl.textContent = badge.text;
    row.appendChild(badgeEl);

    if (item.target) {
      const targetEl = document.createElement('span');
      targetEl.className = 'audit-target';
      targetEl.textContent = (item.target.startsWith('@') ? '' : '@') + item.target;
      targetEl.title = 'Inspecter le dossier de ' + item.target;
      targetEl.addEventListener('click', () => {
        closeAuditModal();
        goTab('author');
        if (typeof showAuthor === 'function') {
          showAuthor(item.target.replace(/^@+/, ''));
        }
      });
      row.appendChild(targetEl);
    }

    if (item.detail) {
      const detailEl = document.createElement('span');
      detailEl.className = 'audit-detail';
      detailEl.textContent = item.detail;
      detailEl.title = item.detail;
      row.appendChild(detailEl);
    }

    if (item.channel) {
      const chanEl = document.createElement('span');
      chanEl.className = 'audit-chan';
      chanEl.textContent = item.channel;
      row.appendChild(chanEl);
    }

    listEl.appendChild(row);
  }
}

function buildAuditMarkdownReport(list) {
  const items = list || getFilteredAuditLogs();
  const dateStr = new Date().toLocaleString('fr-FR');
  const lines = [];
  lines.push('📋 **JOURNAL D\'AUDIT MODÉRATION REFCHAT** (' + items.length + ' actions)');
  lines.push('Généré le ' + dateStr);
  lines.push('──────────────────────────────────────────');

  for (const it of items) {
    const d = new Date(it.ts || Date.now());
    const time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
    const badge = getAuditTypeBadge(it.type);
    const target = it.target ? (it.target.startsWith('@') ? it.target : '@' + it.target) : '';
    const details = [it.detail, it.channel].filter(Boolean).join(' · ');
    lines.push('• [' + time + '] ' + badge.text + ' ' + target + (details ? ' (' + details + ')' : ''));
  }

  lines.push('──────────────────────────────────────────');
  lines.push('*Rapport exporté depuis Refchat Extension.*');
  return lines.join('\n');
}

function downloadAuditCsv(list) {
  const items = list || getFilteredAuditLogs();
  const rows = [
    ['id', 'timestamp', 'date', 'heure', 'type', 'cible', 'canal', 'detail']
  ];
  for (const it of items) {
    const d = new Date(it.ts || Date.now());
    const dateStr = d.toISOString().slice(0, 10);
    const timeStr = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
    rows.push([
      it.id || '',
      String(it.ts || ''),
      dateStr,
      timeStr,
      it.type || '',
      it.target || '',
      it.channel || '',
      it.detail || ''
    ]);
  }
  const csvContent = rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n') + '\r\n';
  if (typeof saveBlob === 'function') {
    saveBlob(new Blob([csvContent], { type: 'text/csv;charset=utf-8' }), 'refchat-audit-' + new Date().toISOString().slice(0, 10) + '.csv');
  }
}

if ($('auditPill')) {
  $('auditPill').addEventListener('click', openAuditModal);
}
if ($('auditModalClose')) {
  $('auditModalClose').addEventListener('click', closeAuditModal);
}
if ($('auditModalOk')) {
  $('auditModalOk').addEventListener('click', closeAuditModal);
}
if ($('auditSearch')) {
  $('auditSearch').addEventListener('input', renderAuditLog);
}
if ($('auditTypeFilter')) {
  $('auditTypeFilter').addEventListener('change', renderAuditLog);
}
if ($('auditCopyBtn')) {
  $('auditCopyBtn').addEventListener('click', async () => {
    const text = buildAuditMarkdownReport();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      const btn = $('auditCopyBtn');
      const old = btn.textContent;
      btn.textContent = 'Rapport copié ✓';
      setTimeout(() => { btn.textContent = old; }, 1800);
    }
  });
}
if ($('auditExportJson')) {
  $('auditExportJson').addEventListener('click', () => {
    const filtered = getFilteredAuditLogs();
    if (typeof downloadJson === 'function') {
      downloadJson(filtered, 'refchat-audit-' + new Date().toISOString().slice(0, 10));
    }
  });
}
if ($('auditExportCsv')) {
  $('auditExportCsv').addEventListener('click', () => {
    downloadAuditCsv();
  });
}
if ($('auditClearBtn')) {
  $('auditClearBtn').addEventListener('click', () => {
    if (confirm('Effacer l\'ensemble de l\'historique d\'audit ?')) {
      auditLogCache = [];
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ csg_audit_log: [] });
      }
      renderAuditPill();
      renderAuditLog();
    }
  });
}

// --- fin journal audit ---

// ------------------------------------------------------------ mode streamer & confidentialité
let streamerModeOn = false;

function renderPrivacyPill() {
  const pill = $('privacyPill');
  if (!pill) return;
  const label = pill.querySelector('span');
  if (streamerModeOn) {
    pill.classList.add('ok');
    if (label) label.textContent = 'Mode Streamer actif';
    pill.title = 'Mode Streamer actif : contenus sensibles et mémos floutés (clic ou touche [P] pour couper)';
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.add('streamer-mode');
    }
  } else {
    pill.classList.remove('ok');
    if (label) label.textContent = 'Mode Streamer';
    pill.title = 'Mode Streamer désactivé : afficher en clair (clic ou touche [P] pour activer)';
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.remove('streamer-mode');
    }
  }
}

function setStreamerMode(on) {
  streamerModeOn = !!on;
  renderPrivacyPill();
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      if (chrome.storage.local) {
        chrome.storage.local.set({ csg_streamer_mode: streamerModeOn });
      }
      if (chrome.storage.sync) {
        chrome.storage.sync.get({ csg_settings: {} }, ({ csg_settings }) => {
          chrome.storage.sync.set({ csg_settings: Object.assign({}, csg_settings, { streamerMode: streamerModeOn }) });
        });
      }
    }
  } catch (_) {}
  if (typeof recordAuditAction === 'function') {
    recordAuditAction({
      type: 'config',
      target: 'mode_streamer',
      detail: streamerModeOn ? 'activé (floutage anti-ban)' : 'désactivé'
    });
  }
}

function toggleStreamerMode() {
  setStreamerMode(!streamerModeOn);
}

function loadStreamerMode() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      if (chrome.storage.local) {
        chrome.storage.local.get({ csg_streamer_mode: false }, (res) => {
          if (res && res.csg_streamer_mode !== undefined) {
            streamerModeOn = !!res.csg_streamer_mode;
            renderPrivacyPill();
          }
        });
      }
      if (chrome.storage.sync) {
        chrome.storage.sync.get({ csg_settings: {} }, ({ csg_settings }) => {
          if (csg_settings && csg_settings.streamerMode !== undefined) {
            streamerModeOn = !!csg_settings.streamerMode;
            renderPrivacyPill();
          }
        });
      }
    }
  } catch (_) {}
}

if ($('privacyPill')) {
  $('privacyPill').addEventListener('click', toggleStreamerMode);
}

// --- fin mode streamer ---

// ------------------------------------------------------------ bilan de session live
let sessionStartTs = Date.now();

function loadSessionStart() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ csg_session_start: 0 }, (res) => {
        if (res && res.csg_session_start && Number(res.csg_session_start) > 0) {
          sessionStartTs = Number(res.csg_session_start);
        } else {
          sessionStartTs = Date.now();
          chrome.storage.local.set({ csg_session_start: sessionStartTs });
        }
        renderSessionPill();
      });
    } else {
      renderSessionPill();
    }
  } catch (_) {
    renderSessionPill();
  }
}

function getSessionDuration(now) {
  const diffMs = Math.max(0, (now || Date.now()) - sessionStartTs);
  const totalMins = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours > 0) {
    return hours + ' h ' + (mins < 10 ? '0' : '') + mins + ' min';
  }
  return totalMins + ' min';
}

function renderSessionPill() {
  const pill = $('sessionPill');
  if (!pill) return;
  const now = Date.now();
  const diffMs = Math.max(0, now - sessionStartTs);
  const totalMins = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  const shortStr = hours > 0 ? (hours + 'h' + (mins < 10 ? '0' : '') + mins) : (totalMins + 'm');
  const span = pill.querySelector('span');
  if (span) {
    span.innerHTML = 'Session <b>' + shortStr + '</b>';
  }
  pill.title = 'Bilan de la session live en cours (durée : ' + getSessionDuration(now) + ') [L]';
}

function computeSessionStats() {
  const now = Date.now();
  const msgs = (typeof logCache !== 'undefined' && Array.isArray(logCache)) ? logCache : [];
  const sessionMsgs = msgs.filter((m) => m && (!m.ts || m.ts >= sessionStartTs));
  const total = sessionMsgs.length;

  let rejectedCount = 0;
  const chanMap = {};
  const reoffendersMap = {};

  for (const m of sessionMsgs) {
    const isRej = (typeof rowLabel === 'function' && rowLabel(m) === 'mute') || (m && m.codexVerdict === 'mute');
    if (isRej) rejectedCount++;

    const ch = m.channel || 'inconnu';
    if (!chanMap[ch]) chanMap[ch] = { channel: ch, total: 0, rejected: 0 };
    chanMap[ch].total++;
    if (isRej) chanMap[ch].rejected++;

    if (isRej && m.author) {
      const auth = String(m.author).toLowerCase();
      if (!reoffendersMap[auth]) {
        reoffendersMap[auth] = { author: m.author, count: 0, lastReason: m.codexReason || m.source || 'rejet', lastChan: ch };
      }
      reoffendersMap[auth].count++;
    }
  }

  const rate = total > 0 ? ((rejectedCount / total) * 100).toFixed(1) + '%' : '0.0%';
  const channels = Object.values(chanMap).sort((a, b) => b.total - a.total);
  const topReoffenders = Object.values(reoffendersMap).sort((a, b) => b.count - a.count).slice(0, 5);

  let mutesCount = 0;
  if (typeof mutedCache !== 'undefined' && mutedCache) {
    for (const k of Object.keys(mutedCache)) {
      const muteItem = mutedCache[k];
      if (muteItem && muteItem.at && muteItem.at >= sessionStartTs) {
        mutesCount++;
      }
    }
  }

  return {
    startedAt: new Date(sessionStartTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    startedDate: new Date(sessionStartTs).toLocaleDateString(),
    durationStr: getSessionDuration(now),
    totalMessages: total,
    rejectedCount,
    rejectionRate: rate,
    mutesCount,
    channels,
    topReoffenders
  };
}

function renderSessionModal() {
  const stats = computeSessionStats();

  if ($('sessionDuration')) $('sessionDuration').textContent = stats.durationStr;
  if ($('sessionStartedAt')) $('sessionStartedAt').textContent = 'lancée à ' + stats.startedAt;
  if ($('sessionTotalMsgs')) $('sessionTotalMsgs').textContent = Number(stats.totalMessages).toLocaleString();
  if ($('sessionRejections')) $('sessionRejections').textContent = stats.rejectedCount + ' (' + stats.rejectionRate + ')';
  if ($('sessionMutesCount')) $('sessionMutesCount').textContent = String(stats.mutesCount);

  const chanList = $('sessionChanList');
  const chanEmpty = $('sessionChanEmpty');
  if (chanList) {
    chanList.innerHTML = '';
    if (!stats.channels.length) {
      if (chanEmpty) chanEmpty.classList.remove('hidden');
    } else {
      if (chanEmpty) chanEmpty.classList.add('hidden');
      for (const c of stats.channels) {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.padding = '2px 0';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = c.channel;
        nameSpan.style.fontWeight = '500';

        const rateSpan = document.createElement('span');
        rateSpan.className = 'meta';
        rateSpan.textContent = c.total + ' msg · ' + c.rejected + ' rej';
        if (c.rejected > 0) rateSpan.style.color = 'var(--bad, #f85149)';

        row.appendChild(nameSpan);
        row.appendChild(rateSpan);
        chanList.appendChild(row);
      }
    }
  }

  const reoffList = $('sessionReoffendersList');
  const reoffEmpty = $('sessionReoffendersEmpty');
  if (reoffList) {
    reoffList.innerHTML = '';
    if (!stats.topReoffenders.length) {
      if (reoffEmpty) reoffEmpty.classList.remove('hidden');
    } else {
      if (reoffEmpty) reoffEmpty.classList.add('hidden');
      for (const r of stats.topReoffenders) {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.padding = '2px 0';

        const nameLink = document.createElement('span');
        nameLink.textContent = '@' + r.author;
        nameLink.style.color = 'var(--primary, #58a6ff)';
        nameLink.style.cursor = 'pointer';
        nameLink.style.fontWeight = '600';
        nameLink.title = 'Inspecter le dossier de @' + r.author;
        nameLink.addEventListener('click', () => {
          closeSessionModal();
          goTab('author');
          if (typeof showAuthor === 'function') showAuthor(r.author);
        });

        const rejSpan = document.createElement('span');
        rejSpan.style.color = 'var(--bad, #f85149)';
        rejSpan.style.fontWeight = '600';
        rejSpan.textContent = r.count + ' rejets';

        row.appendChild(nameLink);
        row.appendChild(rejSpan);
        reoffList.appendChild(row);
      }
    }
  }
}

function openSessionModal() {
  const modal = $('sessionModal');
  if (!modal) return;
  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.classList.remove('hidden');
  }
  modal.open = true;
  renderSessionModal();
}

function closeSessionModal() {
  const modal = $('sessionModal');
  if (!modal) return;
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.classList.add('hidden');
  }
  modal.open = false;
}

function buildSessionMarkdownReport(stats) {
  const s = stats || computeSessionStats();
  const lines = [];
  lines.push('📊 **BILAN DE SESSION REFCHAT**');
  lines.push('📅 Date : ' + s.startedDate + ' (démarrée à ' + s.startedAt + ' · Durée : ' + s.durationStr + ')');
  lines.push('────────────────────────────────────────');
  lines.push('💬 **Messages analysés** : ' + Number(s.totalMessages).toLocaleString());
  lines.push('🛡️ **Taux d\'infraction** : ' + s.rejectionRate + ' (' + s.rejectedCount + ' rejets)');
  lines.push('🔴 **Sanctions appliquées** : ' + s.mutesCount + ' mutes');

  if (s.channels && s.channels.length) {
    lines.push('────────────────────────────────────────');
    lines.push('📡 **Activité par chaîne** :');
    for (const c of s.channels.slice(0, 4)) {
      lines.push('• ' + c.channel + ' : ' + c.total + ' messages (' + c.rejected + ' rejets)');
    }
  }

  if (s.topReoffenders && s.topReoffenders.length) {
    lines.push('────────────────────────────────────────');
    lines.push('🚨 **Principaux récidivistes** :');
    for (const r of s.topReoffenders) {
      lines.push('• @' + r.author + ' : ' + r.count + ' rejets (' + r.lastReason + ' sur ' + r.lastChan + ')');
    }
  }

  lines.push('────────────────────────────────────────');
  lines.push('*Rapport exporté depuis Refchat Extension.*');
  return lines.join('\n');
}

function resetLiveSession() {
  sessionStartTs = Date.now();
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ csg_session_start: sessionStartTs });
    }
  } catch (_) {}
  if (typeof recordAuditAction === 'function') {
    recordAuditAction({
      type: 'config',
      target: 'session',
      detail: 'nouvelle session live démarrée'
    });
  }
  renderSessionPill();
  renderSessionModal();
}

if ($('sessionPill')) {
  $('sessionPill').addEventListener('click', openSessionModal);
}
if ($('sessionModalClose')) {
  $('sessionModalClose').addEventListener('click', closeSessionModal);
}
if ($('sessionModalOk')) {
  $('sessionModalOk').addEventListener('click', closeSessionModal);
}
if ($('sessionCopyBtn')) {
  $('sessionCopyBtn').addEventListener('click', async () => {
    const text = buildSessionMarkdownReport();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      const btn = $('sessionCopyBtn');
      const old = btn.textContent;
      btn.textContent = 'Bilan copié ✓';
      setTimeout(() => { btn.textContent = old; }, 1800);
    }
  });
}
if ($('sessionExportJson')) {
  $('sessionExportJson').addEventListener('click', () => {
    const stats = computeSessionStats();
    if (typeof downloadJson === 'function') {
      downloadJson(stats, 'refchat-session-' + new Date().toISOString().slice(0, 10));
    }
  });
}
if ($('sessionResetBtn')) {
  $('sessionResetBtn').addEventListener('click', () => {
    if (confirm('Démarrer une nouvelle session live ? Le chronomètre et les compteurs de session seront remis à zéro.')) {
      resetLiveSession();
    }
  });
}

// --- fin bilan session live ---

// ------------------------------------------------------------ profils de modération live
const MOD_PRESETS = {
  standard: {
    id: 'standard',
    name: 'Standard',
    icon: '⚖️',
    badge: 'Équilibré',
    desc: 'Modération équilibrée quotidienne, alertes sonores actives et pause ambiance activée.',
    soundAlert: true,
    ambiencePause: true,
    streamerMode: false,
    extraWords: ''
  },
  chill: {
    id: 'chill',
    name: 'Chill',
    icon: '🟢',
    badge: 'Décontracté',
    desc: 'Pour Just Chatting ou streams calmes : alertes sonores coupées, pas de coupures intempestives.',
    soundAlert: false,
    ambiencePause: false,
    streamerMode: false,
    extraWords: ''
  },
  competitive: {
    id: 'competitive',
    name: 'Compétitif',
    icon: '⚔️',
    badge: 'Anti-Backseat',
    desc: 'Pour sessions classées ou tournois : filtrage actif des conseils non sollicités, spoilers, toxicité et tilt.',
    soundAlert: true,
    ambiencePause: true,
    streamerMode: false,
    extraWords: 'backseat, spoil, spoiler, noob, nullard, choke, chokeur, cheat, cheater, uninstall'
  },
  raid: {
    id: 'raid',
    name: 'Bouclier Raid',
    icon: '🛡️',
    badge: 'Urgence',
    desc: 'Défense maximale : bloque les spams de liens, invites Discord/Telegram, faux follows et flood agressif.',
    soundAlert: true,
    ambiencePause: true,
    streamerMode: true,
    extraWords: 'discord.gg, t.me, follow-bot, twitch.tv/, kick.com/, buy followers, best viewers, free followers, promo, raid'
  }
};

let activePresetId = 'standard';
let selectedPresetId = 'standard';
let customPresetsCache = {};

function getPresetConfig(id) {
  const base = MOD_PRESETS[id] || MOD_PRESETS.standard;
  const custom = (customPresetsCache && customPresetsCache[id]) || {};
  return Object.assign({}, base, custom);
}

function renderPresetPill() {
  const pill = $('presetPill');
  if (!pill) return;
  const cfg = getPresetConfig(activePresetId);
  const span = pill.querySelector('span');
  if (span) {
    span.innerHTML = 'Profil <b>' + cfg.icon + ' ' + cfg.name + '</b>';
  }
  pill.title = 'Profil de modération actif : ' + cfg.name + ' (' + cfg.badge + ') [O]';
}

function loadActivePreset() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ csg_active_preset: 'standard', csg_custom_presets: {} }, (res) => {
        if (res && res.csg_active_preset && MOD_PRESETS[res.csg_active_preset]) {
          activePresetId = res.csg_active_preset;
          selectedPresetId = activePresetId;
        }
        if (res && typeof res.csg_custom_presets === 'object' && res.csg_custom_presets) {
          customPresetsCache = res.csg_custom_presets;
        }
        renderPresetPill();
      });
    } else {
      renderPresetPill();
    }
  } catch (_) {
    renderPresetPill();
  }
}

function renderPresetModal() {
  const container = $('presetCardsList');
  if (container) {
    container.innerHTML = '';
    for (const [id, def] of Object.entries(MOD_PRESETS)) {
      const cfg = getPresetConfig(id);
      const isCurrentActive = (id === activePresetId);
      const isSelected = (id === selectedPresetId);

      const card = document.createElement('div');
      card.className = 'card' + (isCurrentActive ? ' on' : '');
      card.style.display = 'flex';
      card.style.flexDirection = 'column';
      card.style.gap = '6px';
      card.style.padding = '10px';
      card.style.borderRadius = '8px';
      card.style.border = '1px solid ' + (isSelected ? 'var(--primary, #58a6ff)' : 'var(--border)');
      card.style.background = isSelected ? 'rgba(88, 166, 255, 0.08)' : 'var(--bg-card)';
      card.style.cursor = 'pointer';

      const head = document.createElement('div');
      head.style.display = 'flex';
      head.style.alignItems = 'center';
      head.style.justifyContent = 'space-between';

      const titleWrap = document.createElement('div');
      titleWrap.style.display = 'flex';
      titleWrap.style.alignItems = 'center';
      titleWrap.style.gap = '6px';

      const iconSpan = document.createElement('span');
      iconSpan.style.fontSize = '16px';
      iconSpan.textContent = cfg.icon;

      const nameSpan = document.createElement('strong');
      nameSpan.textContent = cfg.name;
      nameSpan.style.fontSize = '13px';

      titleWrap.appendChild(iconSpan);
      titleWrap.appendChild(nameSpan);

      const badge = document.createElement('span');
      badge.className = 'chip ' + (isCurrentActive ? 'ok' : 'pending');
      badge.style.fontSize = '10px';
      badge.textContent = isCurrentActive ? 'Actif ✓' : cfg.badge;

      head.appendChild(titleWrap);
      head.appendChild(badge);
      card.appendChild(head);

      const desc = document.createElement('p');
      desc.className = 'meta';
      desc.style.fontSize = '11.5px';
      desc.style.margin = '2px 0 6px 0';
      desc.textContent = cfg.desc;
      card.appendChild(desc);

      const features = document.createElement('div');
      features.style.display = 'flex';
      features.style.gap = '8px';
      features.style.fontSize = '11px';
      features.style.color = 'var(--muted)';
      features.style.marginTop = 'auto';

      const soundTag = document.createElement('span');
      soundTag.textContent = cfg.soundAlert ? '🔔 Son' : '🔕 Muet';

      const ambTag = document.createElement('span');
      ambTag.textContent = cfg.ambiencePause ? '⏸️ Pause' : '▶️ Sans pause';

      const stTag = document.createElement('span');
      stTag.textContent = cfg.streamerMode ? '🙈 Streamer' : '👁️ Standard';

      features.appendChild(soundTag);
      features.appendChild(ambTag);
      features.appendChild(stTag);
      card.appendChild(features);

      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = isCurrentActive ? 'btn small disabled' : 'primary small';
      actionBtn.style.marginTop = '6px';
      actionBtn.style.fontSize = '11.5px';
      actionBtn.style.height = '26px';
      actionBtn.textContent = isCurrentActive ? 'Profil actif' : 'Activer ce profil';
      actionBtn.disabled = isCurrentActive;
      actionBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        applyPreset(id);
      });
      card.appendChild(actionBtn);

      card.addEventListener('click', () => {
        selectedPresetId = id;
        renderPresetModal();
      });

      container.appendChild(card);
    }
  }

  // Remplissage du panneau de personnalisation
  const selCfg = getPresetConfig(selectedPresetId);
  if ($('presetCurrentName')) $('presetCurrentName').textContent = selCfg.name;
  if ($('presetSoundToggle')) $('presetSoundToggle').checked = selCfg.soundAlert;
  if ($('presetAmbienceToggle')) $('presetAmbienceToggle').checked = selCfg.ambiencePause;
  if ($('presetStreamerToggle')) $('presetStreamerToggle').checked = selCfg.streamerMode;
  if ($('presetCustomWords')) $('presetCustomWords').value = selCfg.extraWords || '';
  if ($('presetActiveHint')) {
    const actCfg = getPresetConfig(activePresetId);
    $('presetActiveHint').textContent = 'Profil actif : ' + actCfg.icon + ' ' + actCfg.name + ' (' + actCfg.badge + ')';
  }
}

function openPresetModal() {
  const modal = $('presetModal');
  if (!modal) return;
  selectedPresetId = activePresetId;
  if ($('presetStatus')) $('presetStatus').classList.add('hidden');
  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.classList.remove('hidden');
  }
  modal.open = true;
  renderPresetModal();
}

function closePresetModal() {
  const modal = $('presetModal');
  if (!modal) return;
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.classList.add('hidden');
  }
  modal.open = false;
}

async function applyPreset(id) {
  if (!MOD_PRESETS[id]) return;
  activePresetId = id;
  selectedPresetId = id;
  const cfg = getPresetConfig(id);

  // Mise à jour de csg_settings
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      if (chrome.storage.sync) {
        chrome.storage.sync.get({ csg_settings: {} }, ({ csg_settings }) => {
          const updated = Object.assign({}, csg_settings, {
            soundAlert: cfg.soundAlert,
            ambiencePause: cfg.ambiencePause,
            streamerMode: cfg.streamerMode,
            extraWords: cfg.extraWords
          });
          chrome.storage.sync.set({ csg_settings: updated });
        });
      }
      if (chrome.storage.local) {
        chrome.storage.local.set({
          csg_active_preset: id,
          csg_sound_alert: cfg.soundAlert,
          csg_streamer_mode: cfg.streamerMode
        });
      }
    }
  } catch (_) {}

  // Mise à jour du mode streamer si nécessaire
  if (typeof setStreamerMode === 'function') {
    setStreamerMode(cfg.streamerMode);
  }

  // Traçabilité dans le journal d'audit
  if (typeof recordAuditAction === 'function') {
    recordAuditAction({
      type: 'config',
      target: 'preset',
      detail: 'profil modérateur basculé sur ' + cfg.name + ' (' + cfg.badge + ')'
    });
  }

  renderPresetPill();
  renderPresetModal();

  const statusEl = $('presetStatus');
  if (statusEl) {
    statusEl.textContent = 'Profil ' + cfg.name + ' activé avec succès ✓';
    statusEl.classList.remove('hidden');
    setTimeout(() => { if (statusEl) statusEl.classList.add('hidden'); }, 2000);
  }
}

function saveCustomPresetConfig() {
  const id = selectedPresetId;
  if (!MOD_PRESETS[id]) return;
  const soundAlert = $('presetSoundToggle') ? $('presetSoundToggle').checked : false;
  const ambiencePause = $('presetAmbienceToggle') ? $('presetAmbienceToggle').checked : false;
  const streamerMode = $('presetStreamerToggle') ? $('presetStreamerToggle').checked : false;
  const extraWords = $('presetCustomWords') ? $('presetCustomWords').value.trim() : '';

  if (!customPresetsCache[id]) customPresetsCache[id] = {};
  customPresetsCache[id] = { soundAlert, ambiencePause, streamerMode, extraWords };

  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ csg_custom_presets: customPresetsCache });
    }
  } catch (_) {}

  // Si on modifie le profil actuellement actif, on réapplique
  if (id === activePresetId) {
    applyPreset(id);
  } else {
    renderPresetModal();
    const statusEl = $('presetStatus');
    if (statusEl) {
      statusEl.textContent = 'Modifications enregistrées pour ' + MOD_PRESETS[id].name + ' ✓';
      statusEl.classList.remove('hidden');
      setTimeout(() => { if (statusEl) statusEl.classList.add('hidden'); }, 2000);
    }
  }
}

if ($('presetPill')) {
  $('presetPill').addEventListener('click', openPresetModal);
}
if ($('presetModalClose')) {
  $('presetModalClose').addEventListener('click', closePresetModal);
}
if ($('presetModalOk')) {
  $('presetModalOk').addEventListener('click', closePresetModal);
}
if ($('presetSaveCustomBtn')) {
  $('presetSaveCustomBtn').addEventListener('click', saveCustomPresetConfig);
}

// --- fin profils de modération live ---

// ------------------------------------------------------------ baromètre d'ambiance et humeur
const MOOD_POS_REGEX = /\b(gg|wp|pog|poggers|pogchamp|lul|kekw|w|coeur|merci|bravo|felicitation|felicitations|incroyable|monstre|pro|clip|hype|masterclass|love|banger)\b|[❤️🔥🎉👏✨😍🥰😃🥳]/i;
const MOOD_NEG_REGEX = /\b(choke|chokeur|noob|nullard|cheat|cheater|uninstall|degage|merde|nul|troll|cancer|honte|degueu|degueulasse|rageux|tilt|salope|connard|encule|fdp|tg)\b/i;

function computeChatAtmosphere() {
  const msgs = (typeof logCache !== 'undefined' && Array.isArray(logCache)) ? logCache : [];
  // Échantillon sur les 60 derniers messages du journal
  const sample = msgs.slice(0, 60);
  const total = sample.length;

  if (total === 0) {
    return {
      total: 0,
      posCount: 0,
      negCount: 0,
      neuCount: 0,
      posPct: 0,
      negPct: 0,
      neuPct: 100,
      score: 100,
      state: 'Sereine & Stable',
      icon: '🟢',
      cls: 'ok',
      trend: '➡️ Stable',
      spike: false,
      recommendation: 'Le chat est calme. Aucune mesure de restriction requise.'
    };
  }

  let posCount = 0;
  let negCount = 0;
  let neuCount = 0;

  for (const m of sample) {
    const isRej = (typeof rowLabel === 'function' && rowLabel(m) === 'mute') || (m && m.codexVerdict === 'mute');
    const txt = (m && m.text) || '';
    if (isRej || MOOD_NEG_REGEX.test(txt)) {
      negCount++;
    } else if (MOOD_POS_REGEX.test(txt)) {
      posCount++;
    } else {
      neuCount++;
    }
  }

  const posPct = Math.round((posCount / total) * 100);
  const negPct = Math.round((negCount / total) * 100);
  const neuPct = Math.max(0, 100 - posPct - negPct);

  // Score calculé : base 100 pondérée par les rejets et bonifiée par les compliments/hype
  let score = Math.max(0, Math.min(100, Math.round(100 - (negPct * 1.5) + (posPct * 0.35))));

  let state = 'Sereine & Stable';
  let icon = '🟡';
  let cls = 'ok';

  if (score >= 75) {
    state = 'Excellente & Hype';
    icon = '🟢';
    cls = 'ok';
  } else if (score >= 50) {
    state = 'Sereine & Stable';
    icon = '🟡';
    cls = 'ok';
  } else if (score >= 30) {
    state = 'Tendue & Agitée';
    icon = '🟠';
    cls = 'warn';
  } else {
    state = 'Hostile & Toxique';
    icon = '🔴';
    cls = 'bad';
  }

  // Calcul de la tendance (comparaison des 20 derniers messages vs les 20 précédents)
  let trend = '➡️ Stable';
  if (total >= 10) {
    const half = Math.min(20, Math.floor(total / 2));
    const recent = sample.slice(0, half);
    const older = sample.slice(half, half * 2);

    const recNeg = recent.filter((m) => (typeof rowLabel === 'function' && rowLabel(m) === 'mute') || (m && m.codexVerdict === 'mute') || MOOD_NEG_REGEX.test(m.text || '')).length;
    const oldNeg = older.filter((m) => (typeof rowLabel === 'function' && rowLabel(m) === 'mute') || (m && m.codexVerdict === 'mute') || MOOD_NEG_REGEX.test(m.text || '')).length;

    const recRate = recent.length ? recNeg / recent.length : 0;
    const oldRate = older.length ? oldNeg / older.length : 0;

    if (recRate > oldRate + 0.1) {
      trend = '↘️ En baisse';
    } else if (recRate < oldRate - 0.1) {
      trend = '↗️ En hausse';
    }
  }

  // Détection de pic de tension récent (dans les 15 derniers messages)
  const recentSlice = sample.slice(0, 15);
  const recentNeg = recentSlice.filter((m) => (typeof rowLabel === 'function' && rowLabel(m) === 'mute') || (m && m.codexVerdict === 'mute') || MOOD_NEG_REGEX.test(m.text || '')).length;
  const spike = recentSlice.length >= 5 && (recentNeg / recentSlice.length >= 0.25 || recentNeg >= 3);

  // Recommandation dynamique
  let recommendation = 'Le chat est serein et bienveillant. Aucune mesure de restriction nécessaire.';
  if (spike || score < 30) {
    recommendation = 'Tension élevée ou raid détecté. Recommandation : activer le Bouclier Anti-Raid 🛡️ ou la Pause d\'ambiance.';
  } else if (score < 55 || trend === '↘️ En baisse') {
    recommendation = 'Atmosphère agitée en hausse. Recommandation : basculer vers le profil Compétitif [O] pour filtrer le tilt.';
  } else if (posPct >= 35) {
    recommendation = 'Excellente énergie sur le chat ! Forte proportion d\'encouragements et de hype.';
  }

  return {
    total,
    posCount,
    negCount,
    neuCount,
    posPct,
    negPct,
    neuPct,
    score,
    state,
    icon,
    cls,
    trend,
    spike,
    recommendation
  };
}

function renderMoodPill() {
  const pill = $('moodPill');
  if (!pill) return;
  const atmos = computeChatAtmosphere();
  const span = pill.querySelector('span');
  if (span) {
    span.innerHTML = 'Ambiance <b>' + atmos.icon + ' ' + atmos.score + '%</b>';
  }
  pill.classList.remove('ok', 'warn', 'bad');
  if (atmos.cls) pill.classList.add(atmos.cls);
  pill.title = 'Baromètre d\'ambiance : ' + atmos.state + ' (' + atmos.score + '%) · ' + atmos.trend + ' [U]';
}

function renderMoodModal() {
  const atmos = computeChatAtmosphere();

  if ($('moodStateLabel')) $('moodStateLabel').textContent = atmos.icon + ' ' + atmos.state;
  if ($('moodScoreValue')) $('moodScoreValue').textContent = atmos.score + '%';

  const barPos = $('moodBarPositive');
  const barNeu = $('moodBarNeutral');
  const barNeg = $('moodBarNegative');

  if (barPos) barPos.style.width = atmos.posPct + '%';
  if (barNeu) barNeu.style.width = atmos.neuPct + '%';
  if (barNeg) barNeg.style.width = atmos.negPct + '%';

  if ($('moodLegendPos')) $('moodLegendPos').textContent = '🟢 ' + atmos.posPct + '% Positifs (' + atmos.posCount + ')';
  if ($('moodLegendNeu')) $('moodLegendNeu').textContent = '⚪ ' + atmos.neuPct + '% Neutres (' + atmos.neuCount + ')';
  if ($('moodLegendNeg')) $('moodLegendNeg').textContent = '🔴 ' + atmos.negPct + '% Négatifs (' + atmos.negCount + ')';

  if ($('moodTrend')) $('moodTrend').textContent = atmos.trend;
  if ($('moodSampleCount')) $('moodSampleCount').textContent = atmos.total + ' msgs';

  const spikeEl = $('moodSpikeStatus');
  if (spikeEl) {
    spikeEl.textContent = atmos.spike ? '⚡ Pic détecté' : 'Aucun';
    spikeEl.style.color = atmos.spike ? 'var(--bad, #f85149)' : 'var(--ok, #2ea043)';
  }

  if ($('moodRecommendation')) {
    $('moodRecommendation').textContent = atmos.recommendation;
  }
}

function openMoodModal() {
  const modal = $('moodModal');
  if (!modal) return;
  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.classList.remove('hidden');
  }
  modal.open = true;
  renderMoodModal();
}

function closeMoodModal() {
  const modal = $('moodModal');
  if (!modal) return;
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.classList.add('hidden');
  }
  modal.open = false;
}

function buildAtmosphereMarkdownReport(atmos) {
  const a = atmos || computeChatAtmosphere();
  const lines = [];
  lines.push('🌡️ **BAROMÈTRE D\'AMBIANCE REFCHAT**');
  lines.push('🎯 **État** : ' + a.icon + ' ' + a.state + ' (' + a.score + '%) · ' + a.trend);
  lines.push('────────────────────────────────────────');
  lines.push('🟢 **Bienveillance & Hype** : ' + a.posPct + '% (' + a.posCount + ' messages)');
  lines.push('⚪ **Neutre / Conversation** : ' + a.neuPct + '% (' + a.neuCount + ' messages)');
  lines.push('🔴 **Tension & Rejets** : ' + a.negPct + '% (' + a.negCount + ' infractions)');
  lines.push('📊 **Échantillon analysé** : ' + a.total + ' messages récents');
  if (a.spike) {
    lines.push('⚡ **Alerte** : Pic de tension activement détecté !');
  }
  lines.push('💡 **Conseil modération** : ' + a.recommendation);
  lines.push('────────────────────────────────────────');
  lines.push('*Rapport exporté depuis Refchat Extension.*');
  return lines.join('\n');
}

if ($('moodPill')) {
  $('moodPill').addEventListener('click', openMoodModal);
}
if ($('moodModalClose')) {
  $('moodModalClose').addEventListener('click', closeMoodModal);
}
if ($('moodModalOk')) {
  $('moodModalOk').addEventListener('click', closeMoodModal);
}
if ($('moodRefreshBtn')) {
  $('moodRefreshBtn').addEventListener('click', renderMoodModal);
}
if ($('moodCopyReportBtn')) {
  $('moodCopyReportBtn').addEventListener('click', async () => {
    const text = buildAtmosphereMarkdownReport();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      const btn = $('moodCopyReportBtn');
      const old = btn.textContent;
      btn.textContent = 'Diagnostic copié ✓';
      setTimeout(() => { btn.textContent = old; }, 1800);
    }
  });
}
if ($('moodApplyCompBtn')) {
  $('moodApplyCompBtn').addEventListener('click', () => {
    if (typeof applyPreset === 'function') {
      applyPreset('competitive');
      renderMoodModal();
    }
  });
}
if ($('moodApplyRaidBtn')) {
  $('moodApplyRaidBtn').addEventListener('click', () => {
    if (typeof applyPreset === 'function') {
      applyPreset('raid');
      renderMoodModal();
    }
  });
}

// --- fin baromètre d'ambiance et humeur ---

// ------------------------------------------------------------ modèles de sanctions & macros modérateur
const DEFAULT_MOD_MACROS = [
  {
    id: 'macro_respect',
    title: 'Toxicité & Respect',
    category: 'respect',
    categoryLabel: 'Toxicité',
    badgeClass: 'bad',
    reason: 'Insultes / Manque de respect',
    text: '{author} Merci de respecter les autres viewers et le streamer. Les insultes, attaques et propos dégradants sont strictement interdits.'
  },
  {
    id: 'macro_backseat',
    title: 'Backseat & Spoilers',
    category: 'backseat',
    categoryLabel: 'Jeu & Spoil',
    badgeClass: 'warn',
    reason: 'Backseat non sollicité / Spoil',
    text: '{author} Merci de ne pas donner d\'ordres, conseils non demandés ni spoilers sur le jeu. Laissez le streamer découvrir à son rythme !'
  },
  {
    id: 'macro_spam',
    title: 'Spam & Liens publicitaires',
    category: 'spam',
    categoryLabel: 'Spam & Liens',
    badgeClass: 'warn',
    reason: 'Spam / Liens non autorisés',
    text: '{author} Pas de répétitions excessives de messages, majuscules abusives ni liens externes dans le chat s\'il vous plaît.'
  },
  {
    id: 'macro_warning',
    title: 'Dernier avertissement',
    category: 'warning',
    categoryLabel: 'Avertissement',
    badgeClass: 'pending',
    reason: 'Dernier avertissement avant exclusion',
    text: '{author} ⚠️ Dernier avertissement avant exclusion temporaire du chat. Merci de calmer le jeu.'
  },
  {
    id: 'macro_timeout',
    title: 'Sanction Temporaire (Timeout)',
    category: 'warning',
    categoryLabel: 'Sanction',
    badgeClass: 'bad',
    reason: 'Timeout récidive',
    text: '{author} 🛑 Sanction temporaire appliquée suite à de multiples avertissements non respectés.'
  }
];

let customMacrosCache = [];

function loadModMacros() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get({ csg_mod_macros: [] }, (res) => {
        if (res && Array.isArray(res.csg_mod_macros)) {
          customMacrosCache = res.csg_mod_macros;
        }
      });
    }
  } catch (_) {}
}

function getAllModMacros() {
  return [...DEFAULT_MOD_MACROS, ...customMacrosCache];
}

function interpolateMacroText(tpl, authorName) {
  const auth = authorName ? (authorName.startsWith('@') ? authorName : '@' + authorName) : '@viewer';
  return String(tpl || '').replace(/\{author\}/gi, auth);
}

function renderMacrosModal() {
  const container = $('macrosList');
  if (!container) return;
  container.innerHTML = '';

  const q = ($('macrosSearch') ? $('macrosSearch').value.trim().toLowerCase() : '');
  const cat = ($('macrosCategoryFilter') && $('macrosCategoryFilter').value) ? $('macrosCategoryFilter').value : 'all';

  const inspectedAuthor = (typeof authorCurrentMsgs !== 'undefined' && $('authorQuery') && $('authorQuery').value) ? $('authorQuery').value.trim() : '';

  const allMacros = getAllModMacros();
  const filtered = allMacros.filter((m) => {
    if (cat === 'custom' && !m.isCustom) return false;
    if (cat && cat !== 'all' && cat !== 'custom' && m.category !== cat) return false;
    if (!q) return true;
    const hay = (m.title + ' ' + m.reason + ' ' + m.text + ' ' + m.categoryLabel).toLowerCase();
    return hay.includes(q);
  });

  if ($('macrosCount')) {
    $('macrosCount').textContent = filtered.length + ' ' + (filtered.length > 1 ? 'macros' : 'macro');
  }

  const emptyEl = $('macrosEmpty');
  if (emptyEl) emptyEl.classList.toggle('hidden', filtered.length > 0);

  for (const macro of filtered) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '6px';
    card.style.padding = '8px 10px';
    card.style.borderRadius = '6px';
    card.style.border = '1px solid var(--border)';
    card.style.background = 'var(--bg-card)';

    const head = document.createElement('div');
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.justifyContent = 'space-between';

    const titleWrap = document.createElement('div');
    titleWrap.style.display = 'flex';
    titleWrap.style.alignItems = 'center';
    titleWrap.style.gap = '6px';

    const titleSpan = document.createElement('strong');
    titleSpan.style.fontSize = '12px';
    titleSpan.textContent = macro.title;

    const badge = document.createElement('span');
    badge.className = 'chip ' + (macro.badgeClass || 'pending');
    badge.style.fontSize = '10px';
    badge.textContent = macro.categoryLabel || macro.category;

    titleWrap.appendChild(titleSpan);
    titleWrap.appendChild(badge);
    head.appendChild(titleWrap);

    if (macro.isCustom) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'ghost danger';
      delBtn.style.padding = '0 4px';
      delBtn.style.fontSize = '11px';
      delBtn.title = 'Supprimer cette macro personnalisée';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => deleteCustomModMacro(macro.id));
      head.appendChild(delBtn);
    }

    card.appendChild(head);

    const bodyText = document.createElement('p');
    bodyText.className = 'meta';
    bodyText.style.margin = '2px 0';
    bodyText.style.fontSize = '11.5px';
    bodyText.style.lineHeight = '1.35';
    bodyText.textContent = interpolateMacroText(macro.text, inspectedAuthor);
    card.appendChild(bodyText);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';
    actions.style.alignItems = 'center';
    actions.style.marginTop = '4px';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'primary small';
    copyBtn.style.height = '24px';
    copyBtn.style.fontSize = '11px';
    copyBtn.style.padding = '0 8px';
    copyBtn.textContent = '📋 Copier pour le chat';
    copyBtn.addEventListener('click', async () => {
      const msg = interpolateMacroText(macro.text, inspectedAuthor);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(msg);
        const old = copyBtn.textContent;
        copyBtn.textContent = 'Copié ✓';
        setTimeout(() => { copyBtn.textContent = old; }, 1500);
      }
      if (typeof recordAuditAction === 'function') {
        recordAuditAction({
          type: 'config',
          target: inspectedAuthor || 'chat',
          detail: 'macro copiée : ' + macro.title
        });
      }
    });
    actions.appendChild(copyBtn);

    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'btn small danger';
    muteBtn.style.height = '24px';
    muteBtn.style.fontSize = '11px';
    muteBtn.style.padding = '0 8px';
    muteBtn.textContent = '🔨 Muter avec ce motif';
    muteBtn.title = 'Ouvrir la boîte de mute avec ce motif prérempli (' + macro.reason + ')';
    muteBtn.addEventListener('click', () => {
      closeMacrosModal();
      openMuteModal(inspectedAuthor || '', '', macro.reason);
    });
    actions.appendChild(muteBtn);

    if (inspectedAuthor) {
      const noteBtn = document.createElement('button');
      noteBtn.type = 'button';
      noteBtn.className = 'btn small';
      noteBtn.style.height = '24px';
      noteBtn.style.fontSize = '11px';
      noteBtn.style.padding = '0 8px';
      noteBtn.textContent = '📝 Note dossier';
      noteBtn.title = 'Ajouter la raison dans la note du viewer @' + inspectedAuthor;
      noteBtn.addEventListener('click', () => {
        if ($('authorNoteInput')) {
          const cur = $('authorNoteInput').value.trim();
          $('authorNoteInput').value = cur ? (cur + ' · ' + macro.reason) : macro.reason;
          if ($('authorNoteSave')) $('authorNoteSave').click();
          closeMacrosModal();
        }
      });
      actions.appendChild(noteBtn);
    }

    card.appendChild(actions);
    container.appendChild(card);
  }
}

function openMacrosModal() {
  const modal = $('macrosModal');
  if (!modal) return;
  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.classList.remove('hidden');
  }
  modal.open = true;
  renderMacrosModal();
}

function closeMacrosModal() {
  const modal = $('macrosModal');
  if (!modal) return;
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.classList.add('hidden');
  }
  modal.open = false;
}

function addCustomModMacro(title, reason, text, category) {
  if (!title || !text) return false;
  const newMacro = {
    id: 'macro_cust_' + Date.now(),
    title: String(title).trim(),
    reason: String(reason || title).trim(),
    text: String(text).trim(),
    category: category || 'custom',
    categoryLabel: 'Perso',
    badgeClass: 'ok',
    isCustom: true
  };
  customMacrosCache.push(newMacro);
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ csg_mod_macros: customMacrosCache });
    }
  } catch (_) {}
  if (typeof recordAuditAction === 'function') {
    recordAuditAction({
      type: 'config',
      target: 'macro',
      detail: 'macro personnalisée ajoutée : ' + newMacro.title
    });
  }
  renderMacrosModal();
  return true;
}

function deleteCustomModMacro(id) {
  customMacrosCache = customMacrosCache.filter((m) => m.id !== id);
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ csg_mod_macros: customMacrosCache });
    }
  } catch (_) {}
  renderMacrosModal();
}

if ($('macrosPill')) {
  $('macrosPill').addEventListener('click', openMacrosModal);
}
if ($('macrosModalClose')) {
  $('macrosModalClose').addEventListener('click', closeMacrosModal);
}
if ($('macrosModalOk')) {
  $('macrosModalOk').addEventListener('click', closeMacrosModal);
}
if ($('macrosSearch')) {
  $('macrosSearch').addEventListener('input', renderMacrosModal);
}
if ($('macrosCategoryFilter')) {
  $('macrosCategoryFilter').addEventListener('change', renderMacrosModal);
}
if ($('macroAddBtn')) {
  $('macroAddBtn').addEventListener('click', () => {
    const title = $('macroNewTitle') ? $('macroNewTitle').value.trim() : '';
    const reason = $('macroNewReason') ? $('macroNewReason').value.trim() : '';
    const text = $('macroNewText') ? $('macroNewText').value.trim() : '';
    if (!title || !text) {
      alert('Veuillez renseigner au moins un titre et un texte pour la macro.');
      return;
    }
    addCustomModMacro(title, reason, text, 'custom');
    if ($('macroNewTitle')) $('macroNewTitle').value = '';
    if ($('macroNewReason')) $('macroNewReason').value = '';
    if ($('macroNewText')) $('macroNewText').value = '';
  });
}

// --- fin modèles de sanctions & macros modérateur ---

// ---------------------------------------------------------------- règles regex & filtres avancés
const DEFAULT_REGEX_RULES = [
  {
    id: 'reg_discord',
    name: 'Liens Discord',
    pattern: '(?:https?:\\/\\/)?(?:www\\.)?(?:discord\\.(?:gg|io|me|li)|discordapp\\.com\\/invite)\\/[a-z0-9_-]+',
    flags: 'i',
    action: 'mute',
    reason: 'Lien Discord non autorisé',
    enabled: true,
    isDefault: true
  },
  {
    id: 'reg_telegram',
    name: 'Liens Telegram / WhatsApp',
    pattern: '(?:https?:\\/\\/)?(?:t\\.me|telegram\\.me|chat\\.whatsapp\\.com)\\/[a-z0-9_-]+',
    flags: 'i',
    action: 'mute',
    reason: 'Lien Telegram/WhatsApp non autorisé',
    enabled: true,
    isDefault: true
  },
  {
    id: 'reg_bots',
    name: 'Promo Bots & Followers',
    pattern: '(?:buy|get|free|cheap)\\s*(?:followers|viewers|subs|views)\\b|(?:bigfollows|viewershub|dogfollowers)\\b',
    flags: 'i',
    action: 'mute',
    reason: 'Promo bot de followers',
    enabled: true,
    isDefault: true
  },
  {
    id: 'reg_caps',
    name: 'Majuscules abusives (All-caps)',
    pattern: '^(?=.{14,}$)(?=(?:[^A-Z]*[A-Z]){10})[^a-z]*$',
    flags: '',
    action: 'review',
    reason: 'Majuscules abusives',
    enabled: true,
    isDefault: true
  },
  {
    id: 'reg_crypto',
    name: 'Arnaques Crypto & Scams',
    pattern: '\\b(?:free\\s*airdrop|claim\\s*tokens?|connect\\s*wallet|crypto\\s*gift|claim\\s*nft)\\b',
    flags: 'i',
    action: 'mute',
    reason: 'Arnaque crypto / scam',
    enabled: true,
    isDefault: true
  }
];

let customRegexRulesCache = [];

function getAllRegexRules() {
  if (!customRegexRulesCache || !customRegexRulesCache.length) {
    return DEFAULT_REGEX_RULES;
  }
  return customRegexRulesCache;
}

function compileRegexPattern(patternStr, defaultFlags) {
  if (!patternStr || typeof patternStr !== 'string') return null;
  const str = patternStr.trim();
  if (!str) return null;
  try {
    if (str.startsWith('/') && str.lastIndexOf('/') > 0) {
      const lastSlash = str.lastIndexOf('/');
      let pattern = str.slice(1, lastSlash);
      if (pattern === '^(?=.{14,}$)(?:[^a-z]*[A-Z]){10,}[^a-z]*$') {
        pattern = '^(?=.{14,}$)(?=(?:[^A-Z]*[A-Z]){10})[^a-z]*$';
      }
      const flags = str.slice(lastSlash + 1).replace(/[gy]/g, '');
      return new RegExp(pattern, flags);
    }
    const flags = String(defaultFlags != null ? defaultFlags : 'i').replace(/[gy]/g, '');
    const pattern = str === '^(?=.{14,}$)(?:[^a-z]*[A-Z]){10,}[^a-z]*$'
      ? '^(?=.{14,}$)(?=(?:[^A-Z]*[A-Z]){10})[^a-z]*$' : str;
    return new RegExp(pattern, flags);
  } catch (_) {
    return null;
  }
}

function matchCustomRegex(text) {
  if (!text || typeof text !== 'string') {
    return { matched: false, rule: null, reason: null, action: null };
  }
  const rules = getAllRegexRules();
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    const reg = compileRegexPattern(rule.pattern, rule.flags !== undefined ? rule.flags : 'i');
    if (reg && reg.test(text)) {
      return {
        matched: true,
        rule,
        reason: rule.reason || rule.name,
        action: rule.action || 'mute'
      };
    }
  }
  return { matched: false, rule: null, reason: null, action: null };
}

function loadRegexRules(cb) {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get({ csg_regex_rules: [] }, (res) => {
        const stored = res && res.csg_regex_rules;
        if (Array.isArray(stored) && stored.length > 0) {
          customRegexRulesCache = stored;
        } else {
          customRegexRulesCache = JSON.parse(JSON.stringify(DEFAULT_REGEX_RULES));
        }
        renderRegexModal();
        if (typeof cb === 'function') cb(customRegexRulesCache);
      });
      return;
    }
  } catch (_) {}
  customRegexRulesCache = JSON.parse(JSON.stringify(DEFAULT_REGEX_RULES));
  renderRegexModal();
  if (typeof cb === 'function') cb(customRegexRulesCache);
}

function saveRegexRules() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ csg_regex_rules: customRegexRulesCache });
    }
  } catch (_) {}
}

function renderRegexModal() {
  const listEl = $('regexRulesList');
  const countEl = $('regexCount');
  if (!listEl) return;
  listEl.textContent = '';

  const rules = getAllRegexRules();
  const activeCount = rules.filter((r) => r.enabled !== false).length;
  if (countEl) {
    countEl.textContent = activeCount + ' ' + (activeCount === 1 ? 'règle active' : 'règles actives');
  }

  for (const rule of rules) {
    const card = document.createElement('div');
    card.className = 'regex-rule-card';
    card.style.cssText = 'background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px;';

    const header = document.createElement('div');
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';

    const titleWrap = document.createElement('div');
    titleWrap.style.cssText = 'display: flex; align-items: center; gap: 6px;';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = rule.enabled !== false;
    checkbox.title = 'Activer ou désactiver cette règle';
    checkbox.addEventListener('change', () => {
      rule.enabled = checkbox.checked;
      // Cache vide : la liste affichée est le tableau des défauts. Sans copie,
      // la case modifie l'original et l'enregistrement écrit encore [].
      if (!customRegexRulesCache.length || !customRegexRulesCache.some((r) => r.id === rule.id)) {
        customRegexRulesCache = JSON.parse(JSON.stringify(getAllRegexRules()));
        const hit = customRegexRulesCache.find((r) => r.id === rule.id);
        if (hit) hit.enabled = checkbox.checked;
      }
      saveRegexRules();
      renderRegexModal();
      runRegexTester();
    });
    titleWrap.appendChild(checkbox);

    const nameEl = document.createElement('span');
    nameEl.style.cssText = 'font-weight: 600; font-size: 12px; color: var(--fg);';
    nameEl.textContent = rule.name;
    titleWrap.appendChild(nameEl);

    const badge = document.createElement('span');
    const isMute = rule.action === 'mute';
    badge.className = isMute ? 'badge bad' : 'badge warn';
    badge.style.cssText = 'font-size: 10px; padding: 1px 5px; border-radius: 3px; font-weight: 600; text-transform: uppercase;';
    badge.textContent = isMute ? 'Mute' : 'Signaler';
    titleWrap.appendChild(badge);

    header.appendChild(titleWrap);

    const rightWrap = document.createElement('div');
    rightWrap.style.cssText = 'display: flex; gap: 4px; align-items: center;';

    if (rule.isCustom) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'ghost small';
      delBtn.style.cssText = 'padding: 1px 5px; font-size: 11px; height: 20px;';
      delBtn.textContent = '✕';
      delBtn.title = 'Supprimer cette règle';
      delBtn.addEventListener('click', () => {
        deleteCustomRegexRule(rule.id);
      });
      rightWrap.appendChild(delBtn);
    }

    header.appendChild(rightWrap);
    card.appendChild(header);

    const patternEl = document.createElement('code');
    patternEl.style.cssText = 'font-family: monospace; font-size: 11px; color: var(--accent); background: rgba(0,0,0,0.2); padding: 2px 4px; border-radius: 3px; word-break: break-all;';
    patternEl.textContent = '/' + rule.pattern + '/' + (rule.flags || '');
    card.appendChild(patternEl);

    if (rule.reason) {
      const reasonEl = document.createElement('span');
      reasonEl.className = 'meta';
      reasonEl.style.cssText = 'font-size: 10.5px;';
      reasonEl.textContent = 'Motif : ' + rule.reason;
      card.appendChild(reasonEl);
    }

    listEl.appendChild(card);
  }
}

function runRegexTester() {
  const inputEl = $('regexTestInput');
  const resultEl = $('regexTestResult');
  if (!inputEl || !resultEl) return;
  const val = inputEl.value.trim();
  if (!val) {
    resultEl.textContent = 'Saisissez un message pour tester vos règles.';
    resultEl.style.color = '';
    return;
  }
  const res = matchCustomRegex(val);
  if (res.matched) {
    resultEl.textContent = '🚫 Bloqué par : ' + (res.rule.name || 'Règle') + ' (Action : ' + String(res.action).toUpperCase() + ' — ' + (res.reason || '') + ')';
    resultEl.style.color = 'var(--bad, #ff4d67)';
  } else {
    resultEl.textContent = '✅ Message propre : aucun filtre regex actif ne correspond.';
    resultEl.style.color = 'var(--good, #4ec9b0)';
  }
}

function openRegexModal() {
  const modal = $('regexModal');
  if (!modal) return;
  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.classList.remove('hidden');
  }
  modal.open = true;
  renderRegexModal();
  runRegexTester();
  if ($('regexTestInput')) {
    setTimeout(() => {
      try { $('regexTestInput').focus(); } catch (_) {}
    }, 50);
  }
}

function closeRegexModal() {
  const modal = $('regexModal');
  if (!modal) return;
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.classList.add('hidden');
  }
  modal.open = false;
}

function addCustomRegexRule(name, pattern, action, reason) {
  const trimmedName = String(name || '').trim();
  const trimmedPattern = String(pattern || '').trim();
  if (!trimmedName || !trimmedPattern) return false;

  const testCompiled = compileRegexPattern(trimmedPattern);
  if (!testCompiled) {
    alert('Expression régulière invalide. Vérifiez la syntaxe.');
    return false;
  }

  let finalPattern = trimmedPattern;
  let finalFlags = 'i';
  if (trimmedPattern.startsWith('/') && trimmedPattern.lastIndexOf('/') > 0) {
    const lastSlash = trimmedPattern.lastIndexOf('/');
    finalPattern = trimmedPattern.slice(1, lastSlash);
    finalFlags = trimmedPattern.slice(lastSlash + 1);
  }

  const newRule = {
    id: 'reg_cust_' + Date.now(),
    name: trimmedName,
    pattern: finalPattern,
    flags: finalFlags,
    action: action || 'mute',
    reason: reason ? String(reason).trim() : trimmedName,
    enabled: true,
    isCustom: true
  };

  if (!customRegexRulesCache || !customRegexRulesCache.length) {
    customRegexRulesCache = JSON.parse(JSON.stringify(DEFAULT_REGEX_RULES));
  }
  customRegexRulesCache.push(newRule);
  saveRegexRules();
  if (typeof recordAuditAction === 'function') {
    recordAuditAction({
      type: 'config',
      target: 'regex_rule',
      detail: 'règle regex personnalisée ajoutée : ' + newRule.name
    });
  }
  renderRegexModal();
  runRegexTester();
  return true;
}

function deleteCustomRegexRule(id) {
  if (!customRegexRulesCache || !customRegexRulesCache.length) {
    customRegexRulesCache = JSON.parse(JSON.stringify(DEFAULT_REGEX_RULES));
  }
  customRegexRulesCache = customRegexRulesCache.filter((r) => r.id !== id);
  saveRegexRules();
  renderRegexModal();
  runRegexTester();
}

function resetDefaultRegexRules() {
  customRegexRulesCache = JSON.parse(JSON.stringify(DEFAULT_REGEX_RULES));
  saveRegexRules();
  renderRegexModal();
  runRegexTester();
}

if ($('regexPill')) {
  $('regexPill').addEventListener('click', openRegexModal);
}
if ($('regexModalClose')) {
  $('regexModalClose').addEventListener('click', closeRegexModal);
}
if ($('regexModalOk')) {
  $('regexModalOk').addEventListener('click', closeRegexModal);
}
if ($('regexTestInput')) {
  $('regexTestInput').addEventListener('input', runRegexTester);
}
if ($('regexResetDefaultsBtn')) {
  $('regexResetDefaultsBtn').addEventListener('click', resetDefaultRegexRules);
}
if ($('regexAddBtn')) {
  $('regexAddBtn').addEventListener('click', () => {
    const name = $('regexNewName') ? $('regexNewName').value.trim() : '';
    const pattern = $('regexNewPattern') ? $('regexNewPattern').value.trim() : '';
    const action = $('regexNewAction') ? $('regexNewAction').value : 'mute';
    if (!name || !pattern) {
      alert('Veuillez renseigner un nom et un pattern RegExp.');
      return;
    }
    const ok = addCustomRegexRule(name, pattern, action, name);
    if (ok) {
      if ($('regexNewName')) $('regexNewName').value = '';
      if ($('regexNewPattern')) $('regexNewPattern').value = '';
    }
  });
}

// --- fin règles regex & filtres avancés ---



