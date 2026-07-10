/* SovereignAI web UI — no framework, no build step, no telemetry. */

const $ = (sel) => document.querySelector(sel);
const state = {
  conversationId: null,
  personas: [],
  streaming: false,
};

/* Remote access (LAN/tailnet/Docker): accept ?token=… once, persist it, send it always. */
window.SOVEREIGN_HEADERS = (() => {
  try {
    const url = new URL(location.href);
    const fromUrl = url.searchParams.get('token');
    if (fromUrl) {
      localStorage.setItem('sovereign-token', fromUrl);
      url.searchParams.delete('token');
      history.replaceState(null, '', url);
    }
  } catch { /* ignore */ }
  const token = localStorage.getItem('sovereign-token');
  return () => (token ? { authorization: `Bearer ${token}` } : {});
})();

const api = {
  async get(path) {
    const res = await fetch(path, { headers: SOVEREIGN_HEADERS() });
    if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
    return res.json();
  },
  async send(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...SOVEREIGN_HEADERS() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
    return res.json();
  },
};

/* ---------- markdown-lite rendering (safe: escapes first) ---------- */
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function renderMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code data-lang="${lang}">${code}</code></pre>`);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;:!?])/g, '$1<em>$2</em>');
  html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // paragraphs & line breaks (outside pre blocks is close enough for chat)
  html = html
    .split(/\n{2,}/)
    .map((p) => (p.startsWith('<pre>') ? p : `<p>${p.replace(/\n/g, '<br/>')}</p>`))
    .join('');
  return html;
}

/* ---------- views ---------- */
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $(`#view-${name}`).classList.add('active');
  if (name === 'knowledge') loadDocuments();
  if (name === 'memory') loadMemories();
  if (name === 'settings') loadSettings();
}

/* ---------- chat ---------- */
const messagesEl = $('#messages');
const inputEl = $('#input');

function addBubble(role, html, meta) {
  $('#chat-empty')?.remove();
  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;
  wrap.innerHTML = `
    <div class="avatar">${role === 'user' ? '🜁' : '⬡'}</div>
    <div class="bubble">${html}${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ''}</div>`;
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap.querySelector('.bubble');
}

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || state.streaming) return;
  inputEl.value = '';
  autoGrow();
  addBubble('user', renderMarkdown(text));
  const bubble = addBubble('assistant', '<span class="cursor"></span>');
  state.streaming = true;
  $('#send').disabled = true;

  let acc = '';
  let meta = null;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...SOVEREIGN_HEADERS() },
      body: JSON.stringify({
        message: text,
        conversationId: state.conversationId,
        personaId: $('#persona-select').value || undefined,
      }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);

    for await (const { event, data } of sseIterate(res.body)) {
      if (event === 'meta') {
        meta = data;
        state.conversationId = data.conversationId;
        $('#chat-model').textContent = `${data.persona} · ${data.provider}/${data.model || 'default'}`;
      } else if (event === 'delta') {
        acc += data.text;
        bubble.innerHTML = renderMarkdown(acc) + '<span class="cursor"></span>';
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else if (event === 'error') {
        acc += acc ? '' : `⚠️ ${data.message}`;
        break;
      } else if (event === 'done') {
        const bits = [];
        if (data.usage?.input_tokens != null) bits.push(`${data.usage.input_tokens}→${data.usage.output_tokens ?? '?'} tok`);
        if (meta?.sources?.length) bits.push(`${meta.sources.length} source${meta.sources.length > 1 ? 's' : ''}`);
        bubble.innerHTML = renderMarkdown(acc) + (bits.length ? `<div class="meta">${bits.join(' · ')}</div>` : '');
      }
    }
    bubble.querySelector('.cursor')?.remove();
    if (!bubble.innerHTML.trim()) bubble.innerHTML = renderMarkdown(acc || '⚠️ No response');
  } catch (err) {
    bubble.innerHTML = `⚠️ ${escapeHtml(err.message)}`;
  } finally {
    state.streaming = false;
    $('#send').disabled = false;
    loadConversations();
  }
}

/** Parse an SSE byte stream into { event, data } objects. */
async function* sseIterate(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length) {
        try {
          yield { event, data: JSON.parse(dataLines.join('\n')) };
        } catch { /* skip malformed */ }
      }
    }
  }
}

$('#send').addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
inputEl.addEventListener('input', autoGrow);
function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
}

$('#new-chat').addEventListener('click', () => {
  state.conversationId = null;
  messagesEl.innerHTML = '';
  addBubbleEmpty();
  showView('chat');
  loadConversations();
});
function addBubbleEmpty() {
  messagesEl.innerHTML = `
    <div class="empty-state" id="chat-empty">
      <div class="empty-mark">⬡</div>
      <h2>Your sovereign AI</h2>
      <p>Runs on your machine. Remembers what you tell it. Answers from your own knowledge.<br/>Nothing leaves your control.</p>
    </div>`;
}

/* ---------- conversations ---------- */
async function loadConversations() {
  const list = await api.get('/api/conversations');
  const el = $('#conversation-list');
  el.innerHTML = '';
  for (const c of list) {
    const item = document.createElement('div');
    item.className = 'conversation' + (c.id === state.conversationId ? ' active' : '');
    item.innerHTML = `<span class="title">${escapeHtml(c.title || 'Untitled')}</span><button class="del" title="Delete">✕</button>`;
    item.querySelector('.title').addEventListener('click', () => openConversation(c.id));
    item.addEventListener('click', (e) => {
      if (!e.target.classList.contains('del')) openConversation(c.id);
    });
    item.querySelector('.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.send('DELETE', `/api/conversations/${c.id}`);
      if (state.conversationId === c.id) {
        state.conversationId = null;
        addBubbleEmpty();
      }
      loadConversations();
    });
    el.appendChild(item);
  }
}

async function openConversation(id) {
  const convo = await api.get(`/api/conversations/${id}`);
  state.conversationId = id;
  messagesEl.innerHTML = '';
  for (const m of convo.messages) {
    addBubble(m.role === 'user' ? 'user' : 'assistant', renderMarkdown(m.content), m.model ? `${m.provider}/${m.model}` : undefined);
  }
  if (convo.persona_id) $('#persona-select').value = convo.persona_id;
  showView('chat');
  loadConversations();
}

/* ---------- personas ---------- */
async function loadPersonas() {
  state.personas = await api.get('/api/personas');
  const select = $('#persona-select');
  const current = select.value;
  select.innerHTML = state.personas.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  if (current) select.value = current;
}

/* ---------- knowledge ---------- */
$('#doc-upload').addEventListener('click', () => $('#doc-file').click());
$('#doc-file').addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    try {
      await api.send('POST', '/api/documents', await filePayload(file));
    } catch (err) {
      alert(`${file.name}: ${err.message}`);
    }
  }
  e.target.value = '';
  loadDocuments();
});

/** Binary formats (pdf/docx) go up as base64; everything else as text. Shared with the wizard. */
window.filePayload = async function filePayload(file) {
  if (/\.(pdf|docx)$/i.test(file.name)) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    return { name: file.name, contentBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  }
  return { name: file.name, content: await file.text() };
};

$('#kb-search').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  if (!q) return;
  const results = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
  $('#kb-results').innerHTML = results.length
    ? results.map((r) => `<div class="kb-result"><div class="src">${escapeHtml(r.document)} · ${r.method} · ${r.score}</div>${escapeHtml(r.content.slice(0, 400))}…</div>`).join('')
    : '<div class="kb-result">No matches in your knowledge base.</div>';
});

async function loadDocuments() {
  const docs = await api.get('/api/documents');
  const tbody = $('#doc-table tbody');
  tbody.innerHTML = docs
    .map(
      (d) => `<tr>
        <td>${escapeHtml(d.name)}</td>
        <td>${d.chunk_count}</td>
        <td>${d.embedded ? '✓ semantic' : 'keyword'}</td>
        <td>${new Date(d.created_at).toLocaleDateString()}</td>
        <td><button class="btn small danger" data-id="${d.id}">Delete</button></td>
      </tr>`
    )
    .join('');
  tbody.querySelectorAll('button').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api.send('DELETE', `/api/documents/${btn.dataset.id}`);
      loadDocuments();
    })
  );
}

/* ---------- memory ---------- */
$('#memory-add').addEventListener('click', addMemory);
$('#memory-input').addEventListener('keydown', (e) => e.key === 'Enter' && addMemory());
async function addMemory() {
  const content = $('#memory-input').value.trim();
  if (!content) return;
  await api.send('POST', '/api/memories', { content });
  $('#memory-input').value = '';
  loadMemories();
}
async function loadMemories() {
  const memories = await api.get('/api/memories');
  $('#memory-list').innerHTML = memories
    .map((m) => `<li><span>${escapeHtml(m.content)}</span><button class="btn small danger" data-id="${m.id}">Forget</button></li>`)
    .join('');
  $('#memory-list')
    .querySelectorAll('button')
    .forEach((btn) =>
      btn.addEventListener('click', async () => {
        await api.send('DELETE', `/api/memories/${btn.dataset.id}`);
        loadMemories();
      })
    );
}

/* ---------- settings ---------- */
let cfgCache = null;
async function loadSettings() {
  cfgCache = await api.get('/api/config');
  $('#cfg-name').value = cfgCache.name;
  $('#cfg-ollama-enabled').checked = cfgCache.providers.ollama.enabled;
  $('#cfg-ollama-url').value = cfgCache.providers.ollama.baseUrl;
  $('#cfg-openai-enabled').checked = cfgCache.providers.openai.enabled;
  $('#cfg-openai-url').value = cfgCache.providers.openai.baseUrl;
  $('#cfg-openai-key').value = cfgCache.providers.openai.apiKey ?? '';
  $('#cfg-anthropic-enabled').checked = cfgCache.providers.anthropic.enabled;
  $('#cfg-anthropic-key').value = cfgCache.providers.anthropic.apiKey ?? '';
  $('#cfg-default-provider').value = cfgCache.defaults.provider;
  $('#cfg-default-model').value = cfgCache.defaults.model ?? '';
  $('#cfg-embed-model').value = cfgCache.embeddings.model ?? '';
  $('#cfg-auto-memory').checked = Boolean(cfgCache.memory?.autoExtract);
  renderPersonaEditor();
  refreshModelOptions();
}

async function refreshModelOptions() {
  try {
    const provider = $('#cfg-default-provider').value;
    const { models } = await api.get(`/api/models?provider=${provider}`);
    $('#model-options').innerHTML = models.map((m) => `<option value="${escapeHtml(m.id)}">`).join('');
  } catch {
    $('#model-options').innerHTML = '';
  }
}
$('#cfg-default-provider').addEventListener('change', refreshModelOptions);

$('#providers-check').addEventListener('click', async () => {
  $('#provider-status').innerHTML = '<span class="pill">checking…</span>';
  const status = await api.get('/api/providers');
  $('#provider-status').innerHTML = status
    .map((p) => {
      const cls = !p.configured ? '' : p.ok ? 'ok' : 'bad';
      const label = !p.configured ? 'not configured' : p.ok ? p.detail : p.detail?.slice(0, 60);
      return `<span class="pill ${cls}">${escapeHtml(p.label)}: ${escapeHtml(label ?? '')}</span>`;
    })
    .join('');
});

$('#settings-save').addEventListener('click', async () => {
  const update = {
    name: $('#cfg-name').value,
    providers: {
      ollama: { enabled: $('#cfg-ollama-enabled').checked, baseUrl: $('#cfg-ollama-url').value },
      openai: { enabled: $('#cfg-openai-enabled').checked, baseUrl: $('#cfg-openai-url').value, apiKey: $('#cfg-openai-key').value },
      anthropic: { enabled: $('#cfg-anthropic-enabled').checked, apiKey: $('#cfg-anthropic-key').value },
    },
    defaults: { provider: $('#cfg-default-provider').value, model: $('#cfg-default-model').value },
    embeddings: { provider: 'ollama', model: $('#cfg-embed-model').value },
    memory: { autoExtract: $('#cfg-auto-memory').checked },
  };
  await api.send('PUT', '/api/config', update);
  await savePersonas();
  $('#save-status').textContent = '✓ Saved';
  setTimeout(() => ($('#save-status').textContent = ''), 2500);
  $('#instance-name').textContent = update.name || 'SovereignAI';
  loadPersonas();
});

/* persona editor */
function renderPersonaEditor() {
  const host = $('#persona-editor');
  host.innerHTML = '';
  for (const p of state.personas) host.appendChild(personaCard(p));
}
function personaCard(p) {
  const card = document.createElement('div');
  card.className = 'persona-card';
  card.dataset.id = p.id ?? '';
  card.innerHTML = `
    <div class="cols">
      <label>Name <input class="p-name" value="${escapeHtml(p.name ?? '')}" /></label>
      <label>Description <input class="p-desc" value="${escapeHtml(p.description ?? '')}" /></label>
      <label>Provider
        <select class="p-provider">
          <option value="">(default)</option>
          <option value="ollama">Ollama</option>
          <option value="openai">OpenAI-compatible</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </label>
      <label>Model <input class="p-model" value="${escapeHtml(p.model ?? '')}" placeholder="(default)" /></label>
    </div>
    <label>System prompt <textarea class="p-prompt">${escapeHtml(p.system_prompt ?? '')}</textarea></label>
    <div class="row">
      <label class="check"><input type="checkbox" class="p-memory" ${p.use_memory ? 'checked' : ''}/> Use memory</label>
      <label class="check"><input type="checkbox" class="p-knowledge" ${p.use_knowledge ? 'checked' : ''}/> Use knowledge base</label>
      <button class="btn small danger p-delete">Delete</button>
    </div>`;
  card.querySelector('.p-provider').value = p.provider ?? '';
  card.querySelector('.p-delete').addEventListener('click', async () => {
    if (card.dataset.id) await api.send('DELETE', `/api/personas/${card.dataset.id}`);
    card.remove();
    loadPersonas();
  });
  return card;
}
$('#persona-new').addEventListener('click', () => {
  $('#persona-editor').appendChild(personaCard({ name: 'New persona', system_prompt: 'You are…', use_memory: true }));
});
async function savePersonas() {
  for (const card of document.querySelectorAll('.persona-card')) {
    const payload = {
      name: card.querySelector('.p-name').value,
      description: card.querySelector('.p-desc').value,
      system_prompt: card.querySelector('.p-prompt').value,
      provider: card.querySelector('.p-provider').value || null,
      model: card.querySelector('.p-model').value || null,
      use_memory: card.querySelector('.p-memory').checked,
      use_knowledge: card.querySelector('.p-knowledge').checked,
    };
    if (card.dataset.id) await api.send('PUT', `/api/personas/${card.dataset.id}`, payload);
    else await api.send('POST', '/api/personas', payload);
  }
  state.personas = await api.get('/api/personas');
  renderPersonaEditor();
}

/* bake your own local model */
$('#bake-btn').addEventListener('click', async () => {
  const name = $('#bake-name').value.trim();
  const base = $('#bake-base').value.trim();
  const system = $('#bake-system').value.trim();
  const status = $('#bake-status');
  if (!name || !base || !system) {
    status.textContent = 'Fill in name, base model, and personality first.';
    return;
  }
  status.textContent = 'Baking… (this can take a moment)';
  try {
    const result = await api.send('POST', '/api/create-model', { name, base, system });
    status.textContent = `✓ Created local model "${result.model}" — pick it as a persona's model.`;
  } catch (err) {
    status.textContent = `✕ ${err.message}`;
  }
});

/* export / import */
$('#export-btn').addEventListener('click', async () => {
  const data = await api.get('/api/export');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sovereign-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});
$('#import-btn').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const parsed = JSON.parse(await file.text());
  const result = await api.send('POST', '/api/import', parsed);
  alert('Imported: ' + JSON.stringify(result.imported));
  location.reload();
});

/* ---------- boot ---------- */
(async function boot() {
  try {
    const status = await api.get('/api/status');
    $('#instance-name').textContent = status.name || 'SovereignAI';
    document.title = status.name || 'SovereignAI';
  } catch { /* server warming up */ }
  await loadPersonas();
  await loadConversations();
  // select the wizard-created (default) persona if configured
  try {
    const cfg = await api.get('/api/config');
    if (cfg.defaults?.personaId) $('#persona-select').value = cfg.defaults.personaId;
  } catch { /* non-fatal */ }
})();
