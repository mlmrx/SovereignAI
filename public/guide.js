'use strict';
/* ---------- shared plumbing (same contracts as every XBrain surface) ---------- */
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
async function api(path) {
  const response = await fetch(path, { headers: { ...HEADERS() } });
  const payload = (response.headers.get('content-type') || '').includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text();
  if (!response.ok) throw new Error((payload && payload.error) || response.statusText || `HTTP ${response.status}`);
  return payload;
}
function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}
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

/* ---------- the waypoints ----------
   Each check receives a live snapshot of the workspace and returns
   { reached, evidence }. `manual: true` waypoints are acts the API
   cannot observe; the traveler marks those, and the guide says so. */
const cmd = (text) => `<span class="copy-cmd"><code>${esc(text)}</code><button type="button" data-copy="${esc(text)}">copy</button></span>`;

const WAYPOINTS = [
  {
    id: 'claim',
    name: 'Claim your instance',
    why: 'Sovereignty starts with possession: one process, on your hardware, holding one home directory that is entirely yours.',
    steps: `<li>Start it: ${cmd('sovereign start')} (or ${cmd('node bin/sovereign.js start')} from source, or the single binary from Releases).</li>
      <li>Open the printed URL and finish the <b>setup wizard</b>: name your AI, pick its brain, shape its personality.</li>
      <li>Meet <a href="/#/home">the command center</a> — provider readiness, workspace counts, and every workflow in one place.</li>`,
    check: (s) => ({
      reached: Boolean(s.status?.setupComplete),
      evidence: s.status?.setupComplete
        ? `this instance answers as “${esc(s.status.name)}” (v${esc(s.status.version)}) — claimed`
        : 'the setup wizard has not been completed yet',
    }),
  },
  {
    id: 'first-words',
    name: 'First words',
    why: 'A conversation here is not a session on someone\'s server — it is a row in your own database, inspectable and deletable.',
    steps: `<li>Open <a href="/#/chat">chat</a> and ask anything.</li>
      <li>Notice the context banner: persona, model, and whether your words leave this machine (a local Ollama model means they don't).</li>
      <li>Stop a generation mid-stream once — the stop button is a right, not a decoration.</li>`,
    check: (s) => ({
      reached: (s.status?.counts?.conversations ?? 0) > 0,
      evidence: `your workspace holds ${s.status?.counts?.conversations ?? 0} conversation(s)`,
    }),
  },
  {
    id: 'knowledge',
    name: 'Feed it knowledge',
    why: 'Your AI should know your world. Ingestion runs entirely on this machine — even the PDF and DOCX parsers are dependency-free.',
    steps: `<li>Open <a href="/#/knowledge">knowledge</a> and drop in a TXT, Markdown, PDF, or DOCX file.</li>
      <li>Use the <b>retrieval preview</b> to search your index and see exactly what the model would receive.</li>
      <li>Then ask about the document in chat — the answer will cite its sources.</li>`,
    check: (s) => ({
      reached: (s.status?.counts?.documents ?? 0) > 0,
      evidence: `your knowledge base holds ${s.status?.counts?.documents ?? 0} document(s)`,
    }),
  },
  {
    id: 'memory',
    name: 'Teach it to remember',
    why: 'Memory here is a ledger of things you chose, never a profile built behind your back. Every note is visible, amendable, revocable.',
    steps: `<li>Open <a href="/#/memory">memory</a> and add a durable note about yourself or your work.</li>
      <li>Audit it any time in the <a href="/xbrain-ledger.html">Memory Ledger</a> — amend it, or strike it from the record.</li>
      <li>Automatic memory extraction exists but is <b>opt-in</b> in settings; nothing is learned silently.</li>`,
    check: (s) => ({
      reached: (s.status?.counts?.memories ?? 0) > 0,
      evidence: `the ledger holds ${s.status?.counts?.memories ?? 0} memory line(s)`,
    }),
  },
  {
    id: 'persona',
    name: 'Shape a second self',
    why: 'One mind, many stances: a persona binds a system prompt, a model choice, and memory/knowledge switches into a stance you can summon per conversation.',
    steps: `<li>Three personas ship with the workspace — open <a href="/#/settings">settings → personas</a> and create your own.</li>
      <li>Give it a narrow job (“code reviewer”, “devil's advocate”) and switch personas mid-day, not mid-sentence.</li>`,
    check: (s) => ({
      reached: (s.status?.counts?.personas ?? 0) > 3,
      evidence: (s.status?.counts?.personas ?? 0) > 3
        ? `${s.status.counts.personas} personas — at least one is yours, not seeded`
        : `${s.status?.counts?.personas ?? 0} persona(s) — the three seeded ones don't count as yours`,
    }),
  },
  {
    id: 'mindfield',
    name: 'Enter the Mind Field',
    why: 'XBrain is the honest interface: every hexagon is a real memory or document, and the cells your AI truly recalls ignite and thread into the answer.',
    steps: `<li>Open the <a href="/xbrain.html" data-visit="mindfield">Mind Field</a> and ask something about a document you fed it — watch the recall.</li>
      <li>Flip an answer's three faces: <b>voice</b>, <b>recall</b>, <b>trace</b>.</li>
      <li>Select a phrase in an answer and press <b>⬡ keep</b> — you'll watch the memory being born.</li>
      <li>Probe your terrain in the <a href="/xbrain-atlas.html" data-visit="mindfield">Knowledge Atlas</a> before asking anything.</li>`,
    manual: true,
    manualLabel: 'clicking either XBrain link marks this waypoint',
  },
  {
    id: 'semantic',
    name: 'Upgrade to semantic search',
    why: 'Keyword search always works, fully offline. Add a local embedding model and retrieval silently upgrades to meaning, not just words.',
    steps: `<li>Pull the embedding model: ${cmd('ollama pull nomic-embed-text')}</li>
      <li>New documents embed automatically; re-upload older ones to embed them.</li>
      <li>${cmd('sovereign doctor')} confirms the model is visible.</li>`,
    check: (s) => {
      const wanted = (s.config?.embeddings?.model || 'nomic-embed-text').toLowerCase();
      const models = s.ollamaModels?.map((m) => String(m.id).toLowerCase()) ?? [];
      const found = models.some((id) => id.startsWith(wanted));
      return {
        reached: found,
        evidence: found ? `“${esc(wanted)}” is available on your Ollama endpoint` : `“${esc(wanted)}” is not on your Ollama endpoint yet`,
      };
    },
  },
  {
    id: 'artifact',
    name: 'Forge a named model',
    why: 'Model Studio turns your AI\'s character into a portable recipe and a named Ollama artifact — data you own, not a setting you rent.',
    steps: `<li>Open <b>Model Studio</b> from the <a href="/#/home">command center</a>.</li>
      <li>Save a recipe: base model, system prompt, parameters, license.</li>
      <li>Build it — your Ollama endpoint gains a named artifact (e.g. <code>atlas:latest</code>) usable even without SovereignAI. No training happens; that honesty is a feature.</li>`,
    check: (s) => ({
      reached: (s.recipes?.length ?? 0) > 0,
      evidence: `Model Studio holds ${s.recipes?.length ?? 0} recipe(s)`,
    }),
  },
  {
    id: 'export',
    name: 'Hold your own backup',
    why: 'Ownership you can\'t carry away is a promise, not a fact. One JSON file holds every persona, conversation, memory, document, recipe, and training record.',
    steps: `<li>Run ${cmd('sovereign export')} — or use the export button in <a href="/#/settings">settings</a>.</li>
      <li>Open the file. Read it. That readability is the point.</li>
      <li>Secrets are deliberately excluded — a backup must never smuggle credentials.</li>`,
    manual: true,
    manualLabel: 'the API cannot see your filesystem — mark it when your backup exists',
  },
  {
    id: 'everywhere',
    name: 'Go everywhere',
    why: 'Your AI shouldn\'t live in one tab. The same workspace answers in your editor, your browser, other AI tools — and can leave as a single file.',
    steps: `<li>MCP for Claude/Codex/Cursor/Gemini CLI: ${cmd('sovereign mcp')}</li>
      <li>Health check any time: ${cmd('sovereign doctor')}</li>
      <li>Share on your LAN or tailnet behind a token: ${cmd('sovereign start --lan')}</li>
      <li>Or carry the whole thing as one file: grab the single binary from Releases — runtime, app, and UI inside.</li>
      <li>When you're ready for actual weight training, read the Fine-Tuning Studio's consent-gated workflow in <a href="/#/finetune">finetune</a>.</li>`,
    manual: true,
    manualLabel: 'these live outside the browser — mark it when you\'ve tried one',
  },
];

/* ---------- state ---------- */
const state = { demo: false, snapshot: null, manual: {}, visited: {} };
try { state.manual = JSON.parse(localStorage.getItem('sovereign-path') || '{}'); } catch { /* fresh path */ }

function isReached(waypoint) {
  if (waypoint.manual) return Boolean(state.manual[waypoint.id]);
  if (!state.snapshot) return false;
  try { return waypoint.check(state.snapshot).reached; } catch { return false; }
}
function evidenceOf(waypoint) {
  if (waypoint.manual) {
    return state.manual[waypoint.id] ? 'marked by you — the guide takes your word' : waypoint.manualLabel;
  }
  if (!state.snapshot) return 'no workspace reachable — evidence unavailable';
  try { return waypoint.check(state.snapshot).evidence; } catch { return 'check failed'; }
}

/* ---------- render ---------- */
function render() {
  const pathbar = $('#pathbar');
  pathbar.innerHTML = '';
  let reachedCount = 0;
  WAYPOINTS.forEach((waypoint, index) => {
    const reached = isReached(waypoint);
    if (reached) reachedCount++;
    if (index > 0) {
      const tie = document.createElement('span');
      tie.className = `tie${reached && isReached(WAYPOINTS[index - 1]) ? ' reached' : ''}`;
      pathbar.appendChild(tie);
    }
    const hex = document.createElement('button');
    hex.type = 'button';
    hex.className = `wp-hex${reached ? ' reached' : ''}`;
    hex.setAttribute('role', 'listitem');
    hex.setAttribute('aria-label', `Waypoint ${index + 1}: ${waypoint.name} — ${reached ? 'reached' : 'not yet reached'}`);
    hex.addEventListener('click', () => {
      const node = document.getElementById(`wp-${waypoint.id}`);
      node.open = true;
      node.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
    pathbar.appendChild(hex);
  });
  $('#count-text').innerHTML = `<b>${reachedCount}</b> of ${WAYPOINTS.length} waypoints reached${state.demo ? ' · demo workspace' : ''}`;

  const holder = $('#waypoints');
  for (const waypoint of WAYPOINTS) {
    let node = document.getElementById(`wp-${waypoint.id}`);
    if (!node) {
      node = document.createElement('details');
      node.className = 'waypoint';
      node.id = `wp-${waypoint.id}`;
      node.innerHTML = `
        <summary>
          <span class="wp-mark" aria-hidden="true">⬡</span>
          <span class="wp-name"></span>
          <span class="wp-state"></span>
        </summary>
        <div class="wp-body">
          <p class="wp-why"></p>
          <ol class="wp-steps"></ol>
          <div class="wp-evidence"></div>
        </div>`;
      node.querySelector('.wp-name').textContent = `${WAYPOINTS.indexOf(waypoint) + 1}. ${waypoint.name}`;
      node.querySelector('.wp-why').textContent = waypoint.why;
      node.querySelector('.wp-steps').innerHTML = waypoint.steps;
      holder.appendChild(node);
    }
    const reached = isReached(waypoint);
    node.dataset.reached = String(reached);
    node.querySelector('.wp-mark').textContent = reached ? '⬢' : '⬡';
    node.querySelector('.wp-state').textContent = reached ? 'reached' : 'not yet';
    const evidence = node.querySelector('.wp-evidence');
    evidence.innerHTML = `
      <span class="verdict ${reached ? 'ok' : 'no'}">${reached ? '⬢ reached' : '⬡ not yet'}</span>
      <span>${evidenceOf(waypoint)}</span>
      ${waypoint.manual ? `<button class="mark-btn" type="button">${state.manual[waypoint.id] ? 'unmark' : 'mark as done'}</button>` : ''}`;
    evidence.querySelector('.mark-btn')?.addEventListener('click', () => {
      state.manual[waypoint.id] = !state.manual[waypoint.id];
      try { localStorage.setItem('sovereign-path', JSON.stringify(state.manual)); } catch { /* fine */ }
      render();
    });
  }
}

/* clicking an XBrain link is itself the evidence for the mindfield waypoint */
document.addEventListener('click', (event) => {
  const visit = event.target.closest('[data-visit]');
  if (visit && !state.manual[visit.dataset.visit]) {
    state.manual[visit.dataset.visit] = true;
    try { localStorage.setItem('sovereign-path', JSON.stringify(state.manual)); } catch { /* fine */ }
  }
  const copy = event.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard?.writeText(copy.dataset.copy).then(() => toast('copied')).catch(() => toast('could not copy'));
  }
});

/* ---------- the survey: one live snapshot, every check against it ---------- */
async function survey({ quiet = false } = {}) {
  const btn = $('#survey-btn');
  btn.disabled = true;
  try {
    const status = await api('/api/status');
    const [config, recipes, models] = await Promise.all([
      api('/api/config').catch(() => null),
      api('/api/model-recipes').catch(() => []),
      api('/api/models?provider=ollama').catch(() => null),
    ]);
    state.snapshot = { status, config, recipes, ollamaModels: models?.models ?? [] };
    state.demo = false;
    $('#mode-badge').textContent = `live · ${status.name}`;
    $('#mode-badge').classList.remove('demo');
    if (!quiet) toast('⬡ workspace surveyed');
  } catch {
    if (!state.snapshot) bootDemo();
    if (!quiet) toast('no live workspace reachable');
  } finally {
    btn.disabled = false;
    render();
  }
}
function bootDemo() {
  state.demo = true;
  const badge = $('#mode-badge');
  badge.textContent = PUBLIC_DEMO_HOST ? 'demo — fictional data, no server behind this page' : 'demo — no server reachable';
  badge.classList.add('demo');
  if (PUBLIC_DEMO_HOST && !document.querySelector('a[href="/playground"]')) {
    badge.insertAdjacentHTML('afterend', ' <a href="/playground" style="font-size:.72rem;margin-left:10px;color:inherit">⬡ playground</a>');
  }
  state.snapshot = {
    status: { name: 'Atlas', version: '0.3.0', setupComplete: true, counts: { conversations: 6, documents: 3, memories: 1, personas: 4 } },
    config: { embeddings: { model: 'nomic-embed-text' } },
    recipes: [],
    ollamaModels: [{ id: 'llama3.1:latest' }, { id: 'moondream:latest' }],
  };
}
$('#survey-btn').addEventListener('click', () => survey());
survey({ quiet: true });
