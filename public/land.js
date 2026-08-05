'use strict';
const $ = (sel) => document.querySelector(sel);
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, REDUCE.matches ? 0 : ms));
async function typeInto(el, text, speed = 13) {
  if (REDUCE.matches) { el.textContent = text; return; }
  el.textContent = '';
  for (const ch of text) { el.textContent += ch; await sleep(speed); }
}

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

/* ------- hero: the thesis, played not told -------
   Act 1 (~2.6s): the fragmented you — labeled shards scattered and adrift.
   Act 2: they converge into one hexagon and ignite terracotta.
   Act 3: the ambient lattice (the settled mind). Skippable by scroll/click/key;
   under prefers-reduced-motion the intro is skipped entirely. The headline is
   plain HTML — with no JavaScript at all, the page is simply readable. */
(() => {
  const canvas = $('#hero-grid');
  const ctx = canvas.getContext('2d');
  const SHARDS = ['email', 'search', 'banks', 'broker', 'crypto', 'mortgage', 'insurance', 'health records', 'pharmacy', 'wearable', 'gym', 'shopping', 'groceries', 'airlines', 'hotels', 'messaging', 'social', 'gaming', 'school', 'car', 'utilities', 'streaming', 'LLM providers', 'postal', 'cloud drive', 'calendar', 'maps', 'food delivery', 'taxes', 'phone carrier'];
  let cells = [];
  let shards = [];
  let colors = {};
  let raf = null;
  let last = 0;
  let phase = REDUCE.matches ? 'ambient' : 'intro';
  let t0 = performance.now();
  const INTRO_MS = 2100;
  const IGNITE_MS = 700;

  document.body.classList.add(phase === 'intro' ? 'intro-live' : 'intro-done');

  function recolor() {
    const s = getComputedStyle(document.documentElement);
    colors = {
      line: s.getPropertyValue('--line').trim(),
      lit: s.getPropertyValue('--terra').trim(),
      dim: s.getPropertyValue('--dim').trim(),
    };
  }
  function rectOf() { return canvas.parentElement.getBoundingClientRect(); }
  function layout() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const rect = rectOf();
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
    shards = SHARDS.map((label, index) => {
      const angle = (index / SHARDS.length) * Math.PI * 2 + (index % 3) * 0.35;
      const radius = 0.36 + ((index * 37) % 100) / 210;
      return {
        label,
        x0: rect.width * (0.5 + Math.cos(angle) * radius),
        y0: rect.height * (0.5 + Math.sin(angle) * radius * 0.85),
        jitter: ((index * 71) % 17) / 17,
      };
    });
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
  const easeIn = (t) => t * t * t;

  function finishIntro() {
    if (phase === 'ambient') return;
    phase = 'ambient';
    document.body.classList.remove('intro-live');
    document.body.classList.add('intro-done');
  }
  for (const evt of ['wheel', 'keydown', 'pointerdown', 'touchstart']) {
    addEventListener(evt, finishIntro, { passive: true, once: false });
  }

  function draw(now) {
    const rect = rectOf();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cx = rect.width / 2, cy = rect.height * 0.46;

    if (phase === 'intro') {
      const t = Math.min(1, (now - t0) / INTRO_MS);
      ctx.font = '11px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      for (const s of shards) {
        const pull = easeIn(Math.max(0, t - s.jitter * 0.25) / (1 - s.jitter * 0.25 || 1));
        const x = s.x0 + (cx - s.x0) * pull;
        const y = s.y0 + (cy - s.y0) * pull;
        ctx.globalAlpha = 0.55 * (1 - pull * 0.9) + 0.05;
        ctx.fillStyle = colors.dim;
        ctx.fillText(s.label, x, y);
      }
      ctx.globalAlpha = 1;
      if (t >= 1) { phase = 'ignite'; t0 = now; }
      return;
    }

    if (phase === 'ignite') {
      const t = Math.min(1, (now - t0) / IGNITE_MS);
      const r = 14 + 26 * t;
      ctx.globalAlpha = 1 - t * 0.55;
      ctx.strokeStyle = colors.lit;
      ctx.lineWidth = 2.5;
      hexPath(cx, cy, r);
      ctx.stroke();
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.fillStyle = colors.lit;
      hexPath(cx, cy, 14 * (1 - t * 0.4));
      ctx.fill();
      ctx.globalAlpha = 1;
      if (t >= 1) finishIntro();
      return;
    }

    // ambient: the settled mind
    const still = REDUCE.matches;
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
      const interval = phase === 'ambient' ? 40 : 16;
      if (!document.hidden && now - last > interval) { last = now; draw(now); }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  window.__grid = { recolor };
  addEventListener('resize', layout);
  layout();
  loop();
})();

/* ------- the three proofs: operate the product on the landing page ------- */
(() => {
  /* Strike a memory — deletion you can feel */
  const ledger = $('#proof-ledger');
  if (ledger) {
    ledger.addEventListener('click', async (event) => {
      const btn = event.target.closest('.strike');
      if (!btn) return;
      const row = btn.closest('.prow');
      btn.disabled = true;
      const textEl = row.querySelector('.ptext');
      const original = textEl.textContent;
      if (!REDUCE.matches) {
        for (let pass = 0; pass < 6; pass++) {
          textEl.textContent = original.split('').map((ch, i) => (ch === ' ' ? ' ' : (i + pass) % 3 ? '0' : '·')).join('');
          await sleep(70);
        }
      }
      textEl.textContent = '0x00'.padEnd(original.length, ' 00');
      row.classList.add('gone');
      await sleep(450);
      row.remove();
      if (!ledger.querySelector('.prow')) {
        ledger.innerHTML = '<p class="pledger-empty">Ledger empty. Nothing retained, nothing recoverable — that’s the point.</p>';
      }
    });
  }

  /* The first five minutes — import → distill → greeting */
  const arrivalPlay = $('#proof-arrival-play');
  if (arrivalPlay) {
    let running = false;
    arrivalPlay.addEventListener('click', async () => {
      if (running) return;
      running = true;
      arrivalPlay.disabled = true;
      const status = $('#proof-arrival-status');
      const cellsEl = $('#proof-arrival-cells');
      const greet = $('#proof-arrival-greet');
      cellsEl.replaceChildren();
      greet.textContent = '';
      status.textContent = 'Importing 212 conversations — parsed on this machine, nothing leaves it…';
      await sleep(650);
      for (let i = 1; i <= 12; i++) {
        status.textContent = `Distilling — swept ${Math.min(i * 18, 212)} of 212 conversations…`;
        const cell = document.createElement('span');
        cell.className = 'pcell';
        cellsEl.appendChild(cell);
        await sleep(150);
      }
      status.textContent = 'Done: 12 durable memories — each names the conversation it came from.';
      await typeInto(greet, '“Good morning. I know you now — your projects, your preferences, and the receipts for both.”');
      arrivalPlay.disabled = false;
      running = false;
    });
  }

  /* The exit ritual — export, verify, leave */
  const exitPlay = $('#proof-exit-play');
  if (exitPlay) {
    let running = false;
    exitPlay.addEventListener('click', async () => {
      if (running) return;
      running = true;
      exitPlay.disabled = true;
      const term = $('#proof-exit-term');
      term.innerHTML = '';
      const lines = [
        ['pcmd', '$ sovereign export --encrypt backup.json'],
        ['', 'Exported 4,318 rows (encrypted: aes-256-gcm, scrypt-derived key)'],
        ['pdim', 'Archive digest sha256:9f41c2ab7e02…'],
        ['pcmd', '$ sovereign verify backup.json'],
        ['pok', '  ✓ memories · conversations · documents · life_records — all verified'],
        ['pok', 'Result: verified. Your exit works. It always has to.'],
      ];
      for (const [cls, text] of lines) {
        const div = document.createElement('div');
        if (cls) div.className = cls;
        term.appendChild(div);
        await typeInto(div, text, 6);
      }
      exitPlay.disabled = false;
      running = false;
    });
  }
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
        submitBtn.textContent = 'Keep me posted ⬡';
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
