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

/* ---------- the probe ---------- */
async function probe() {
  const query = $('#probe-input').value.trim();
  if (!query || state.probing) return;
  state.probing = true;
  $('#probe-btn').disabled = true;
  $('#probe-note').textContent = 'probing…';
  try {
    const results = state.demo ? demoProbe(query) : await api('GET', `/api/search?q=${encodeURIComponent(query)}`);
    const best = new Map(); // documentId → best result
    for (const result of results) {
      const current = best.get(result.documentId);
      if (!current || (result.score ?? 0) > (current.score ?? 0)) best.set(result.documentId, result);
    }
    for (const territory of state.territories) {
      const hit = best.get(territory.id);
      territory.el.classList.toggle('lit', Boolean(hit));
      territory.el.querySelector('.score').textContent = hit ? (hit.score ?? 0).toFixed(2) : '';
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
      const top = Math.max(...results.map((r) => r.score ?? 0), 0.0001);
      list.innerHTML = results.slice(0, 8).map((r) => `
        <div class="sounding">
          <span class="score-col">${(r.score ?? 0).toFixed(2)}<span class="score-bar"><i style="width:${Math.round(((r.score ?? 0) / top) * 100)}%"></i></span></span>
          <span><span class="doc">${esc(r.document || 'document')} <span class="method">${esc(r.method || '')}</span></span>
          <span class="excerpt">${esc(String(r.content || '').slice(0, 280))}</span></span>
        </div>`).join('');
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
function demoProbe(query) {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  return state.territories
    .map((territory) => {
      const hay = `${territory.name} ${territory.body || ''}`.toLowerCase();
      const hits = words.filter((w) => hay.includes(w)).length;
      return hits
        ? { documentId: territory.id, document: territory.name, content: `…${territory.body}…`, score: Math.min(0.97, hits / Math.max(words.length, 1)), method: 'demo' }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
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
