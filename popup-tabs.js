'use strict';

// Onglets du popup. Fichier à part : popup.js ne connaît que des ids, il n'a pas
// à savoir dans quel onglet ils vivent.
(() => {
  const KEY = 'csg_popup_tab';
  // Le popup se ferme dès qu'on clique ailleurs (copier une clé API, par
  // exemple). Rouvert dans les 3 minutes, il revient sur le même onglet ;
  // au-delà il s'ouvre sur l'accueil, là où se lit l'état.
  const KEEP_MS = 180000;
  const tabs = Array.from(document.querySelectorAll('.tabs .tab'));
  if (!tabs.length) return;

  function remember(name) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ name, at: Date.now() }));
    } catch (_) {}
  }

  function recall() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || 'null');
      return v && Date.now() - (Number(v.at) || 0) < KEEP_MS ? String(v.name || '') : '';
    } catch (_) {
      return '';
    }
  }

  function show(name, focus) {
    const tab = tabs.find((t) => t.dataset.tab === name) || tabs[0];
    for (const t of tabs) {
      const on = t === tab;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      const pane = document.getElementById(t.getAttribute('aria-controls'));
      if (pane) {
        pane.hidden = !on;
        pane.classList.toggle('on', on);
      }
    }
    if (focus) tab.focus();
    window.scrollTo(0, 0);
    remember(tab.dataset.tab);
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => show(tab.dataset.tab));
    tab.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      show(tabs[(i + step + tabs.length) % tabs.length].dataset.tab, true);
    });
  });

  // Raccourci depuis un autre onglet : <… data-goto="models">.
  document.querySelectorAll('[data-goto]').forEach((el) => {
    el.addEventListener('click', () => show(el.dataset.goto));
  });

  const start = recall();
  if (start && start !== tabs[0].dataset.tab) show(start);
})();
