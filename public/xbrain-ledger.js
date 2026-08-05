'use strict';
const HEADERS = (() => {
  let token = '';
  try {
    const url = new URL(location.href);
    if (url.hash.startsWith('#token=')) {
      try { token = decodeURIComponent(url.hash.slice(7)); } catch { token = url.hash.slice(7); }
      try { localStorage.setItem('sovereign-token', token); } catch { /* private session */ }
      try { url.hash = ''; history.replaceState(null, '', url); } catch { /* fine */ }
    }
  } catch { /* fine */ }
  return () => {
    try { token = token || localStorage.getItem('sovereign-token') || ''; } catch { /* fine */ }
    return token ? { authorization: `Bearer ${token}` } : {};
  };
})();
const $ = (sel) => document.querySelector(sel);
const state = { demo: false, entries: [], filter: '' };

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

/* ---------- render ---------- */
function render() {
  const spine = $('#spine');
  const needle = state.filter.toLowerCase();
  const visible = state.entries.filter((entry) => !needle || entry.content.toLowerCase().includes(needle));
  $('#count').textContent = needle
    ? `${visible.length} of ${state.entries.length} lines`
    : `${state.entries.length} ${state.entries.length === 1 ? 'line' : 'lines'} held`;

  if (!state.entries.length) {
    spine.innerHTML = `<div class="empty-ledger"><span class="hex">⬡</span> The ledger is empty.
      That is not a failure state — it is a promise kept. When you or your AI keep a memory,
      it becomes a line here: visible, amendable, revocable.</div>`;
    return;
  }
  if (!visible.length) {
    spine.innerHTML = `<div class="empty-ledger">No line matches that search.</div>`;
    return;
  }
  spine.innerHTML = '';
  for (const entry of visible) spine.appendChild(renderEntry(entry));
}
function renderEntry(entry) {
  const node = document.createElement('article');
  node.className = 'entry';
  node.dataset.id = entry.id;
  const created = entry.created_at ? new Date(entry.created_at) : null;
  node.innerHTML = `
    <span class="seal${entry.born ? ' born' : ''}" aria-hidden="true"></span>
    <p class="content"></p>
    <div class="provenance">
      <span>inscribed ${created ? created.toISOString().slice(0, 10) : 'unknown'}</span>
      <span>№ ${esc(String(entry.id).slice(0, 8))}</span>
      <button class="act amend" type="button">amend</button>
      <button class="act revoke" type="button">strike from the record</button>
    </div>`;
  node.querySelector('.content').textContent = entry.content;
  entry.born = false;
  node.querySelector('.amend').addEventListener('click', () => beginAmend(node, entry));
  node.querySelector('.revoke').addEventListener('click', () => confirmStrike(node, entry));
  return node;
}

/* ---------- acts ---------- */
async function inscribe() {
  const input = $('#inscribe-input');
  const content = input.value.trim();
  if (!content) return;
  if (content.length > 2000) { toast('a memory holds at most 2000 characters'); return; }
  $('#inscribe-btn').disabled = true;
  try {
    const saved = state.demo
      ? { id: `demo-${Date.now()}`, content, created_at: new Date().toISOString() }
      : await api('POST', '/api/memories', { content });
    state.entries.unshift({ ...saved, content: saved.content ?? content, born: true });
    input.value = '';
    autosize();
    render();
    toast('⬡ inscribed');
  } catch (error) {
    toast(`could not inscribe: ${error.message}`);
  } finally {
    $('#inscribe-btn').disabled = false;
  }
}
function beginAmend(node, entry) {
  const paragraph = node.querySelector('.content');
  const editor = document.createElement('textarea');
  editor.className = 'amend-input';
  editor.value = entry.content;
  editor.rows = Math.min(6, Math.max(2, Math.ceil(entry.content.length / 70)));
  editor.setAttribute('aria-label', 'Amend this memory');
  paragraph.replaceWith(editor);
  editor.focus();
  const finish = async (commit) => {
    const next = editor.value.trim();
    if (commit && next && next !== entry.content) {
      try {
        if (!state.demo) await api('PUT', `/api/memories/${encodeURIComponent(entry.id)}`, { content: next });
        entry.content = next;
        toast('⬡ amended');
      } catch (error) {
        toast(`could not amend: ${error.message}`);
      }
    }
    render();
  };
  editor.addEventListener('blur', () => finish(true), { once: true });
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); editor.blur(); }
    if (event.key === 'Escape') { editor.removeEventListener('blur', finish); finish(false); }
  });
}
function confirmStrike(node, entry) {
  const provenance = node.querySelector('.provenance');
  if (provenance.querySelector('.confirm-strike')) return;
  const confirmEl = document.createElement('span');
  confirmEl.className = 'confirm-strike';
  confirmEl.innerHTML = `strike permanently? <button type="button" data-yes>yes, strike</button> · <button type="button" data-no>keep</button>`;
  provenance.appendChild(confirmEl);
  confirmEl.querySelector('[data-no]').addEventListener('click', () => confirmEl.remove());
  confirmEl.querySelector('[data-yes]').addEventListener('click', async () => {
    confirmEl.remove();
    node.classList.add('struck');
    try {
      if (!state.demo) await api('DELETE', `/api/memories/${encodeURIComponent(entry.id)}`);
      setTimeout(() => {
        state.entries = state.entries.filter((candidate) => candidate.id !== entry.id);
        render();
      }, 650);
      toast('struck from the record');
    } catch (error) {
      node.classList.remove('struck');
      toast(`could not strike: ${error.message}`);
    }
  });
}

/* ---------- boot ---------- */
const DEMO_ENTRIES = [
  'The founder prefers autonomous execution; flag only strategic business calls.',
  'Zero runtime dependencies is a product principle — sovereignty means an auditable supply chain.',
  'Memory writes must always be consented — nothing is learned about the user silently.',
  'The terracotta hexagon is the brand mark; it appears wherever the product does.',
];
async function boot() {
  try {
    const memories = await api('GET', '/api/memories');
    const badgePayload = await api('GET', '/api/status').catch(() => null);
    $('#mode-badge').textContent = badgePayload ? `live · ${badgePayload.name}` : 'live';
    state.entries = memories
      .map((memory) => ({ ...memory }))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  } catch {
    state.demo = true;
    const badge = $('#mode-badge');
    badge.textContent = 'demo — no server reachable';
    badge.classList.add('demo');
    state.entries = DEMO_ENTRIES.map((content, index) => ({
      id: `demo-${index}`,
      content,
      created_at: new Date(Date.now() - index * 86_400_000).toISOString(),
    }));
  }
  render();
}
function autosize() {
  const input = $('#inscribe-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}
$('#inscribe-input').addEventListener('input', autosize);
$('#inscribe-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); inscribe(); }
});
$('#inscribe-btn').addEventListener('click', inscribe);
$('#filter-input').addEventListener('input', (event) => {
  state.filter = event.target.value.trim();
  render();
});
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== $('#inscribe-input') && document.activeElement !== $('#filter-input')) {
    event.preventDefault();
    $('#inscribe-input').focus();
  }
});
boot();
