'use strict';

// Menus <details class="menu"> du tableau : un seul ouvert à la fois, fermé au
// clic sur une action, au clic ailleurs et à Échap. Les boutons gardent leurs
// ids : board.js ne sait pas qu'ils vivent dans un menu.
(() => {
  const menus = Array.from(document.querySelectorAll('details.menu'));
  if (!menus.length) return;
  const closeAll = (except) => {
    for (const m of menus) if (m !== except) m.open = false;
  };

  for (const menu of menus) {
    menu.addEventListener('toggle', () => {
      if (menu.open) closeAll(menu);
    });
    menu.addEventListener('click', (e) => {
      if (e.target.closest('.menu-pop button, .menu-pop a')) menu.open = false;
    });
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('details.menu')) closeAll(null);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = menus.find((m) => m.open);
    if (!open) return;
    open.open = false;
    const btn = open.querySelector('summary');
    if (btn) btn.focus();
  });
})();
