'use strict';
const $ = (sel) => document.querySelector(sel);

/* ------- theme ------- */
(() => {
  const order = ['auto', 'dark', 'light'];
  let current = 'auto';
  try { current = localStorage.getItem('sovereign-theme') || 'auto'; } catch { /* fine */ }
  const apply = () => {
    if (current === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = current;
    $('#theme-btn').textContent = `theme: ${current}`;
    if (window.__grid) window.__grid.recolor();
  };
  $('#theme-btn').addEventListener('click', () => {
    current = order[(order.indexOf(current) + 1) % order.length];
    try { localStorage.setItem('sovereign-theme', current); } catch { /* fine */ }
    apply();
  });
  apply();
})();

/* ------- value-prop ledger ------- */
const PROPS = [
  ['The machine', 'Runs as one file on your laptop, homelab, or any box you own. Zero runtime dependencies — the code you audit is the code that runs. Works offline.', 'layer 1 · single binary, open source'],
  ['The models', 'Local open weights by default — Ollama, llama.cpp, any compatible server. Rent a frontier model only when you choose, with the disclosure on screen when you do.', 'layer 2 · your dial, per persona'],
  ['The memory', 'Every fact it remembers shows how it entered, which conversation it came from, and which model wrote it. Deleting really deletes — down to the bytes.', 'layer 3 · receipts on every memory'],
  ['The knowledge', 'Your documents, your chat history from other AIs, even the receipts and renewals hiding in your inbox — parsed on your machine, never uploaded anywhere.', 'layer 4 · imports without uploads'],
  ['The exit', 'One checksummed file holds everything, in a format documented well enough to outlive us. Encrypt it with a passphrase only you hold. Verify it without importing.', 'layer 5 · export, verify, leave'],
];
(() => {
  const holder = $('#ledger');
  const hex = "<svg class='glyph' viewBox='0 0 100 100' aria-hidden='true'><path fill='var(--terra)' d='M50 4 90 27v46L50 96 10 73V27z'/><path fill='var(--on-terra)' d='M34 29h34v10H45v7h18v10H45v7h23v10H34z'/></svg>";
  holder.innerHTML = PROPS.map(([title, body, proof]) => `
    <article class="prop">
      ${hex}
      <h3>${title}</h3>
      <p>${body}</p>
      <span class="proof">⬡ ${proof}</span>
    </article>`).join('');
})();

/* ------- hero lattice (ambient, honest: it's decorative and says nothing false) ------- */
(() => {
  const canvas = $('#hero-grid');
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let cells = [];
  let colors = {};
  let raf = null;
  let last = 0;

  function recolor() {
    const s = getComputedStyle(document.documentElement);
    colors = { line: s.getPropertyValue('--line').trim(), lit: s.getPropertyValue('--terra').trim() };
  }
  function layout() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const R = 16, dx = Math.sqrt(3) * R, dy = 1.5 * R;
    cells = [];
    for (let row = 0; row * dy < rect.height + dy; row++) {
      for (let col = 0; col * dx < rect.width + dx; col++) {
        cells.push({ x: col * dx + (row % 2 ? dx / 2 : 0), y: row * dy, phase: Math.random() * Math.PI * 2 });
      }
    }
    recolor();
    draw(performance.now());
  }
  function hexPath(x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + i * Math.PI / 3;
      const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
  }
  function draw(now) {
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const still = reduce.matches;
    for (const c of cells) {
      const pulse = still ? 0.5 : 0.5 + 0.5 * Math.sin(now / 2400 + c.phase);
      ctx.globalAlpha = 0.08 + pulse * 0.10;
      ctx.strokeStyle = colors.line;
      ctx.lineWidth = 1;
      hexPath(c.x, c.y, 9);
      ctx.stroke();
      if (!still && pulse > 0.93) {
        ctx.globalAlpha = (pulse - 0.93) * 4;
        ctx.fillStyle = colors.lit;
        hexPath(c.x, c.y, 4);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
  function loop() {
    const step = (now) => {
      if (!document.hidden && now - last > 40) { last = now; draw(now); }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  window.__grid = { recolor };
  addEventListener('resize', layout);
  layout();
  loop();
})();

/* ------- waitlist submission -------
   Wired to be real the instant you deploy. Set window.WAITLIST_ENDPOINT (a URL
   that accepts a POST JSON body) — e.g. a Formspree/Basin/Cloudflare Worker —
   and submissions post there. With no endpoint set, it falls back to opening a
   pre-filled email so no interest is ever silently dropped. */
window.WAITLIST_ENDPOINT = window.WAITLIST_ENDPOINT || '';
window.WAITLIST_EMAIL = window.WAITLIST_EMAIL || 'hello@sovereignai.app';
(() => {
  const form = $('#wl-form');
  const errorEl = $('#wl-error');
  const submitBtn = $('#wl-submit');

  function showDone(via) {
    form.innerHTML = `
      <div class="wl-done">
        <div class="big" aria-hidden="true">⬡</div>
        <h3>You're on the path.</h3>
        <p>${via === 'mail'
          ? 'Your email app opened with a pre-filled note — send it and you’re in the queue.'
          : 'We’ve got your request. Watch your inbox as instances open up.'}</p>
      </div>`;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    const email = $('#wl-email').value.trim();
    const name = $('#wl-name').value.trim();
    const use = $('#wl-use').value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errorEl.textContent = 'Please enter a valid email address.';
      $('#wl-email').focus();
      return;
    }
    const payload = { email, name, use, source: 'landing', at: new Date().toISOString() };

    if (window.WAITLIST_ENDPOINT) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
      try {
        const res = await fetch(window.WAITLIST_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showDone('endpoint');
        return;
      } catch {
        // fall through to the mail fallback rather than lose the lead
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Request early access ⬡';
      }
    }

    // Fallback: never drop interest — open a pre-filled email.
    const subject = encodeURIComponent('SovereignAI early access');
    const body = encodeURIComponent(
      `I'd like early access to SovereignAI.\n\nEmail: ${email}\nName: ${name || '—'}\nUse: ${use || '—'}\n`
    );
    window.location.href = `mailto:${window.WAITLIST_EMAIL}?subject=${subject}&body=${body}`;
    showDone('mail');
  });
})();
