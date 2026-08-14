'use strict';
/* ================= token bootstrap (same contract as the classic UI) ============ */
/* On the public demo host (the marketing site) no instance can exist, so no
   token is ever read, stored, or sent on that origin — a real install's
   #token= link pasted there must not persist a credential. The hash is still
   scrubbed so the secret never lingers in the address bar or history. */
const PUBLIC_DEMO_HOST = /(^|\.)mysovereign\.ai$|\.vercel\.app$/.test(location.hostname);
const HEADERS = (() => {
  let token = '';
  try {
    const url = new URL(location.href);
    if (url.hash.startsWith('#token=')) {
      if (!PUBLIC_DEMO_HOST) {
        try { token = decodeURIComponent(url.hash.slice(7)); } catch { token = url.hash.slice(7); }
        try { localStorage.setItem('sovereign-token', token); } catch { /* private session */ }
      }
      try { url.hash = ''; history.replaceState(null, '', url); } catch { /* fine */ }
    }
  } catch { /* fine */ }
  return () => {
    if (PUBLIC_DEMO_HOST) return {};
    try { token = token || localStorage.getItem('sovereign-token') || ''; } catch { /* fine */ }
    return token ? { authorization: `Bearer ${token}` } : {};
  };
})();

const $ = (sel) => document.querySelector(sel);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const state = {
  demo: false,
  personas: [],
  personaId: null,
  conversationId: null,
  streaming: false,
  abort: null,
};

/* ================= tiny helpers ================= */
function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function renderVoice(text) {
  const safe = esc(text);
  const withFences = safe.replace(/```([^`]*)```/g, (_, code) => `<pre><code>${code.replace(/^\n/, '')}</code></pre>`);
  return withFences
    .split(/\n{2,}/)
    .map((block) => block.startsWith('<pre>') ? block : `<p>${block
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>')
      .replace(/\n/g, '<br>')}</p>`)
    .join('');
}
async function api(method, path, body, signal) {
  const headers = { ...HEADERS() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = (response.headers.get('content-type') || '').includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text();
  if (!response.ok) throw new Error((payload && payload.error) || response.statusText || `HTTP ${response.status}`);
  return payload;
}
async function* sseIterate(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) {
        try { yield { event, data: JSON.parse(dataLines.join('\n')) }; } catch { /* skip malformed frame */ }
      }
    }
  }
}
let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}
function status(html, isError) {
  const el = $('#stem-status');
  el.innerHTML = html || '';
  el.classList.toggle('err', Boolean(isError));
}

/* ================= theme ================= */
(() => {
  const order = ['auto', 'dark', 'light'];
  let current = 'auto';
  try { current = localStorage.getItem('xbrain-theme') || 'auto'; } catch { /* fine */ }
  const apply = () => {
    if (current === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = current;
    $('#theme-btn').textContent = `theme: ${current}`;
    field.recolor();
  };
  $('#theme-btn').addEventListener('click', () => {
    current = order[(order.indexOf(current) + 1) % order.length];
    try { localStorage.setItem('xbrain-theme', current); } catch { /* fine */ }
    apply();
  });
  queueMicrotask(apply);
})();

/* ================= the mind field (canvas cortex) ================= */
const FIELD_LIMIT = 220;
const field = {
  canvas: null, ctx: null, dpr: 1, w: 0, h: 0,
  cells: [],           // { id, kind, label, body, slot, x, y, phase, lit, litAt, bornAt }
  slots: [],           // available lattice positions
  ripples: [],         // { x, y, startedAt }
  threads: [],         // { cell, targetEl, startedAt, fading }
  colors: {},
  raf: null,
  lastDraw: 0,

  init() {
    this.canvas = $('#mindfield');
    this.ctx = this.canvas.getContext('2d');
    addEventListener('resize', () => this.layout());
    this.canvas.addEventListener('pointermove', (event) => this.hover(event, this.canvas));
    this.canvas.addEventListener('click', (event) => {
      const cell = this.hitTest(event.clientX, event.clientY);
      if (cell) { inspect(cell, event); event.stopPropagation(); }
    });
    // the manuscript's margins sit above the canvas: forward their clicks to the field
    const manuscript = $('#manuscript');
    manuscript.addEventListener('pointermove', (event) => {
      if (event.target === manuscript) this.hover(event, manuscript);
    });
    manuscript.addEventListener('click', (event) => {
      if (event.target !== manuscript) return;
      const cell = this.hitTest(event.clientX, event.clientY);
      if (cell) { inspect(cell, event); event.stopPropagation(); }
    });
    this.layout();
    this.loop();
  },
  recolor() {
    const styles = getComputedStyle(document.documentElement);
    this.colors = {
      cell: styles.getPropertyValue('--field-cell').trim(),
      lit: styles.getPropertyValue('--field-lit').trim(),
      thread: styles.getPropertyValue('--gold').trim(),
    };
  },
  layout() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // pointy-top hex lattice across the viewport
    const R = 13;
    const dx = Math.sqrt(3) * R;
    const dy = 1.5 * R;
    this.slots = [];
    for (let row = 0; row * dy < this.h + dy; row++) {
      for (let col = 0; col * dx < this.w + dx; col++) {
        this.slots.push({ x: col * dx + (row % 2 ? dx / 2 : 0) + 8, y: row * dy + 10 });
      }
    }
    // deterministic scatter: cell i claims slot (i * prime) mod slots, skipping collisions
    const taken = new Set();
    for (let i = 0; i < this.cells.length; i++) {
      let slot = (i * 48271 + 11) % this.slots.length;
      while (taken.has(slot)) slot = (slot + 97) % this.slots.length;
      taken.add(slot);
      this.cells[i].x = this.slots[slot].x;
      this.cells[i].y = this.slots[slot].y;
    }
    this.recolor();
    this.draw(performance.now());
  },
  addCell(kind, label, body, { lit = false, born = false, id = null } = {}) {
    if (this.cells.length >= FIELD_LIMIT) return null;
    const cell = {
      id, kind, label, body,
      x: 0, y: 0,
      phase: Math.random() * Math.PI * 2,
      lit, litAt: lit ? performance.now() : 0,
      bornAt: born ? performance.now() : 0,
    };
    this.cells.push(cell);
    this.layout();
    updateLegend();
    renderIndex();
    return cell;
  },
  ignite(predicate, targetEl) {
    const now = performance.now();
    let hits = 0;
    for (const cell of this.cells) {
      if (!predicate(cell)) continue;
      hits++;
      if (!cell.lit) {
        cell.lit = true;
        cell.litAt = now;
        this.ripples.push({ x: cell.x, y: cell.y, startedAt: now });
      }
      if (targetEl) this.threads.push({ cell, targetEl, startedAt: now, fading: false });
    }
    renderIndex();
    return hits;
  },
  extinguish() {
    for (const cell of this.cells) cell.lit = false;
    this.threads = [];
    this.ripples = [];
    renderIndex();
  },
  fadeThreads() {
    const now = performance.now();
    for (const thread of this.threads) { thread.fading = true; thread.fadedAt = now; }
  },
  hitTest(x, y) {
    for (const cell of this.cells) {
      const dx = cell.x - x;
      const dy = cell.y - y;
      if (dx * dx + dy * dy < 14 * 14) return cell;
    }
    return null;
  },
  hover(event, surface) {
    surface.style.cursor = this.hitTest(event.clientX, event.clientY) ? 'pointer' : '';
  },
  hexPath(x, y, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = Math.PI / 6 + (i * Math.PI) / 3;
      const px = x + r * Math.cos(angle);
      const py = y + r * Math.sin(angle);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  },
  draw(now) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    const still = REDUCED.matches;

    // threads first, under the cells
    this.threads = this.threads.filter((thread) => !thread.fading || now - thread.fadedAt < 900);
    for (const thread of this.threads) {
      const rect = thread.targetEl.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > this.h) continue;
      const tx = rect.left + 14;
      const ty = rect.top + 14;
      const alpha = thread.fading ? Math.max(0, 0.35 * (1 - (now - thread.fadedAt) / 900)) : 0.35;
      ctx.strokeStyle = this.colors.thread;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(thread.cell.x, thread.cell.y);
      ctx.quadraticCurveTo((thread.cell.x + tx) / 2, Math.min(thread.cell.y, ty) - 40, tx, ty);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ripples
    this.ripples = this.ripples.filter((ripple) => now - ripple.startedAt < 1100);
    if (!still) {
      for (const ripple of this.ripples) {
        const t = (now - ripple.startedAt) / 1100;
        ctx.strokeStyle = this.colors.lit;
        ctx.globalAlpha = 0.4 * (1 - t);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(ripple.x, ripple.y, 12 + t * 70, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // cells
    for (const cell of this.cells) {
      let r = 8;
      if (cell.bornAt && now - cell.bornAt < 700 && !still) {
        const t = (now - cell.bornAt) / 700;
        r = 8 * (t < 0.6 ? t / 0.6 * 1.35 : 1.35 - (t - 0.6) / 0.4 * 0.35);
      }
      if (cell.lit) {
        const settle = Math.min(1, (now - cell.litAt) / 500);
        ctx.shadowColor = this.colors.lit;
        ctx.shadowBlur = still ? 8 : 8 + 6 * settle;
        ctx.fillStyle = this.colors.lit;
        this.hexPath(cell.x, cell.y, r + 1.5);
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        const breathe = still ? 0 : 0.35 * Math.sin(now / 2600 + cell.phase);
        ctx.globalAlpha = Math.max(0.25, 0.7 + breathe) ;
        ctx.fillStyle = this.colors.cell;
        this.hexPath(cell.x, cell.y, r);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  },
  loop() {
    const step = (now) => {
      // ~30fps is plenty for ambience; skip entirely when hidden
      if (!document.hidden && now - this.lastDraw > 33) {
        this.lastDraw = now;
        this.draw(now);
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  },
};

function addCell(kind, label, body, options) { return field.addCell(kind, label, body, options); }
function ignite(predicate, targetEl) { return field.ignite(predicate, targetEl); }
function updateLegend() {
  const memories = field.cells.filter((cell) => cell.kind === 'memory').length;
  const documents = field.cells.length - memories;
  $('#field-legend').innerHTML =
    `the field holds <b>${field.cells.length}</b> cells (${memories} memories · ${documents} knowledge) · recalled cells ignite and thread into the answer`;
}

/* cortex index: keyboard door into the field */
function renderIndex() {
  const index = $('#cortex-index');
  if (index.hidden) return;
  index.innerHTML = '<h2>cortex index</h2>' + (field.cells.length ? '' : '<span style="font-size:0.72rem;color:var(--dim)">no cells yet</span>');
  for (const cell of field.cells) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `cell-row${cell.lit ? ' lit' : ''}`;
    row.innerHTML = `<span class="k">${cell.lit ? '⬢' : '⬡'}</span>`;
    row.appendChild(document.createTextNode(`${cell.kind}: ${cell.label.slice(0, 80)}`));
    row.addEventListener('click', (event) => inspect(cell, event));
    index.appendChild(row);
  }
}
$('#index-toggle').addEventListener('click', () => {
  const index = $('#cortex-index');
  index.hidden = !index.hidden;
  $('#index-toggle').setAttribute('aria-expanded', String(!index.hidden));
  renderIndex();
});

function inspect(cell, event) {
  const panel = $('#inspector');
  const jump = cell.kind === 'memory'
    ? '<a href="/xbrain-ledger.html">open the ledger ↗</a>'
    : '<a href="/xbrain-atlas.html">view in atlas ↗</a>';
  panel.innerHTML = `<span class="kind">${esc(cell.kind)} · ${jump}</span><span class="body">${esc(cell.body.slice(0, 420))}${cell.body.length > 420 ? '…' : ''}</span>`;
  panel.hidden = false;
  const x = Math.min(event.clientX ?? innerWidth / 2, innerWidth - 360);
  const y = Math.min((event.clientY ?? innerHeight / 3) + 14, innerHeight - 180);
  panel.style.left = `${Math.max(8, x)}px`;
  panel.style.top = `${y}px`;
}
document.addEventListener('click', (event) => {
  if (!event.target.closest('#inspector') && !event.target.closest('#cortex-index') &&
      !event.target.closest('#index-toggle') && event.target.id !== 'mindfield') {
    $('#inspector').hidden = true;
  }
  if (!event.target.closest('#cortex-index') && !event.target.closest('#index-toggle') && event.target.id !== 'mindfield') {
    $('#cortex-index').hidden = true;
    $('#index-toggle').setAttribute('aria-expanded', 'false');
  }
});

/* ================= exchanges ================= */
function addExchange(question) {
  $('#empty-mind')?.remove();
  const exchange = document.createElement('article');
  exchange.className = 'exchange';
  exchange.innerHTML = `
    <div class="command"></div>
    <div class="voice"><span class="caret">▌</span></div>
    <div class="faces" role="tablist" aria-label="Answer faces" hidden>
      <button class="face-tab" role="tab" data-face="voice" aria-selected="true" type="button">voice</button>
      <button class="face-tab" role="tab" data-face="recall" aria-selected="false" type="button">recall</button>
      <button class="face-tab" role="tab" data-face="trace" aria-selected="false" type="button">trace</button>
    </div>
    <div class="face-pane" data-pane="recall" hidden></div>
    <div class="face-pane" data-pane="trace" hidden></div>`;
  exchange.querySelector('.command').textContent = question;
  $('#thread').appendChild(exchange);
  exchange.querySelectorAll('.face-tab').forEach((tab) => tab.addEventListener('click', () => {
    exchange.querySelectorAll('.face-tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    const face = tab.dataset.face;
    exchange.querySelector('.voice').style.display = face === 'voice' ? '' : 'none';
    exchange.querySelectorAll('.face-pane').forEach((pane) => { pane.hidden = pane.dataset.pane !== face; });
  }));
  $('#manuscript').scrollTop = $('#manuscript').scrollHeight;
  return exchange;
}
function finishExchange(exchange, { text, sources, memories = [], trace }) {
  exchange.querySelector('.voice').innerHTML = renderVoice(text);
  exchange.querySelector('.faces').hidden = false;
  const recall = exchange.querySelector('[data-pane="recall"]');
  const parts = [];
  if (sources.length) {
    const top = Math.max(...sources.map((s) => s.score ?? 0), 0.0001);
    parts.push(sources.map((s) => `
      <div class="recall-item">
        <span class="recall-score">${(s.score ?? 0).toFixed(2)}<span class="recall-bar"><i style="width:${Math.round(((s.score ?? 0) / top) * 100)}%"></i></span></span>
        <span><span class="recall-doc">${esc(s.document || s.kind || 'memory')} <a class="recall-jump" href="/xbrain-atlas.html">atlas ↗</a></span>
        <span class="recall-excerpt">${esc((s.excerpt || '').slice(0, 300))}</span></span>
      </div>`).join(''));
  }
  if (memories.length) {
    parts.push(memories.map((m) => `
      <div class="recall-item">
        <span class="recall-score" aria-hidden="true">⬡</span>
        <span><span class="recall-doc">note recalled <a class="recall-jump" href="/xbrain-ledger.html">ledger ↗</a></span>
        <span class="recall-excerpt">${esc((m.excerpt || '').slice(0, 300))}</span></span>
      </div>`).join(''));
  }
  recall.innerHTML = parts.length
    ? parts.join('')
    : '<span class="recall-none">Nothing was retrieved — this answer came from the model and persona alone. That is worth knowing too.</span>';
  const tracePane = exchange.querySelector('[data-pane="trace"]');
  tracePane.innerHTML = `<dl class="trace-grid">${Object.entries(trace)
    .map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(String(value))}</dd>`).join('')}</dl>`;
  field.fadeThreads();
}

/* ================= consented memory: select → keep ================= */
(() => {
  const chip = $('#keep-chip');
  let pendingText = '';
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    const text = selection ? selection.toString().trim() : '';
    if (!text || text.length > 2000 || selection.rangeCount === 0 ||
        !selection.anchorNode?.parentElement?.closest('.voice')) {
      chip.hidden = true;
      return;
    }
    pendingText = text;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    chip.style.left = `${Math.min(Math.max(rect.left + rect.width / 2 - 34, 8), innerWidth - 90)}px`;
    chip.style.top = `${Math.max(rect.top - 36, 8)}px`;
    chip.hidden = false;
  });
  chip.addEventListener('click', async () => {
    chip.hidden = true;
    const content = pendingText;
    if (!content) return;
    try {
      if (!state.demo) await api('POST', '/api/memories', { content });
      addCell('memory', content, content, { lit: true, born: true });
      toast('⬡ kept — a new cell joined the field');
      document.getSelection()?.removeAllRanges();
    } catch (error) {
      toast(`could not keep: ${error.message}`);
    }
  });
})();

/* ================= live brain ================= */
async function bootLive() {
  const statusPayload = await api('GET', '/api/status');
  $('#brain-name').textContent = statusPayload.name || 'Sovereign AI';
  $('#mode-badge').textContent = `live · v${statusPayload.version}`;
  document.title = `XBrain — ${statusPayload.name || 'SovereignAI'}`;

  state.personas = await api('GET', '/api/personas').catch(() => []);
  renderPersonas();

  const memories = await api('GET', '/api/memories').catch(() => []);
  const documents = await api('GET', '/api/documents').catch(() => []);
  for (const memory of memories.slice(0, FIELD_LIMIT / 2)) {
    addCell('memory', memory.content, memory.content, { id: memory.id });
  }
  for (const doc of documents.slice(0, FIELD_LIMIT / 2)) {
    const docName = doc.name || doc.title || 'document';
    addCell('document', docName, `${docName} — knowledge base document`, { id: doc.id });
  }
}
function renderPersonas() {
  const holder = $('#persona-chips');
  holder.innerHTML = '';
  for (const persona of state.personas.slice(0, 4)) {
    const chip = document.createElement('button');
    chip.className = 'persona-chip';
    chip.type = 'button';
    chip.textContent = persona.name;
    chip.setAttribute('aria-pressed', String(persona.id === state.personaId));
    chip.addEventListener('click', () => {
      state.personaId = persona.id === state.personaId ? null : persona.id;
      state.conversationId = null; // persona switch starts a fresh thread
      renderPersonas();
    });
    holder.appendChild(chip);
  }
}

async function askLive(question, exchange) {
  const started = performance.now();
  let firstToken = null;
  let text = '';
  let meta = null;
  let usage = null;
  let streamError = null;
  state.abort = new AbortController();

  const waitTimer = setInterval(() => {
    if (firstToken === null) status(`<span class="pulse">recalling…</span> ${Math.round(performance.now() - started)} ms`);
  }, 90);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...HEADERS() },
      signal: state.abort.signal,
      body: JSON.stringify({ message: question, conversationId: state.conversationId, personaId: state.personaId }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || response.statusText);
    }
    const voice = exchange.querySelector('.voice');
    for await (const packet of sseIterate(response.body)) {
      if (packet.event === 'meta') {
        meta = packet.data;
        state.conversationId = meta.conversationId;
        const docIds = new Set((meta.sources || []).map((s) => s.documentId));
        const memoryIds = new Set((meta.memories || []).map((m) => m.id));
        const hits = ignite((cell) =>
          (cell.kind === 'document' && docIds.has(cell.id)) ||
          (cell.kind === 'memory' && memoryIds.has(cell.id)), exchange);
        if (hits) status(`<span class="pulse">${hits} cell${hits === 1 ? '' : 's'} ignited</span> · composing…`);
      } else if (packet.event === 'delta') {
        if (firstToken === null) {
          firstToken = performance.now() - started;
          status(`first token in ${Math.round(firstToken)} ms · streaming…`);
        }
        text += packet.data.text || '';
        voice.innerHTML = renderVoice(text) + '<span class="caret">▌</span>';
        $('#manuscript').scrollTop = $('#manuscript').scrollHeight;
      } else if (packet.event === 'done') {
        usage = packet.data.usage || null;
      } else if (packet.event === 'error') {
        streamError = packet.data.message || 'the model request failed';
      }
    }
  } finally {
    clearInterval(waitTimer);
  }
  if (!text) throw new Error(streamError || 'the model returned an empty response');
  finishExchange(exchange, {
    text,
    sources: meta?.sources || [],
    memories: meta?.memories || [],
    trace: {
      persona: meta?.persona || 'default',
      model: meta ? `${meta.provider}/${meta.model || 'default'}` : 'unknown',
      'first token': firstToken === null ? '—' : `${Math.round(firstToken)} ms`,
      'total time': `${((performance.now() - started) / 1000).toFixed(1)} s`,
      tokens: usage && usage.input_tokens != null ? `${usage.input_tokens} in · ${usage.output_tokens ?? '?'} out` : 'not reported',
      ...(streamError ? { interrupted: streamError } : {}),
    },
  });
}

/* ================= demo brain (artifact / no server) ================= */
const DEMO_CELLS = [
  ['memory', 'The studio lease renews every March — the renewals radar caught it from the inbox import.'],
  ['memory', 'Zero runtime dependencies is a product principle — sovereignty means an auditable supply chain.'],
  ['memory', 'Anthropic models are spoken to natively; never through an OpenAI-compat shim.'],
  ['memory', 'Memory writes must always be consented — nothing is learned about the user silently.'],
  ['memory', 'The terracotta hexagon is the brand mark; it appears wherever the product does.'],
  ['document', 'ARCHITECTURE.md — thirteen decision records, from zero-dep runtime to single binaries.'],
  ['document', 'FINE_TUNING.md — consent, holdout, lineage, and deployment gates for actual training.'],
  ['document', 'STORE_SUBMISSION.md — the last mile to every marketplace, accounts excluded.'],
  ['document', 'trainer protocol v1 — content-addressed blobs, idempotent jobs, attested artifacts.'],
  ['document', 'OPERATIONS.md — one stable home, portable exports, binaries that behave like installs.'],
  ['memory', 'The interface never fakes machinery: nothing glows that did not rank.'],
  ['document', 'XBRAIN_DESIGN_BRIEF.md — the standing prompt: the cognition is the interface.'],
];
const DEMO_ANSWERS = [
  {
    match: /xbrain|interface|design|ux|field|this/i,
    text: 'You are inside the Mind Field — XBrain\'s third form.\n\nEvery hexagon drifting around this page is a **real thing I hold**: a memory you let me keep, a document you gave me. When you ask, the cells I truly reach for ignite and thread into the answer while it streams. The *recall* face shows the exact excerpts; *trace* shows what the answer cost, down to the first-token millisecond.\n\nNothing here is theatre: in the live product every glow is driven by genuine retrieval ids, and the silence when nothing ranks is shown honestly too.',
  },
  {
    match: /memory|remember|keep/i,
    text: 'My memory is not a log — it is a ledger of things you chose.\n\nSelect any phrase in this answer and press **⬡ keep**: you will watch a new cell being born into the field around you. In the live product that cell is a row in *your* SQLite file, auditable in the Memory Ledger, amendable, and strikable from the record forever.',
  },
  {
    match: /.*/,
    text: 'I am running in **demo mode** — no SovereignAI server is reachable from this page, so this field is a plausible fiction and my voice is scripted.\n\nRun `sovereign start` on your own machine and open `/xbrain.html`: the field becomes your actual memories and documents, ignition follows real retrieval, threads run to real answers, and the trace face reports your model, your latency, your tokens.',
  },
];
function bootDemo() {
  state.demo = true;
  $('#brain-name').textContent = 'Atlas';
  const badge = $('#mode-badge');
  badge.textContent = PUBLIC_DEMO_HOST ? 'demo — fictional data, no server behind this page' : 'demo — no server reachable';
  badge.classList.add('demo');
  if (PUBLIC_DEMO_HOST) {
    badge.insertAdjacentHTML('afterend', ' <a href="/playground" style="font-size:.72rem;margin-left:10px;color:inherit">⬡ playground</a>');
  }
  // Demo honesty: the resting copy promises real cells; in demo mode they are
  // staged, and the page must say so before a question is ever asked.
  const emptyMind = $('#empty-mind');
  const overclaim = emptyMind && emptyMind.querySelectorAll('p')[1];
  if (overclaim) {
    overclaim.innerHTML = 'In this demo the field is a <b>staged fiction</b> — twelve scripted cells standing in ' +
      'for the memories and documents a live instance holds. Ask something below: the cells the script recalls ' +
      'ignite and thread into the answer, exactly as real retrieval behaves after <code>sovereign start</code>.';
  }
  state.personas = [{ id: 'demo-atlas', name: 'Atlas' }, { id: 'demo-scribe', name: 'Scribe' }];
  renderPersonas();
  for (const [kind, body] of DEMO_CELLS) addCell(kind, body, body);
}
async function askDemo(question, exchange) {
  const started = performance.now();
  const voice = exchange.querySelector('.voice');
  const answer = DEMO_ANSWERS.find((a) => a.match.test(question));
  const words = question.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const relevant = field.cells.filter((cell) => words.some((w) => cell.body.toLowerCase().includes(w)));
  const chosen = (relevant.length ? relevant : [...field.cells].sort(() => Math.random() - 0.5)).slice(0, 3);
  await new Promise((resolve) => setTimeout(resolve, 420));
  ignite((cell) => chosen.includes(cell), exchange);
  status(`<span class="pulse">${chosen.length} cells ignited</span> · composing…`);
  let text = '';
  for (const token of answer.text.split(/(?<=\s)/)) {
    if (state.abort?.signal.aborted) break;
    text += token;
    voice.innerHTML = renderVoice(text) + '<span class="caret">▌</span>';
    $('#manuscript').scrollTop = $('#manuscript').scrollHeight;
    if (!REDUCED.matches) await new Promise((resolve) => setTimeout(resolve, 14));
  }
  finishExchange(exchange, {
    text,
    sources: chosen.filter((cell) => cell.kind === 'document')
      .map((cell, index) => ({ document: cell.label.split(' — ')[0], excerpt: cell.body, score: 0.91 - index * 0.17 })),
    memories: chosen.filter((cell) => cell.kind === 'memory').map((cell) => ({ excerpt: cell.body })),
    trace: {
      persona: state.personas.find((p) => p.id === state.personaId)?.name || 'Atlas',
      model: 'demo/scripted',
      'first token': '420 ms',
      'total time': `${((performance.now() - started) / 1000).toFixed(1)} s`,
      tokens: 'not a real model',
    },
  });
}

/* ================= stem wiring ================= */
async function ask() {
  const input = $('#stem-input');
  const question = input.value.trim();
  if (!question || state.streaming) return;
  input.value = '';
  autosize();
  state.streaming = true;
  state.abort = new AbortController();
  $('#send-btn').hidden = true;
  $('#stop-btn').hidden = false;
  $('#stem').classList.add('streaming');
  status('<span class="pulse">recalling…</span>');
  const exchange = addExchange(question);
  try {
    await (state.demo ? askDemo(question, exchange) : askLive(question, exchange));
    status('');
  } catch (error) {
    if (error.name === 'AbortError') {
      finishExchange(exchange, { text: '*generation stopped by you*', sources: [], trace: { stopped: 'by you' } });
      status('stopped');
    } else {
      finishExchange(exchange, { text: `I could not complete that: ${error.message}`, sources: [], trace: { failed: error.message } });
      status(esc(error.message), true);
    }
  } finally {
    state.streaming = false;
    state.abort = null;
    $('#send-btn').hidden = false;
    $('#stop-btn').hidden = true;
    $('#stem').classList.remove('streaming');
  }
}
function autosize() {
  const input = $('#stem-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
}
$('#stem-input').addEventListener('input', autosize);
$('#stem-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); ask(); }
});
$('#send-btn').addEventListener('click', ask);
$('#stop-btn').addEventListener('click', () => state.abort?.abort());
$('#fresh-btn').addEventListener('click', () => {
  state.conversationId = null;
  field.extinguish();
  toast('fresh session — the field remembers, the thread does not');
});
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== $('#stem-input')) { event.preventDefault(); $('#stem-input').focus(); }
  if (event.key === 'Escape' && state.streaming) state.abort?.abort();
});

/* ================= boot ================= */
field.init();
(async () => {
  try {
    await bootLive();
  } catch {
    bootDemo();
  }
  updateLegend();
  $('#stem-input').focus();
})();
