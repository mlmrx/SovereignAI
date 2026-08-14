'use strict';
/* The shell's behaviour: one theme choice, honoured on every page.
   Loaded from <head> without defer so the stored theme is applied before the
   first paint — an external file rather than an inline script, because the
   product's own server serves these same files under a strict CSP that
   forbids inline scripts. The nav and footer themselves are static markup on
   every page, so they exist for crawlers and for readers with no JavaScript;
   this file only adds the parts that need behaviour. */

(() => {
  const THEMES = ['auto', 'cielo', 'bottega', 'notte'];
  const LEGACY = { dark: 'notte', light: 'bottega' };
  const LABELS = {
    auto: ['Auto', 'follow this device'],
    cielo: ['Cielo', 'the open sky · openness'],
    bottega: ['Bottega', 'the workshop · ownership'],
    notte: ['Notte', 'lights out · sovereignty'],
  };
  const SWATCH = { cielo: '#2f9be0', bottega: '#a6522a', notte: '#26211f' };

  let current = 'auto';
  try {
    const stored = localStorage.getItem('sovereign-theme') || 'auto';
    current = THEMES.includes(stored) ? stored : LEGACY[stored] ?? 'auto';
  } catch { /* private session: the default is fine */ }

  // A shareable link can carry a look without changing what the reader keeps.
  let previewing = false;
  try {
    const preview = new URLSearchParams(location.search).get('theme');
    if (preview && THEMES.includes(preview)) { current = preview; previewing = true; }
  } catch { /* fine */ }

  function apply() {
    const root = document.documentElement;
    if (current === 'auto') delete root.dataset.theme;
    else root.dataset.theme = current;
    // The landing paints its hero on a canvas and has to repaint on a change.
    if (window.__grid && typeof window.__grid.recolor === 'function') window.__grid.recolor();
    document.querySelectorAll('[data-theme-pick]').forEach((item) => {
      item.classList.toggle('on', item.dataset.themePick === current);
    });
    // A swatch, not a sentence: the control keeps its width out of the nav.
    document.querySelectorAll('[data-theme-label]').forEach((el) => {
      el.style.background = current === 'auto'
        ? 'linear-gradient(135deg, #2f9be0 50%, #26211f 50%)'
        : SWATCH[current];
      el.setAttribute('title', `Theme: ${current}`);
      el.setAttribute('aria-label', `Theme: ${current}. Choose another.`);
    });
  }

  apply(); // before first paint — no flash of the wrong look

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  ready(() => {
    // Mark where we are, so the nav always answers "which page is this?"
    const here = location.pathname.replace(/\/$/, '') || '/';
    document.querySelectorAll('.shell-links a[href^="/"]').forEach((a) => {
      const href = a.getAttribute('href').replace(/\/$/, '') || '/';
      if (href === here) a.setAttribute('aria-current', 'page');
    });

    document.querySelectorAll('[data-theme-mount]').forEach((mount) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shell-swatch';
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('data-theme-label', '');

      const menu = document.createElement('div');
      menu.className = 'shell-menu';
      menu.hidden = true;
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Colour themes — yours to choose, remembered only on this device');

      for (const name of THEMES) {
        const item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        item.dataset.themePick = name;
        const sw = document.createElement('span');
        sw.className = name === 'auto' ? 'shell-sw auto' : 'shell-sw';
        if (SWATCH[name]) sw.style.background = SWATCH[name];
        const [label, hint] = LABELS[name];
        const small = document.createElement('small');
        small.textContent = hint;
        item.append(sw, document.createTextNode(label), small);
        item.addEventListener('click', () => {
          current = name;
          previewing = false;
          try { localStorage.setItem('sovereign-theme', name); } catch { /* fine */ }
          apply();
          menu.hidden = true;
          btn.setAttribute('aria-expanded', 'false');
        });
        menu.appendChild(item);
      }

      btn.addEventListener('click', () => {
        const open = menu.hidden;
        menu.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
      });
      document.addEventListener('click', (e) => {
        if (!menu.hidden && !e.target.closest('[data-theme-mount]')) {
          menu.hidden = true;
          btn.setAttribute('aria-expanded', 'false');
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !menu.hidden) { menu.hidden = true; btn.focus(); }
      });

      mount.append(btn, menu);
    });

    apply();
    if (previewing) { /* a previewed look is shown but never stored */ }
  });
})();
