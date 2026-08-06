'use strict';
const $ = (sel) => document.querySelector(sel);
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, REDUCE.matches ? 0 : ms));
async function typeInto(el, text, speed = 13) {
  if (REDUCE.matches) { el.textContent = text; return; }
  el.textContent = '';
  for (const ch of text) { el.textContent += ch; await sleep(speed); }
}

/* ------- themes: yours to choose, remembered only on this device -------
   Cielo (openness) / Bottega (ownership) / Notte (sovereignty) / Auto.
   Legacy stored "dark"/"light" values migrate to Notte/Bottega. */
(() => {
  const THEMES = ['auto', 'cielo', 'bottega', 'notte'];
  const LEGACY = { dark: 'notte', light: 'bottega' };
  const btn = $('#theme-btn');
  const menu = $('#theme-menu');
  let current = 'auto';
  try {
    const stored = localStorage.getItem('sovereign-theme') || 'auto';
    current = THEMES.includes(stored) ? stored : LEGACY[stored] ?? 'auto';
  } catch { /* fine */ }
  // Shareable preview: ?theme=cielo|bottega|notte shows a theme without
  // persisting it — links can carry a look, the visitor keeps their choice.
  const preview = new URLSearchParams(location.search).get('theme');
  if (preview && THEMES.includes(preview)) current = preview;

  const apply = () => {
    if (current === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = current;
    btn.textContent = `theme: ${current}`;
    menu.querySelectorAll('[data-theme-pick]').forEach((item) => {
      item.classList.toggle('on', item.dataset.themePick === current);
    });
    if (window.__grid) window.__grid.recolor();
  };

  const close = () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', () => {
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  menu.querySelectorAll('[data-theme-pick]').forEach((item) => {
    item.addEventListener('click', () => {
      current = item.dataset.themePick;
      try { localStorage.setItem('sovereign-theme', current); } catch { /* fine */ }
      apply();
      close();
    });
  });
  document.addEventListener('click', (event) => {
    if (!menu.hidden && !event.target.closest('.theme-pick')) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) { close(); btn.focus(); }
  });
  apply();
})();

/* ------- value-prop ledger ------- */
const PROPS = [
  ['The machine', 'Runs as one file on your laptop, homelab, or any box you own. Zero runtime dependencies — the code you audit is the code that runs. Works offline.', 'layer 1 · single binary, readable source'],
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
  // Phase clocks come from rAF timestamps only — never performance.now() at
  // script start, which can disagree wildly (virtual time, bfcache restores,
  // background tabs) and would freeze or skip the intro.
  let t0 = null;
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
    // Skipping the arrival also hushes the om — the sound belongs to the act.
    addEventListener(evt, () => { finishIntro(); omDuck(); }, { passive: true, once: false });
  }
  // Failsafe on the wall clock: whatever happens to animation frames, the
  // headline is never held hostage by the intro for more than a few seconds.
  // The token keeps a stale failsafe (load, or an earlier replay) from
  // cutting a newer act short.
  let introRun = 0;
  function armFailsafe() {
    const run = ++introRun;
    setTimeout(() => { if (run === introRun) finishIntro(); }, 4000);
  }
  armFailsafe();

  function draw(now) {
    const rect = rectOf();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cx = rect.width / 2, cy = rect.height * 0.46;

    if (phase === 'intro') {
      if (t0 === null || now < t0) t0 = now; // lazy start; re-anchor on any clock discontinuity
      const t = Math.min(1, Math.max(0, (now - t0) / INTRO_MS));
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
      if (t0 === null || now < t0) t0 = now;
      const t = Math.min(1, Math.max(0, (now - t0) / IGNITE_MS));
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
  /* ------- the om: the arrival, heard -------
     A retro om synthesized right here with the Web Audio API — two triangle
     voices and a square-wave partial pushed through a 4-bit staircase (the
     chiptune throat), a mouth filter that opens on "O" and closes into the
     "M" hum exactly when the hexagon ignites, and a two-note chip blip at
     ignition. No file, no request: the sound is source code, like everything
     else on this page. Browsers rightly refuse audio before a gesture, so
     the om only ever plays from the button that replays the arrival. */
  let actx = null;
  let omVoice = null;
  const omBtn = $('#om-btn');

  function ensureAudio() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      actx = new AC();
    }
    if (actx.state === 'suspended') actx.resume();
    return true;
  }

  function omDuck() {
    if (!actx || !omVoice) return;
    const now = actx.currentTime;
    const voice = omVoice;
    omVoice = null;
    if (omBtn) omBtn.classList.remove('playing');
    if (now >= voice.until - 0.2) return; // already breathing out on its own
    voice.env.gain.cancelScheduledValues(now);
    voice.env.gain.setTargetAtTime(0.0001, now, 0.07);
  }

  function omPlay() {
    if (!ensureAudio()) return;
    omDuck(); // one om at a time
    const t = actx.currentTime + 0.05;
    const O_S = INTRO_MS / 1000; // the convergence — the "O"
    const M_S = IGNITE_MS / 1000; // the ignition — the lips close into "M"
    const end = t + O_S + M_S + 2.4;

    // The chiptune throat: quantize the whole voice to 16 amplitude levels.
    const crush = actx.createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < 257; i++) curve[i] = Math.round((i / 128 - 1) * 8) / 8;
    crush.curve = curve;

    // The mouth: opens through the O, closes to a hum at ignition.
    const mouth = actx.createBiquadFilter();
    mouth.type = 'lowpass';
    mouth.Q.value = 0.9;
    mouth.frequency.setValueAtTime(620, t);
    mouth.frequency.linearRampToValueAtTime(1400, t + O_S * 0.7);
    mouth.frequency.setTargetAtTime(235, t + O_S, 0.16);

    // The breath: in over the convergence, a bloom at ignition, a long hum out.
    const env = actx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.15, t + Math.min(1.3, O_S * 0.62));
    env.gain.setValueAtTime(0.15, t + O_S);
    env.gain.linearRampToValueAtTime(0.18, t + O_S + 0.25);
    env.gain.setTargetAtTime(0.0001, t + O_S + M_S + 0.4, 0.5);
    mouth.connect(crush);
    crush.connect(env);
    env.connect(actx.destination);

    const voice = (type, freq, level, detune = 0) => {
      const osc = actx.createOscillator();
      const g = actx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      osc.detune.value = detune;
      g.gain.value = level;
      osc.connect(g);
      g.connect(mouth);
      osc.start(t);
      osc.stop(end + 0.1);
      return { osc, g };
    };
    const chest = voice('triangle', 110, 0.34); // the chest tone
    const chorus = voice('triangle', 110, 0.28, 9); // a second voice, slightly sharp
    voice('sine', 55, 0.30); // the floor
    const bright = voice('square', 220, 0.07); // chip harmonics — the "retro"
    bright.g.gain.setValueAtTime(0.07, t + O_S - 0.1);
    bright.g.gain.linearRampToValueAtTime(0, t + O_S + 0.3); // harmonics die as lips close

    // Slow vibrato arrives only once the tone has settled, like a held chant.
    const lfo = actx.createOscillator();
    const lfoDepth = actx.createGain();
    lfo.frequency.value = 5.2;
    lfoDepth.gain.setValueAtTime(0, t);
    lfoDepth.gain.linearRampToValueAtTime(3.2, t + O_S * 0.9);
    lfo.connect(lfoDepth);
    lfoDepth.connect(chest.osc.frequency);
    lfoDepth.connect(chorus.osc.frequency);
    lfo.start(t);
    lfo.stop(end + 0.1);

    // The ignition: a two-note chip blip, quiet, as the hexagon lights.
    const blip = actx.createOscillator();
    const blipG = actx.createGain();
    blip.type = 'square';
    blip.frequency.setValueAtTime(784, t + O_S);
    blip.frequency.setValueAtTime(1174.7, t + O_S + 0.09);
    blipG.gain.setValueAtTime(0.05, t + O_S);
    blipG.gain.exponentialRampToValueAtTime(0.0001, t + O_S + 0.75);
    blip.connect(blipG);
    blipG.connect(crush);
    blip.start(t + O_S);
    blip.stop(t + O_S + 0.8);

    omVoice = { env, until: end };
    if (omBtn) {
      omBtn.classList.add('playing');
      setTimeout(() => omBtn.classList.remove('playing'), (end - actx.currentTime) * 1000);
    }
  }

  function replayArrival() {
    omPlay();
    if (REDUCE.matches) return; // sound was asked for; motion was not
    phase = 'intro';
    t0 = null;
    document.body.classList.add('intro-live');
    document.body.classList.remove('intro-done');
    armFailsafe(); // the replay gets the same failsafe as the first act
  }
  if (omBtn) omBtn.addEventListener('click', replayArrival);

  window.__grid = { recolor };
  addEventListener('resize', layout);
  layout();
  loop();
})();

/* ------- the estate map: twelve districts, one owner -------
   Hovering or focusing a district lights it and its legend line together,
   and the caption tells that district's line. Pure enhancement: with no
   JavaScript the map, its labels, and the full legend are simply visible. */
(() => {
  const map = document.querySelector('#estate-map');
  const caption = document.querySelector('#estate-caption');
  if (!map || !caption) return;
  const restingCaption = caption.textContent;
  const paired = document.querySelectorAll('[data-own]');
  const sync = (index, lit) => {
    let desc = null;
    for (const el of paired) {
      if (el.dataset.own !== index) continue;
      el.classList.toggle('lit', lit);
      if (el.dataset.desc) desc = el.dataset.desc;
    }
    caption.textContent = lit && desc ? desc : restingCaption;
  };
  for (const el of paired) {
    el.addEventListener('mouseenter', () => sync(el.dataset.own, true));
    el.addEventListener('mouseleave', () => sync(el.dataset.own, false));
    el.addEventListener('focus', () => sync(el.dataset.own, true));
    el.addEventListener('blur', () => sync(el.dataset.own, false));
  }
})();

/* ------- the first week: moments surface as the reader reaches them -------
   Opt-in reveal: only when JS runs AND motion is allowed does body get
   .story-anim (which is what hides unseen moments) — so with no JavaScript,
   a blocked observer, or reduced motion, the whole story is simply visible. */
(() => {
  const moments = document.querySelectorAll('#week .moment');
  if (!moments.length || REDUCE.matches || !('IntersectionObserver' in window)) return;
  document.body.classList.add('story-anim');
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('seen');
        io.unobserve(entry.target);
      }
    }
  }, { threshold: 0.2, rootMargin: '0px 0px -8% 0px' });
  moments.forEach((moment) => io.observe(moment));
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

/* ------- access requests: the one door in -------
   Configuration comes from <meta> tags in land.html (this page's CSP forbids
   inline scripts, so window globals could never actually be set in
   production). waitlist-endpoint = any URL accepting a JSON POST
   (Formspree/Basin/a Worker); empty = mailto fallback to waitlist-email so
   no request is silently dropped. */
window.WAITLIST_ENDPOINT = document.querySelector('meta[name="waitlist-endpoint"]')?.content?.trim() || '';
window.WAITLIST_EMAIL = document.querySelector('meta[name="waitlist-email"]')?.content?.trim() || 'hello@mysovereign.ai';
(() => {
  const form = $('#wl-form');
  const errorEl = $('#wl-error');
  const submitBtn = $('#wl-submit');

  // The work-email gate: personal-mail domains are declined with an
  // explanation and a direct escape hatch — validate people, never lose them.
  const FREE_MAIL = [
    'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com',
    'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'aol.com',
    'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me',
    'gmx.com', 'gmx.net', 'mail.com', 'mail.ru', 'yandex.com', 'yandex.ru',
    'zoho.com', 'fastmail.com', 'hey.com', 'tutanota.com', 'tuta.io',
    'qq.com', '163.com', '126.com', 'naver.com', 'rediffmail.com',
  ];

  function showDone(via) {
    const address = window.WAITLIST_EMAIL;
    form.innerHTML = `
      <div class="wl-done">
        <div class="big" aria-hidden="true">⬡</div>
        <h3>${via === 'mail' ? 'One more step.' : 'Request received.'}</h3>
        <p>${via === 'mail'
          ? `Your email app should have opened with a pre-filled request — <b>send it</b> and it's in. If nothing opened, just email <a href="mailto:${address}">${address}</a> directly. You're not in the queue until that mail is sent — we'd rather say so than pretend.`
          : 'A person reads every request. Watch your inbox for your access grant.'}</p>
      </div>`;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    const email = $('#wl-email').value.trim();
    const name = $('#wl-name').value.trim();
    const company = $('#wl-company').value.trim();
    const use = $('#wl-use').value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errorEl.textContent = 'Please enter a valid email address.';
      $('#wl-email').focus();
      return;
    }
    const domain = email.split('@')[1].toLowerCase();
    if (FREE_MAIL.includes(domain)) {
      errorEl.innerHTML = `That looks like a personal address — please use your work email so we can verify the request. No work email? Email <a href="mailto:${window.WAITLIST_EMAIL}">${window.WAITLIST_EMAIL}</a> directly and make your case; a person reads it either way.`;
      $('#wl-email').focus();
      return;
    }
    const payload = {
      email, name, company, use,
      website: ($('#wl-hp')?.value || '').trim(), // honeypot — humans never see it
      source: 'landing-access', at: new Date().toISOString(),
    };

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
        submitBtn.textContent = 'Request access ⬡';
      }
    }

    // Fallback: never drop a request — open a pre-filled email.
    const subject = encodeURIComponent('SovereignAI access request');
    const body = encodeURIComponent(
      `I'm requesting access to SovereignAI.\n\nWork email: ${email}\nName: ${name || '—'}\nCompany: ${company || '—'}\nUse: ${use || '—'}\n`
    );
    window.location.href = `mailto:${window.WAITLIST_EMAIL}?subject=${subject}&body=${body}`;
    showDone('mail');
  });
})();
