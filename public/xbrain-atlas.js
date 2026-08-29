'use strict';
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
const state = { demo: false, territories: [], probing: false };

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function api(method, path, body) {
  const headers = { ...HEADERS() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = (response.headers.get('content-type') || '').includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text();
  if (!response.ok) throw new Error((payload && payload.error) || response.statusText || `HTTP ${response.status}`);
  return payload;
}
let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* theme */
(() => {
  const order = ['auto', 'dark', 'light'];
  let current = 'auto';
  try { current = localStorage.getItem('xbrain-theme') || 'auto'; } catch { /* fine */ }
  const apply = () => {
    if (current === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = current;
    $('#theme-btn').textContent = `theme: ${current}`;
  };
  $('#theme-btn').addEventListener('click', () => {
    current = order[(order.indexOf(current) + 1) % order.length];
    try { localStorage.setItem('xbrain-theme', current); } catch { /* fine */ }
    apply();
  });
  apply();
})();

/* ---------- terrain ---------- */
function sizeOf(chunkCount) {
  if (chunkCount >= 6) return 'l';
  if (chunkCount >= 2) return 'm';
  return 's';
}
function renderTerrain() {
  const terrain = $('#terrain');
  if (!state.territories.length) {
    terrain.innerHTML = `<div class="empty-terrain"><span class="hex">⬡</span> No terrain yet.
      Feed your AI a document — TXT, Markdown, PDF, DOCX — and this page becomes a map of
      what it can see. Ingestion runs entirely on your machine.</div>`;
    return;
  }
  terrain.innerHTML = '';
  for (const territory of state.territories) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'territory';
    node.dataset.size = sizeOf(territory.chunk_count ?? 1);
    node.dataset.id = territory.id;
    node.setAttribute('aria-label', `Document: ${territory.name}`);
    node.innerHTML = `<span class="land"><span class="score"></span></span><span class="name"></span>`;
    node.querySelector('.name').textContent = territory.name;
    node.addEventListener('click', () => survey(territory));
    territory.el = node;
    terrain.appendChild(node);
  }
}
function extinguish() {
  for (const territory of state.territories) {
    territory.el?.classList.remove('lit');
    const scoreEl = territory.el?.querySelector('.score');
    if (scoreEl) scoreEl.textContent = '';
  }
  $('#soundings').hidden = true;
  $('#probe-note').textContent = 'no probe sent — the terrain rests dark';
}

/**
 * A probe ends in the passage that answered it, not in a ranked directory of
 * eight (ADR-27). The server already does the finding — it returns results in
 * rank order, each carrying the `focus` window that holds the answer and the
 * query `terms` it covers — and the Atlas was throwing all of that away to
 * print a score column beside the first 280 characters of a chunk.
 *
 * The deepest sounding is read first, whole. The rest stay as soundings,
 * because on a map the second reading still matters — just quietly.
 */
function markTerms(text, terms) {
  const safe = esc(String(text ?? ''));
  if (!Array.isArray(terms) || !terms.length) return safe;
  // Escape first, then mark: no markup from a document ever reaches the DOM.
  const pattern = terms
    .filter((term) => typeof term === 'string' && term.length >= 3)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
    .join('|');
  if (!pattern) return safe;
  return safe.replace(new RegExp(`\\b(${pattern}\\w*)`, 'gi'), '<mark>$1</mark>');
}

// How deep a sounding reads: the server's rank when it sent one, the older
// score otherwise. One function so the hexagons, the ordering and the numbers
// beside the soundings can never disagree about the same result.
function depthOf(result) {
  return Number.isFinite(result?.rank) ? result.rank : (result?.score ?? 0);
}

function renderSoundings(list, results, query) {
  const [best, ...rest] = results;
  const deepest = Math.max(...results.map(depthOf), 0.0001);
  const passage = best.focus || String(best.content || '').slice(0, 280);
  const covered = Array.isArray(best.terms) && best.terms.length ? best.terms : null;
  const depth = (depthOf(best) / deepest).toFixed(2);
  const lead = `
    <div class="found">
      <p class="found-label">the deepest sounding</p>
      <p class="found-doc">${esc(best.document || 'document')}<span class="found-depth">depth ${esc(depth)}${covered ? ` · ${esc(covered.join(', '))}` : ''}</span></p>
      <blockquote class="found-quote">${markTerms(passage, best.terms)}</blockquote>
    </div>`;
  const also = rest.length
    ? `<p class="also-label">the terrain also answered</p>` +
      rest
        .slice(0, 7)
        .map(
          (r) => `
        <div class="sounding">
          <span class="score-col">${(depthOf(r) / deepest).toFixed(2)}</span>
          <span><span class="doc">${esc(r.document || 'document')} <span class="method">${esc(r.method || '')}</span></span>
          <span class="excerpt">${markTerms(r.focus || String(r.content || '').slice(0, 220), r.terms)}</span></span>
        </div>`
        )
        .join('')
    : `<p class="also-label">nothing else in the terrain answered “${esc(query)}”</p>`;
  list.innerHTML = lead + also;
}

/* ---------- the probe ---------- */
async function probe() {
  const query = $('#probe-input').value.trim();
  if (!query || state.probing) return;
  state.probing = true;
  $('#probe-btn').disabled = true;
  $('#probe-note').textContent = 'probing…';
  try {
    const results = state.demo ? demoProbe(query) : await api('GET', `/api/search?q=${encodeURIComponent(query)}`);
    // Rank, not score: since ADR-27 retrieval orders by how much of the query
    // a passage actually covers, and the map claims to show the ordering the
    // AI uses. Lighting by score contradicted the order of the soundings
    // directly beneath it — the best find could read lower than a runner-up.
    const best = new Map(); // documentId → best result
    for (const result of results) {
      const current = best.get(result.documentId);
      if (!current || depthOf(result) > depthOf(current)) best.set(result.documentId, result);
    }
    // Shown relative to whichever answered best: rank is a sum of signals with
    // no natural ceiling, and "2.01" on a hexagon means nothing to anyone.
    const deepest = Math.max(...results.map(depthOf), 0.0001);
    for (const territory of state.territories) {
      const hit = best.get(territory.id);
      territory.el.classList.toggle('lit', Boolean(hit));
      const cell = territory.el.querySelector('.score');
      cell.textContent = hit ? (depthOf(hit) / deepest).toFixed(2) : '';
      if (hit) cell.title = `rank ${depthOf(hit).toFixed(2)} · ${Math.round((hit.coverage ?? 0) * 100)}% of your terms`;
    }
    const note = $('#probe-note');
    note.innerHTML = results.length
      ? `<b>${best.size}</b> of ${state.territories.length} territories answered “${esc(query)}” · <button class="clear" type="button" data-clear>rest the terrain</button>`
      : `nothing in the terrain answers “${esc(query)}” — that silence is honest · <button class="clear" type="button" data-clear>rest the terrain</button>`;
    note.querySelector('[data-clear]')?.addEventListener('click', extinguish);

    const soundings = $('#soundings');
    const list = $('#sounding-list');
    soundings.hidden = false;
    if (results.length) {
      renderSoundings(list, results, query);
    } else {
      list.innerHTML = '<span class="none">No chunks ranked for this probe. Your AI would answer from the model and persona alone.</span>';
    }
  } catch (error) {
    toast(`probe failed: ${error.message}`);
    $('#probe-note').textContent = 'probe failed';
  } finally {
    state.probing = false;
    $('#probe-btn').disabled = false;
  }
}

/* ---------- survey ---------- */
function survey(territory) {
  const panel = $('#survey');
  const created = territory.created_at ? new Date(territory.created_at).toISOString().slice(0, 10) : 'unknown';
  panel.innerHTML = `
    <span class="kind">territory survey</span>
    <p class="title">${esc(territory.name)}</p>
    <dl>
      <dt>chunks</dt><dd>${territory.chunk_count ?? '?'}</dd>
      <dt>embedded</dt><dd>${territory.embedded ?? 0} of ${territory.chunk_count ?? '?'}</dd>
      <dt>size</dt><dd>${territory.size ?? '?'} bytes</dd>
      <dt>charted</dt><dd>${created}</dd>
      <dt>№</dt><dd>${esc(String(territory.id).slice(0, 8))}</dd>
    </dl>
    <div class="acts">
      <a href="/xbrain.html">ask about it in dialogue</a>
      <button class="retire" type="button">retire this territory</button>
      <button class="close-survey" type="button">close</button>
    </div>`;
  panel.hidden = false;
  panel.querySelector('.close-survey').addEventListener('click', () => { panel.hidden = true; });
  panel.querySelector('.retire').addEventListener('click', () => {
    const acts = panel.querySelector('.acts');
    if (acts.querySelector('.confirm-retire')) return;
    const confirmEl = document.createElement('span');
    confirmEl.className = 'confirm-retire';
    confirmEl.innerHTML = `remove document and its chunks? <button type="button" data-yes>yes, retire</button>`;
    acts.appendChild(confirmEl);
    confirmEl.querySelector('[data-yes]').addEventListener('click', async () => {
      try {
        if (!state.demo) await api('DELETE', `/api/documents/${encodeURIComponent(territory.id)}`);
        state.territories = state.territories.filter((candidate) => candidate.id !== territory.id);
        panel.hidden = true;
        renderTerrain();
        toast('territory retired');
      } catch (error) {
        toast(`could not retire: ${error.message}`);
      }
    });
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') $('#survey').hidden = true;
  if (event.key === '/' && document.activeElement !== $('#probe-input')) {
    event.preventDefault();
    $('#probe-input').focus();
  }
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('#survey') && !event.target.closest('.territory')) $('#survey').hidden = true;
});

/* ---------- boot / demo ---------- */
const DEMO_TERRITORIES = [
  { name: 'ARCHITECTURE.md', chunk_count: 7, body: 'decision records zero-dep runtime single binaries providers retrieval' },
  { name: 'FINE_TUNING.md', chunk_count: 6, body: 'consent holdout lineage deployment gates lora qlora trainer' },
  { name: 'trainer-protocol.md', chunk_count: 4, body: 'content-addressed blobs idempotent jobs attested artifacts ollama' },
  { name: 'OPERATIONS.md', chunk_count: 3, body: 'stable home portable exports binaries docker state' },
  { name: 'STORE_SUBMISSION.md', chunk_count: 2, body: 'marketplace listings icons chrome firefox jetbrains' },
  { name: 'meeting-notes.txt', chunk_count: 1, body: 'roadmap priorities founder decisions launch' },
];
// The demo answers in the SHAPE the real route returns — rank, coverage,
// terms and a focus window included. A fixture that drops fields the UI reads
// is a screen that only breaks in public, which is how issue #3 happened.
function demoProbe(query) {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  return state.territories
    .map((territory) => {
      const body = territory.body || '';
      const hay = `${territory.name} ${body}`.toLowerCase();
      const terms = words.filter((w) => hay.includes(w));
      if (!terms.length) return null;
      const score = Math.min(0.97, terms.length / Math.max(words.length, 1));
      const coverage = Number((terms.length / Math.max(words.length, 1)).toFixed(2));
      // The sentence that carries the most of what was asked, as the server does.
      const sentences = body.split(/(?<=[.!?])\s+/).filter(Boolean);
      const focus =
        sentences
          .map((sentence) => ({ sentence, hits: terms.filter((t) => sentence.toLowerCase().includes(t)).length }))
          .sort((a, b) => b.hits - a.hits)[0]?.sentence || body.slice(0, 240);
      return { documentId: territory.id, document: territory.name, content: `…${body}…`, score, method: 'demo', rank: Number((coverage + score).toFixed(4)), coverage, terms, focus };
    })
    .filter(Boolean)
    .sort((a, b) => b.rank - a.rank);
}
async function boot() {
  try {
    const documents = await api('GET', '/api/documents');
    const statusPayload = await api('GET', '/api/status').catch(() => null);
    $('#mode-badge').textContent = statusPayload ? `live · ${statusPayload.name}` : 'live';
    state.territories = documents.map((doc) => ({ ...doc }));
  } catch {
    state.demo = true;
    const badge = $('#mode-badge');
    badge.textContent = PUBLIC_DEMO_HOST ? 'demo — fictional data, no server behind this page' : 'demo — no server reachable';
    badge.classList.add('demo');
    if (PUBLIC_DEMO_HOST) {
      badge.insertAdjacentHTML('afterend', ' <a href="/playground" style="font-size:.72rem;margin-left:10px;color:inherit">⬡ playground</a>');
    }
    state.territories = DEMO_TERRITORIES.map((territory, index) => ({
      ...territory,
      id: `demo-${index}`,
      size: territory.chunk_count * 1800,
      embedded: 0,
      created_at: new Date(Date.now() - index * 86_400_000).toISOString(),
    }));
  }
  renderTerrain();
}
$('#probe-btn').addEventListener('click', probe);
$('#probe-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); probe(); }
});
boot();
