'use strict';
/* The film — ten shots, drawn live on a canvas. There is no video file: the
   whole argument is a few hundred lines of code, which is itself the point.
   Nothing here is decorative for its own sake — every shot draws the thing the
   line is claiming. Under prefers-reduced-motion, or with scripts off, the
   written cut on the page is what a visitor gets instead, and it says the same
   thing in the same order. */

const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (sel) => document.querySelector(sel);

const film = $('#film');
const read = $('#read');
const canvas = $('#stage');
const captionEl = $('#caption');
const lineEl = $('#line');
const subEl = $('#sub');
const railEl = $('#rail');
const playBtn = $('#playpause');
const soundBtn = $('#sound');

/* The shards: the same life-surface list the landing scatters, because it is
   the same argument told twice. */
const SHARDS = [
  'email', 'search', 'bank', 'broker', 'crypto', 'mortgage', 'insurance',
  'health records', 'pharmacy', 'wearable', 'gym', 'shopping', 'groceries',
  'airlines', 'hotels', 'messaging', 'social', 'gaming', 'school', 'car',
  'utilities', 'streaming', 'LLM providers', 'postal', 'cloud drive',
  'calendar', 'maps', 'food delivery', 'taxes', 'phone carrier',
];

const SHOTS = [
  {
    id: 'scatter', ms: 6200, draw: drawScatter,
    line: 'You are the most fragmented database on earth.',
    sub: 'Forty-odd services. Each one holds a shard of you.',
  },
  {
    id: 'claimed', ms: 6400, draw: drawClaimed,
    line: 'Every company owns a complete profile of their sliver.',
    sub: 'Complete enough to monetize. Too partial to understand a life.',
  },
  {
    id: 'joins', ms: 6600, draw: drawJoins,
    line: 'The joins are where your life actually is.',
    sub: 'No vendor can build them — and no vendor should be the one holding them.',
  },
  {
    id: 'moat', ms: 6600, draw: drawMoat,
    line: 'And now the thing collecting you <em>remembers</em> you.',
    sub: 'The model was never the moat. The memory is.',
  },
  {
    id: 'converge', ms: 5600, draw: drawConverge,
    line: 'So we built the opposite.',
    sub: 'One file. On hardware you own.',
  },
  {
    id: 'ignite', ms: 5200, draw: drawIgnite,
    line: 'One mind. Yours.',
    sub: 'No account. No cloud. Works on a plane.',
  },
  {
    id: 'receipts', ms: 7000, draw: drawReceipts,
    line: 'Every memory carries a receipt.',
    sub: 'How it entered, which conversation it came from, which model wrote it.',
  },
  {
    id: 'exit', ms: 7000, draw: drawExit,
    line: 'Deleting deletes. Leaving works.',
    sub: 'One checksummed archive you can encrypt, and verify without importing.',
  },
  {
    id: 'ledger', ms: 7200, draw: drawLedger,
    line: 'And we publish what still <em>isn’t</em> sovereign.',
    sub: 'An unknown is reported as unknown, never rounded up to a feature.',
  },
  {
    id: 'title', ms: 6800, draw: drawTitle,
    line: 'Own every layer you can.',
    sub: 'Rent nothing you can’t walk away from. — mysovereign.ai',
  },
];

/* ---------------- geometry ---------------- */
let W = 0, H = 0, DPR = 1;
let shards = [];
let vaults = [];
const ctx = canvas.getContext('2d');

function layout() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  W = canvas.clientWidth;
  H = canvas.clientHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  const cx = W / 2, cy = H * 0.44;
  const spread = Math.min(W, H * 1.5);

  // Six holders around the frame — the companies that each own a sliver.
  vaults = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    vaults.push({
      x: cx + Math.cos(a) * spread * 0.46,
      y: cy + Math.sin(a) * spread * 0.30,
      w: Math.max(74, spread * 0.13),
      h: Math.max(30, spread * 0.05),
    });
  }

  shards = SHARDS.map((label, i) => {
    const a = (i / SHARDS.length) * Math.PI * 2 + (i % 3) * 0.4;
    const r = 0.30 + ((i * 37) % 100) / 260;
    return {
      label,
      x: cx + Math.cos(a) * spread * r * 0.92,
      y: cy + Math.sin(a) * spread * r * 0.56,
      phase: (i * 1.7) % (Math.PI * 2),
      vault: i % 6,
      jitter: ((i * 71) % 17) / 17,
    };
  });
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;
const clamp01 = (t) => Math.min(1, Math.max(0, t));

function hexPath(x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + i * Math.PI / 3;
    const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function shardPos(s, now) {
  const drift = Math.sin(now / 2600 + s.phase) * 5;
  return { x: s.x + drift, y: s.y + Math.cos(now / 3100 + s.phase) * 4 };
}
function labelFont(size = 11) {
  ctx.font = `${size}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
}
function center() { return { cx: W / 2, cy: H * 0.44 }; }

/* ---------------- shots ---------------- */
function drawScatter(p, now) {
  const a = easeOut(clamp01(p * 1.6));
  labelFont();
  for (const s of shards) {
    const { x, y } = shardPos(s, now);
    ctx.globalAlpha = a * 0.62;
    ctx.fillStyle = '#a49a90';
    ctx.fillText(s.label, x, y);
    ctx.globalAlpha = a * 0.5;
    ctx.fillStyle = '#d97757';
    hexPath(x, y - 15, 2.4);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawClaimed(p, now) {
  const a = easeOut(clamp01(p * 1.5));
  // the holders
  ctx.lineWidth = 1;
  for (const v of vaults) {
    ctx.globalAlpha = a * 0.5;
    ctx.strokeStyle = '#d97757';
    roundRect(v.x - v.w / 2, v.y - v.h / 2, v.w, v.h, 6);
    ctx.stroke();
    ctx.globalAlpha = a * 0.07;
    ctx.fillStyle = '#d97757';
    ctx.fill();
  }
  // each shard tethered to the company that holds it
  for (const s of shards) {
    const { x, y } = shardPos(s, now);
    const v = vaults[s.vault];
    const t = clamp01((p - s.jitter * 0.25) * 1.9);
    if (t > 0) {
      ctx.globalAlpha = a * 0.22 * t;
      ctx.strokeStyle = '#d97757';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (v.x - x) * easeOut(t), y + (v.y - y) * easeOut(t));
      ctx.stroke();
    }
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = '#a49a90';
    labelFont();
    ctx.fillText(s.label, x, y);
  }
  // the whole person: an outline nobody holds
  const { cx, cy } = center();
  ctx.globalAlpha = a * 0.3;
  ctx.strokeStyle = '#f0eee6';
  ctx.setLineDash([4, 7]);
  ctx.lineWidth = 1.2;
  hexPath(cx, cy, Math.min(W, H) * 0.085);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function drawJoins(p, now) {
  drawClaimed(1, now);
  // the joins a person actually wants — drawn, then failing
  const pairs = [[0, 9], [3, 21], [7, 12], [1, 25], [5, 18], [10, 28]];
  ctx.lineWidth = 1.4;
  for (let i = 0; i < pairs.length; i++) {
    const t = clamp01((p - i * 0.09) * 2.3);
    if (t <= 0) continue;
    const A = shardPos(shards[pairs[i][0]], now);
    const B = shardPos(shards[pairs[i][1]], now);
    const fail = clamp01((p - 0.55 - i * 0.05) * 3.4);
    ctx.globalAlpha = (0.5 * easeOut(t)) * (1 - fail);
    ctx.strokeStyle = '#f0eee6';
    ctx.setLineDash([3, 6]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2 - 40;
    const e = easeOut(t) * (1 - fail * 0.7);
    ctx.quadraticCurveTo(mx, my, A.x + (B.x - A.x) * e, A.y + (B.y - A.y) * e);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function drawMoat(p, now) {
  const a = 1 - easeOut(clamp01(p * 1.2)) * 0.75;
  labelFont();
  for (const s of shards) {
    const { x, y } = shardPos(s, now);
    const pull = easeIn(clamp01(p * 1.1));
    const { cx, cy } = center();
    ctx.globalAlpha = a * 0.55;
    ctx.fillStyle = '#a49a90';
    ctx.fillText(s.label, x + (cx - x) * pull * 0.42, y + (cy - y) * pull * 0.42);
  }
  // the vault that closes over all of it
  const { cx, cy } = center();
  const w = Math.min(W * 0.62, 560), h = Math.min(H * 0.42, 300);
  const close = easeOut(clamp01((p - 0.15) * 1.5));
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = '#d97757';
  ctx.lineWidth = 2;
  roundRect(cx - w / 2, cy - h / 2, w, h * close, 10);
  ctx.stroke();
  ctx.globalAlpha = 0.14 * close;
  ctx.fillStyle = '#d97757';
  ctx.fill();
  // the lid
  ctx.globalAlpha = close;
  ctx.strokeStyle = '#e8926f';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, cy - h / 2 + h * close);
  ctx.lineTo(cx + w / 2, cy - h / 2 + h * close);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawConverge(p, now) {
  const { cx, cy } = center();
  labelFont();
  for (const s of shards) {
    const base = shardPos(s, now);
    const t = easeIn(clamp01((p - s.jitter * 0.2) / (1 - s.jitter * 0.2 || 1)));
    const x = base.x + (cx - base.x) * t;
    const y = base.y + (cy - base.y) * t;
    ctx.globalAlpha = 0.6 * (1 - t * 0.92) + 0.05;
    ctx.fillStyle = '#a49a90';
    ctx.fillText(s.label, x, y);
  }
  ctx.globalAlpha = clamp01(p * 1.6) * 0.85;
  ctx.strokeStyle = '#d97757';
  ctx.lineWidth = 2;
  hexPath(cx, cy, 12 + 8 * easeOut(clamp01(p)));
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawIgnite(p) {
  const { cx, cy } = center();
  const R = Math.min(W, H) * 0.11;
  // the ring going out
  const ring = easeOut(clamp01(p * 1.5));
  ctx.globalAlpha = (1 - ring) * 0.85;
  ctx.strokeStyle = '#d97757';
  ctx.lineWidth = 2.5;
  hexPath(cx, cy, R * (0.5 + ring * 2.2));
  ctx.stroke();
  // the mind itself
  ctx.globalAlpha = clamp01(p * 2.4);
  ctx.fillStyle = '#d97757';
  hexPath(cx, cy, R);
  ctx.fill();
  ctx.globalAlpha = clamp01(p * 2.4) * 0.9;
  ctx.fillStyle = '#12110f';
  labelFont(Math.max(13, R * 0.33));
  ctx.fillText('⬡', cx, cy + 1);
  ctx.globalAlpha = 1;
}

const RECEIPTS = [
  ['prefers Friday demos', 'added by you'],
  ['ships on Windows 11', 'from "standup" · llama3.1'],
  ['mortgage stays variable', 'added by you'],
  ['gym renews in 29 days', 'from your inbox import'],
  ['likes terse answers', 'distilled · llama3.1'],
  ['drinks too much espresso', 'origin unknown'],
];
function drawReceipts(p, now) {
  const { cx, cy } = center();
  const R = Math.min(W, H) * 0.085;
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#d97757';
  hexPath(cx, cy, R);
  ctx.fill();

  const orbit = Math.min(W, H) * 0.30;
  for (let i = 0; i < RECEIPTS.length; i++) {
    const t = clamp01((p - i * 0.08) * 3);
    if (t <= 0) continue;
    const a = (i / RECEIPTS.length) * Math.PI * 2 - Math.PI / 2 + now / 26000;
    const x = cx + Math.cos(a) * orbit * 1.15;
    const y = cy + Math.sin(a) * orbit * 0.62;
    // the last one is struck, to show deletion is deletion
    const struck = i === RECEIPTS.length - 1 ? clamp01((p - 0.72) * 4) : 0;
    ctx.globalAlpha = easeOut(t) * 0.3 * (1 - struck);
    ctx.strokeStyle = '#d97757';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.lineTo(x, y);
    ctx.stroke();

    ctx.globalAlpha = easeOut(t) * (1 - struck);
    labelFont(11.5);
    ctx.fillStyle = '#f0eee6';
    ctx.fillText(struck > 0 ? '0x00 0x00 0x00' : RECEIPTS[i][0], x, y - 7);
    ctx.globalAlpha = easeOut(t) * 0.6 * (1 - struck);
    labelFont(9.5);
    ctx.fillStyle = '#a49a90';
    ctx.fillText(RECEIPTS[i][1], x, y + 7);
  }
  ctx.globalAlpha = 1;
}

function drawExit(p) {
  const { cx, cy } = center();
  const gather = easeIn(clamp01(p * 1.5));
  const orbit = Math.min(W, H) * 0.30;
  // every cell folds into one archive
  for (let i = 0; i < RECEIPTS.length; i++) {
    const a = (i / RECEIPTS.length) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * orbit * 1.15 * (1 - gather);
    const y = cy + Math.sin(a) * orbit * 0.62 * (1 - gather);
    ctx.globalAlpha = 0.7 * (1 - gather);
    labelFont(11);
    ctx.fillStyle = '#a49a90';
    ctx.fillText(RECEIPTS[i][0], x, y);
  }
  const w = Math.min(W * 0.42, 300), h = Math.min(H * 0.2, 130);
  ctx.globalAlpha = clamp01(gather * 1.4);
  ctx.strokeStyle = '#d97757';
  ctx.lineWidth = 2;
  roundRect(cx - w / 2, cy - h / 2, w, h, 10);
  ctx.stroke();
  ctx.globalAlpha = clamp01(gather * 1.4) * 0.1;
  ctx.fillStyle = '#d97757';
  ctx.fill();

  ctx.globalAlpha = clamp01(gather * 1.4);
  labelFont(12);
  ctx.fillStyle = '#f0eee6';
  ctx.fillText('backup.json', cx, cy - 10);
  const digest = 'sha256:9f41c2ab7e02…';
  const shown = digest.slice(0, Math.floor(clamp01((p - 0.45) * 2.6) * digest.length));
  ctx.fillStyle = '#a49a90';
  labelFont(10.5);
  ctx.fillText(shown, cx, cy + 12);
  if (p > 0.85) {
    ctx.fillStyle = '#7bbd95';
    ctx.fillText('✓ verified', cx, cy + h / 2 + 22);
  }
  ctx.globalAlpha = 1;
}

const LEDGER = [
  ['your data', 'sovereign', '#7bbd95'],
  ['provenance', 'sovereign', '#7bbd95'],
  ['runtime', 'sovereign', '#7bbd95'],
  ['distribution', 'conditional', '#d9ab63'],
  ['at-rest encryption', 'not yet — use disk encryption', '#d9ab63'],
  ['the model', 'borrowed', '#e08a72'],
];
function drawLedger(p) {
  const { cx, cy } = center();
  const w = Math.min(W * 0.74, 520);
  const rowH = Math.min(34, H * 0.055);
  const top = cy - (LEDGER.length * rowH) / 2;
  for (let i = 0; i < LEDGER.length; i++) {
    const t = clamp01((p - i * 0.1) * 3.4);
    if (t <= 0) continue;
    const y = top + i * rowH;
    ctx.globalAlpha = easeOut(t) * 0.5;
    ctx.strokeStyle = '#35312d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - w / 2, y + rowH - 6);
    ctx.lineTo(cx + w / 2, y + rowH - 6);
    ctx.stroke();

    ctx.globalAlpha = easeOut(t);
    ctx.fillStyle = LEDGER[i][2];
    hexPath(cx - w / 2 + 9, y + rowH / 2 - 3, 4);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '12.5px ui-monospace, Consolas, monospace';
    ctx.fillStyle = '#f0eee6';
    ctx.fillText(LEDGER[i][0], cx - w / 2 + 24, y + rowH / 2 - 3);
    ctx.textAlign = 'right';
    ctx.fillStyle = LEDGER[i][2];
    ctx.fillText(LEDGER[i][1], cx + w / 2 - 4, y + rowH / 2 - 3);
  }
  ctx.textAlign = 'center';
  ctx.globalAlpha = 1;
}

function drawTitle(p, now) {
  const { cx, cy } = center();
  const R = Math.min(W, H) * 0.1;
  const breathe = 1 + Math.sin(now / 1400) * 0.02;
  ctx.globalAlpha = clamp01(p * 3);
  ctx.fillStyle = '#d97757';
  hexPath(cx, cy - 10, R * breathe);
  ctx.fill();
  ctx.fillStyle = '#12110f';
  labelFont(Math.max(15, R * 0.42));
  ctx.fillText('⬡', cx, cy - 9);
  ctx.globalAlpha = clamp01((p - 0.15) * 3) * 0.75;
  ctx.fillStyle = '#a49a90';
  labelFont(11.5);
  ctx.fillText('mysovereign.ai', cx, cy + R + 26);
  ctx.globalAlpha = 1;
}

/* ---------------- the om, only ever on request ---------------- */
let actx = null, soundOn = false;
function playOm() {
  if (!soundOn) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!actx) actx = new AC();
    if (actx.state === 'suspended') actx.resume();
    const t = actx.currentTime + 0.03;
    const end = t + 5.4;
    const crush = actx.createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < 257; i++) curve[i] = Math.round((i / 128 - 1) * 8) / 8;
    crush.curve = curve;
    const mouth = actx.createBiquadFilter();
    mouth.type = 'lowpass';
    mouth.Q.value = 0.9;
    mouth.frequency.setValueAtTime(620, t);
    mouth.frequency.linearRampToValueAtTime(1400, t + 1.5);
    mouth.frequency.setTargetAtTime(235, t + 2.1, 0.16);
    const env = actx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.13, t + 1.3);
    env.gain.setValueAtTime(0.13, t + 2.1);
    env.gain.setTargetAtTime(0.0001, t + 2.8, 0.5);
    mouth.connect(crush); crush.connect(env); env.connect(actx.destination);
    for (const [type, freq, level] of [['triangle', 110, 0.34], ['triangle', 110, 0.26], ['sine', 55, 0.3], ['square', 220, 0.06]]) {
      const osc = actx.createOscillator(), g = actx.createGain();
      osc.type = type; osc.frequency.value = freq; g.gain.value = level;
      osc.connect(g); g.connect(mouth); osc.start(t); osc.stop(end);
    }
  } catch { /* silence is an acceptable outcome */ }
}

/* ---------------- the projector ---------------- */
let index = 0, elapsed = 0, last = 0, paused = false, running = false, raf = null;

const railButtons = SHOTS.map((shot, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'tab');
  b.setAttribute('aria-label', `Shot ${i + 1}: ${shot.line.replace(/<[^>]+>/g, '')}`);
  b.addEventListener('click', () => goTo(i));
  railEl.appendChild(b);
  return b;
});

function showCaption(i) {
  captionEl.classList.remove('in');
  // Let the fade-out land before the next line replaces it.
  setTimeout(() => {
    lineEl.innerHTML = SHOTS[i].line;
    subEl.textContent = SHOTS[i].sub;
    captionEl.classList.add('in');
  }, 180);
}

function goTo(i) {
  index = Math.max(0, Math.min(SHOTS.length - 1, i));
  elapsed = 0;
  railButtons.forEach((b, n) => {
    b.classList.toggle('done', n < index);
    b.style.setProperty('--p', n < index ? '100%' : '0%');
  });
  showCaption(index);
  if (SHOTS[index].id === 'ignite') playOm();
}

function finish() {
  running = false;
  cancelAnimationFrame(raf);
  film.style.transition = 'opacity 700ms ease';
  film.style.opacity = '0';
  setTimeout(dismiss, 700);
}

function dismiss() {
  running = false;
  cancelAnimationFrame(raf);
  film.hidden = true;
  document.body.style.overflow = '';
  read.scrollIntoView({ block: 'start' });
}

function frame(now) {
  if (!running) return;
  const dt = last ? now - last : 16;
  last = now;
  if (!paused) elapsed += dt;

  const shot = SHOTS[index];
  const p = clamp01(elapsed / shot.ms);
  railButtons[index].style.setProperty('--p', `${p * 100}%`);

  ctx.clearRect(0, 0, W, H);
  shot.draw(p, now);

  if (elapsed >= shot.ms) {
    if (index >= SHOTS.length - 1) { finish(); return; }
    goTo(index + 1);
  }
  raf = requestAnimationFrame(frame);
}

function start() {
  film.hidden = false;
  document.body.style.overflow = 'hidden';
  layout();
  running = true;
  last = 0;
  goTo(0);
  raf = requestAnimationFrame(frame);
}

playBtn.addEventListener('click', () => {
  paused = !paused;
  playBtn.textContent = paused ? '▶' : '❚❚';
  playBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
});
soundBtn.addEventListener('click', () => {
  soundOn = !soundOn;
  soundBtn.setAttribute('aria-pressed', String(soundOn));
  soundBtn.textContent = soundOn ? '⬡ sound on' : '⬡ sound';
  if (soundOn) playOm();
});
document.querySelector('.skip').addEventListener('click', (e) => { e.preventDefault(); dismiss(); });

addEventListener('keydown', (e) => {
  if (film.hidden) return;
  if (e.key === 'ArrowRight') goTo(index + 1);
  else if (e.key === 'ArrowLeft') goTo(index - 1);
  else if (e.key === 'Escape') dismiss();
  else if (e.key === ' ') { e.preventDefault(); playBtn.click(); }
});
addEventListener('resize', () => { if (running) layout(); });

// The film is an enhancement. Reduced motion keeps the written cut instead.
if (!REDUCE) start();
