'use strict';

// Vue en direct de la file d'attente : les messages capturés pas encore jugés,
// le prochain à juger en haut. Lecture seule, rafraîchie toutes les 1,5 s.

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 1500;
let rows = [];
let lastErr = '';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function age(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0');
}

function render() {
  const q = $('find').value.trim().toLowerCase();
  const shown = q ? rows.filter((r) => (r.a + ' ' + r.t + ' ' + r.channel).toLowerCase().includes(q)) : rows;
  const judging = rows.filter((r) => r.state === 'judging').length;
  const live = rows.filter((r) => r.state === 'waiting').length;
  $('count').textContent = String(rows.length);
  $('meta').innerHTML = lastErr
    ? '<span class="err">' + esc(lastErr) + '</span>'
    : (judging ? judging + ' en cours de jugement · ' : '') +
      (live ? live + ' dans la file live · ' : '') +
      (q ? shown.length + ' affichés · ' : '') +
      'mis à jour ' + new Date().toLocaleTimeString('fr-FR');
  if (!rows.length) {
    $('out').innerHTML = '<p class="empty">Aucun message en attente.</p>';
    return;
  }
  if (!shown.length) {
    $('out').innerHTML = '<p class="empty">Aucun message ne correspond au filtre.</p>';
    return;
  }
  const body = shown
    .map(
      (r, i) =>
        '<tr class="' + (r.state === 'judging' ? 'judging' : '') + '">' +
        '<td class="n">' + (i + 1) + '</td>' +
        '<td class="age">' + esc(age(r.ts)) + '</td>' +
        '<td class="chan">' + esc(r.channel) + '</td>' +
        '<td class="who">' + esc(r.a) + '</td>' +
        '<td class="msg">' + esc(r.t) +
        (r.state === 'judging' ? '<span class="tag">en cours</span>' : '') +
        (r.state === 'waiting' ? '<span class="tag">file live</span>' : '') +
        (r.esc ? '<span class="tag">relu</span>' : '') +
        '</td></tr>'
    )
    .join('');
  $('out').innerHTML =
    '<table><thead><tr><th class="n">#</th><th>Âge</th><th class="chan">Chaîne</th><th>Auteur</th><th>Message</th></tr></thead>' +
    '<tbody>' + body + '</tbody></table>';
}

function refresh() {
  if (document.hidden) return;
  try {
    chrome.runtime.sendMessage({ type: 'CSG_QUEUE_LIST' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        lastErr = 'Extension injoignable : ' + ((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'pas de réponse');
      } else {
        lastErr = '';
        rows = Array.isArray(res.rows) ? res.rows : [];
      }
      render();
    });
  } catch (e) {
    lastErr = String((e && e.message) || e);
    render();
  }
}

$('find').addEventListener('input', render);
document.addEventListener('visibilitychange', refresh);
setInterval(refresh, REFRESH_MS);
refresh();
