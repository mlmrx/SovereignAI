/* SovereignAI command center — no framework, no build step, no telemetry. */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const VIEW_TITLES = { home: 'Command center', chat: 'Chat', knowledge: 'Knowledge', memory: 'Memory', settings: 'Settings' };
const MAX_UPLOAD_BYTES = 14 * 1024 * 1024;

const state = {
  view: 'home',
  status: null,
  config: null,
  providers: [],
  personas: [],
  conversations: [],
  documents: [],
  memories: [],
  conversationId: null,
  conversationPersonaId: null,
  conversationRequestId: 0,
  conversationListRequestId: 0,
  streaming: false,
  streamId: null,
  abortController: null,
  knowledgeSearchId: 0,
  documentsRequestId: 0,
  memoriesRequestId: 0,
  modelRequestId: 0,
  settingsDirty: false,
  settingsLoaded: false,
};

/* Accept an auth token once, keep it out of proxy logs, and send it on API calls. */
window.SOVEREIGN_HEADERS = (() => {
  let memoryToken = '';
  let url = null;
  try {
    url = new URL(location.href);
    let token = url.searchParams.get('token'); // backward compatibility with v0.2 links
    if (!token && url.hash.startsWith('#token=')) {
      try { token = decodeURIComponent(url.hash.slice(7)); }
      catch { token = url.hash.slice(7); }
    }
    if (token) {
      memoryToken = token;
      try { localStorage.setItem('sovereign-token', token); }
      catch { /* Keep the token in memory for hardened/private browser sessions. */ }
    }
  } catch { /* Ignore malformed locations without breaking the local UI. */ }
  if (memoryToken && url) {
    try {
      url.searchParams.delete('token');
      url.hash = '#/home';
      history.replaceState(null, '', url);
    } catch { /* Authentication still works even if history mutation is blocked. */ }
  }
  return () => {
    try {
      const token = localStorage.getItem('sovereign-token');
      return memoryToken || token ? { authorization: `Bearer ${memoryToken || token}` } : {};
    } catch {
      return memoryToken ? { authorization: `Bearer ${memoryToken}` } : {};
    }
  };
})();

const api = {
  async request(method, path, body, { signal } = {}) {
    const headers = { ...SOVEREIGN_HEADERS() };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(path, {
      method,
      headers,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = response.headers.get('content-type') || '';
    const payload = type.includes('application/json') ? await response.json().catch(() => ({})) : await response.text();
    if (!response.ok) {
      const message = typeof payload === 'object' ? payload.error : payload;
      const error = new Error(message || response.statusText || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  },
  get(path, options) { return this.request('GET', path, undefined, options); },
  send(method, path, body, options) { return this.request(method, path, body, options); },
};

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderInline(value) {
  return value
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;:!?])/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function renderTextBlocks(source) {
  const lines = escapeHtml(source).split('\n');
  const output = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!list) return;
    output.push(`</${list}>`);
    list = null;
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const quote = line.match(/^&gt;\s?(.*)$/);
    if (!line.trim()) {
      flushParagraph();
      closeList();
    } else if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
    } else if (bullet || numbered) {
      flushParagraph();
      const nextList = bullet ? 'ul' : 'ol';
      if (list !== nextList) {
        closeList();
        list = nextList;
        output.push(`<${list}>`);
      }
      output.push(`<li>${renderInline((bullet || numbered)[1])}</li>`);
    } else if (quote) {
      flushParagraph();
      closeList();
      output.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
    } else {
      closeList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  closeList();
  return output.join('');
}

function renderMarkdown(source = '') {
  const text = String(source);
  const fence = /```([\w.+-]*)[^\S\r\n]*\r?\n?([\s\S]*?)```/g;
  let html = '';
  let cursor = 0;
  let match;
  while ((match = fence.exec(text)) !== null) {
    html += renderTextBlocks(text.slice(cursor, match.index));
    const language = escapeHtml(match[1] || 'code');
    const code = escapeHtml(match[2].replace(/\n$/, ''));
    html += `<pre><span class="code-label"><span>${language}</span><button class="message-tool copy-code" type="button"><svg class="icon"><use href="#i-copy"/></svg>Copy</button></span><code>${code}</code></pre>`;
    cursor = match.index + match[0].length;
  }
  html += renderTextBlocks(text.slice(cursor));
  return html || '<p></p>';
}

function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function formatDate(value, { relative = false } = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  if (!relative) return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (typeof Intl.RelativeTimeFormat !== 'function') return formatDate(value);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60) return 'just now';
  if (abs < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
  if (abs < 604800) return formatter.format(Math.round(seconds / 86400), 'day');
  return formatDate(value);
}

function toast(message, { type = 'info', title } = {}) {
  const stack = $('#toast-stack');
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.innerHTML = `<div>${title ? `<strong>${escapeHtml(title)}</strong>` : ''}${escapeHtml(message)}</div>`;
  stack.appendChild(item);
  setTimeout(() => {
    item.classList.add('out');
    setTimeout(() => item.remove(), 180);
  }, type === 'error' ? 5200 : 3200);
}

function confirmAction({ title = 'Are you sure?', message = 'This action cannot be undone.', action = 'Delete' } = {}) {
  const dialog = $('#confirm-dialog');
  if (!dialog?.showModal) return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  if (dialog.open) return Promise.resolve(false);
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  $('#confirm-action').textContent = action;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
  });
}

const mobileSidebarQuery = window.matchMedia?.('(max-width: 860px)');
let sidebarReturnFocus = null;
const fallbackTabIndexes = new WeakMap();

function mobileSidebar() {
  return mobileSidebarQuery?.matches ?? window.innerWidth <= 860;
}

function setElementInert(element, inert) {
  if (!element) return;
  if ('inert' in element) {
    element.inert = inert;
  } else {
    const selector = 'a[href], button, input, select, textarea, [tabindex]';
    const controls = [element, ...element.querySelectorAll(selector)].filter((item) => item.matches(selector));
    for (const control of controls) {
      if (inert) {
        if (!fallbackTabIndexes.has(control)) fallbackTabIndexes.set(control, control.getAttribute('tabindex'));
        control.setAttribute('tabindex', '-1');
      } else if (fallbackTabIndexes.has(control)) {
        const previous = fallbackTabIndexes.get(control);
        if (previous === null) control.removeAttribute('tabindex');
        else control.setAttribute('tabindex', previous);
        fallbackTabIndexes.delete(control);
      }
    }
  }
  if (inert) element.setAttribute('aria-hidden', 'true');
  else element.removeAttribute('aria-hidden');
}

function closeSidebar({ restoreFocus = true } = {}) {
  const wasOpen = document.body.classList.contains('sidebar-open');
  document.body.classList.remove('sidebar-open');
  $('#sidebar-scrim').hidden = true;
  if (!document.body.classList.contains('wizard-open')) {
    setElementInert($('#main'), false);
  }
  if (wasOpen && restoreFocus && sidebarReturnFocus?.isConnected) sidebarReturnFocus.focus();
  if (!document.body.classList.contains('wizard-open')) setElementInert($('#sidebar'), mobileSidebar());
  $('#sidebar').removeAttribute('role');
  $('#sidebar').removeAttribute('aria-modal');
  sidebarReturnFocus = null;
}

function openSidebar() {
  sidebarReturnFocus = document.activeElement;
  document.body.classList.add('sidebar-open');
  $('#sidebar-scrim').hidden = false;
  setElementInert($('#sidebar'), false);
  $('#sidebar-close').focus();
  if (mobileSidebar()) {
    setElementInert($('#main'), true);
    $('#sidebar').setAttribute('role', 'dialog');
    $('#sidebar').setAttribute('aria-modal', 'true');
  }
}

function syncSidebarAccessibility() {
  if (document.body.classList.contains('wizard-open')) return;
  if (!mobileSidebar()) {
    document.body.classList.remove('sidebar-open');
    $('#sidebar-scrim').hidden = true;
    setElementInert($('#sidebar'), false);
    setElementInert($('#main'), false);
    $('#sidebar').removeAttribute('role');
    $('#sidebar').removeAttribute('aria-modal');
    sidebarReturnFocus = null;
    return;
  }
  setElementInert($('#sidebar'), !document.body.classList.contains('sidebar-open'));
  if (!document.body.classList.contains('sidebar-open')) setElementInert($('#main'), false);
}

if (mobileSidebarQuery?.addEventListener) mobileSidebarQuery.addEventListener('change', syncSidebarAccessibility);
else mobileSidebarQuery?.addListener?.(syncSidebarAccessibility);

document.addEventListener('keydown', (event) => {
  if (!mobileSidebar() || !document.body.classList.contains('sidebar-open')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSidebar();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = $$('#sidebar a[href], #sidebar button:not([disabled]), #sidebar input:not([disabled]), #sidebar select:not([disabled]), #sidebar textarea:not([disabled])')
    .filter((element) => !element.hidden && !element.closest('[hidden]'));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
syncSidebarAccessibility();

function routeFromHash() {
  const match = location.hash.match(/^#\/(home|chat|knowledge|memory|settings)\/?$/);
  return match?.[1] || null;
}

function showView(name, { updateHash = true, focus = false } = {}) {
  if (!VIEW_TITLES[name]) name = 'home';
  if (name !== 'chat') state.conversationRequestId++;
  state.view = name;
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  $$('.nav-item').forEach((button) => {
    const active = button.dataset.view === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#mobile-view-title').textContent = VIEW_TITLES[name];
  if (updateHash && location.hash !== `#/${name}`) history.replaceState(null, '', `#/${name}`);
  closeSidebar();
  if (name === 'knowledge') loadDocuments().catch(showLoadError);
  if (name === 'memory') loadMemories().catch(showLoadError);
  if (name === 'settings' && (!state.settingsLoaded || !state.settingsDirty)) loadSettings().catch(showLoadError);
  if (focus) {
    const heading = $(`#view-${name} h1`);
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }
}

function showLoadError(error) {
  toast(error.message || 'Could not load this view.', { type: 'error', title: 'Something went wrong' });
}

function runtimeInfo(persona = activePersona()) {
  const provider = persona?.provider || state.config?.defaults?.provider || 'ollama';
  const model = persona?.model || state.config?.defaults?.model || '';
  const providerConfig = state.config?.providers?.[provider] || {};
  let local = false;
  if (provider === 'ollama' || provider === 'openai') {
    try {
      const host = new URL(providerConfig.baseUrl).hostname.toLowerCase().replace(/\.$/, '');
      local = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal', 'ollama'].includes(host) || host.startsWith('127.');
    } catch { local = false; }
  }
  const names = { ollama: 'Ollama', openai: 'OpenAI-compatible', anthropic: 'Anthropic' };
  const status = state.providers.find((item) => item.id === provider);
  const mode = local ? 'local' : 'remote';
  const label = local ? `Local · ${names[provider] || provider}` : `Remote · ${names[provider] || provider}`;
  const disclosure = local
    ? `Prompts and selected context go only to your configured ${names[provider] || provider} endpoint.`
    : `Prompts and enabled memory or knowledge context are sent to ${names[provider] || provider}.`;
  return { provider, model, providerConfig, status, local, mode, label, disclosure };
}

function activePersona() {
  const selected = $('#persona-select')?.value;
  return state.personas.find((persona) => persona.id === selected)
    || state.personas.find((persona) => persona.id === state.config?.defaults?.personaId)
    || state.personas[0]
    || null;
}

function updateRuntimeUI() {
  const runtime = runtimeInfo();
  const configured = runtime.status?.configured ?? Boolean(runtime.providerConfig?.enabled);
  const healthy = runtime.status?.ok;
  const css = !configured || healthy === false ? 'bad' : runtime.mode;
  const label = !configured ? 'Provider not configured' : healthy === false ? `${runtime.label} unavailable` : runtime.label;
  const detail = !configured ? 'Finish provider setup' : healthy === false ? (runtime.status?.detail || 'Connection failed') : (runtime.model || runtime.status?.detail || 'Ready');

  $('#runtime-label').textContent = label;
  $('#runtime-detail').textContent = detail;
  $('#runtime-dot').className = `status-dot ${css}`;
  for (const id of ['mobile-runtime-badge', 'home-runtime-badge', 'chat-runtime-badge']) {
    const badge = $(`#${id}`);
    badge.className = `runtime-badge ${css}`;
    badge.textContent = label;
  }
  $('#composer-disclosure').textContent = runtime.disclosure;
  $('#chat-model').textContent = `${activePersona()?.name || 'Persona'} · ${runtime.provider}/${runtime.model || 'default model'}`;
  renderChatContext();
}

/* Navigation */
$$('.nav-item').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view, { focus: true })));
$$('[data-view-target]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.viewTarget, { focus: true })));
$('#brand-home').addEventListener('click', () => showView('home', { focus: true }));
$('#sidebar-open').addEventListener('click', openSidebar);
$('#sidebar-close').addEventListener('click', closeSidebar);
$('#sidebar-scrim').addEventListener('click', closeSidebar);
window.addEventListener('hashchange', () => {
  const route = routeFromHash();
  if (route) showView(route, { updateHash: false });
});

/* Dashboard */
function renderDashboard() {
  if (!state.status) return;
  const counts = state.status.counts || {};
  $('#stat-conversations').textContent = counts.conversations ?? state.conversations.length;
  $('#stat-documents').textContent = counts.documents ?? state.documents.length;
  $('#stat-memories').textContent = counts.memories ?? state.memories.length;
  $('#stat-personas').textContent = counts.personas ?? state.personas.length;
  $('#nav-doc-count').textContent = counts.documents ?? state.documents.length;
  $('#nav-memory-count').textContent = counts.memories ?? state.memories.length;

  const runtime = runtimeInfo();
  const providerReady = runtime.status?.ok === true;
  const hasDocuments = (counts.documents ?? 0) > 0;
  const hasMemories = (counts.memories ?? 0) > 0;
  const hasPersonas = (counts.personas ?? 0) > 0;
  const score = (providerReady ? 55 : 0) + (hasPersonas ? 15 : 0) + (hasDocuments ? 15 : 0) + (hasMemories ? 15 : 0);
  $('#readiness-score').textContent = `${score}%`;
  $('#readiness-ring').style.strokeDashoffset = String(100 - score);
  $('#readiness-kicker').textContent = providerReady ? `${runtime.label} is ready` : 'One step from ready';
  $('#readiness-title').textContent = providerReady ? 'Your context is ready when you are.' : 'Connect a model to unlock your workspace.';
  $('#readiness-copy').textContent = providerReady
    ? `Chat with ${activePersona()?.name || 'your AI'}, ground answers in ${counts.documents || 0} documents, and stay in control of every saved memory.`
    : 'Your knowledge and memory are already local. Configure a provider to start reasoning over them.';

  const checklist = [
    { done: providerReady, label: 'Intelligence connected', note: providerReady ? runtime.label : 'Choose a local or remote provider', action: 'settings', actionLabel: providerReady ? 'Review' : 'Connect' },
    { done: hasDocuments, label: 'Knowledge added', note: hasDocuments ? `${counts.documents} document${counts.documents === 1 ? '' : 's'} indexed` : 'Ground answers in your files', action: 'knowledge', actionLabel: hasDocuments ? 'Open' : 'Add' },
    { done: hasMemories, label: 'Durable memory', note: hasMemories ? `${counts.memories} memory note${counts.memories === 1 ? '' : 's'} under your control` : 'Add preferences or stable context', action: 'memory', actionLabel: hasMemories ? 'Review' : 'Add' },
  ];
  $('#setup-checklist').innerHTML = checklist.map((item) => `
    <div class="checklist-item ${item.done ? 'done' : ''}">
      <span class="checkmark">${icon('check')}</span>
      <span class="checklist-copy"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.note)}</span></span>
      <button class="checklist-action" type="button" data-view-target="${item.action}">${item.actionLabel}</button>
    </div>`).join('');
  $$('[data-view-target]', $('#setup-checklist')).forEach((button) => button.addEventListener('click', () => showView(button.dataset.viewTarget)));
  renderRecentConversations();
}

function renderRecentConversations() {
  const host = $('#recent-conversations');
  const recent = state.conversations.slice(0, 6);
  if (!recent.length) {
    host.innerHTML = '<div class="recent-empty">Your first conversation will appear here. Start with one of the workflows above.</div>';
    return;
  }
  host.innerHTML = recent.map((conversation) => `
    <button class="recent-card" type="button" data-id="${escapeHtml(conversation.id)}">
      <strong>${escapeHtml(conversation.title || 'Untitled conversation')}</strong>
      <small><span>${formatDate(conversation.updated_at, { relative: true })}</span>${icon('chevron')}</small>
    </button>`).join('');
  $$('.recent-card', host).forEach((button) => button.addEventListener('click', () => openConversation(button.dataset.id)));
}

$$('[data-action="new-chat"]').forEach((button) => button.addEventListener('click', startNewChat));
$$('[data-action="upload"]').forEach((button) => button.addEventListener('click', () => {
  showView('knowledge');
  $('#doc-file').click();
}));
$$('[data-prompt]').forEach((button) => button.addEventListener('click', () => startPrompt(button.dataset.prompt)));

function startPrompt(prompt) {
  startNewChat();
  if (/knowledge base|documents/i.test(prompt)) {
    const knowledgePersona = state.personas.find((persona) => persona.use_knowledge);
    if (knowledgePersona) $('#persona-select').value = knowledgePersona.id;
  }
  renderChatContext();
  $('#input').value = prompt;
  autoGrow();
  $('#input').focus();
}

/* Conversations */
async function loadConversations() {
  const requestId = ++state.conversationListRequestId;
  const conversations = await api.get('/api/conversations');
  if (requestId !== state.conversationListRequestId) return;
  state.conversations = conversations;
  renderConversationList();
  renderRecentConversations();
  $('#conversation-count').textContent = state.conversations.length;
  if (state.status) {
    state.status.counts.conversations = state.conversations.length;
    renderDashboard();
  }
}

function conversationGroup(value) {
  const date = new Date(value);
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const delta = startToday - date;
  if (delta <= 0) return 'Today';
  if (delta < 7 * 86400000) return 'Previous 7 days';
  return 'Older';
}

function renderConversationList() {
  const host = $('#conversation-list');
  const query = $('#conversation-search').value.trim().toLowerCase();
  const visible = state.conversations.filter((item) => !query || (item.title || '').toLowerCase().includes(query));
  if (!visible.length) {
    host.innerHTML = `<div class="history-empty">${query ? 'No conversations match your search.' : 'No conversations yet.'}</div>`;
    syncSidebarAccessibility();
    return;
  }
  const groups = new Map();
  for (const conversation of visible) {
    const group = conversationGroup(conversation.updated_at);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(conversation);
  }
  host.innerHTML = [...groups].map(([group, conversations]) => `
    <section class="conversation-group" aria-label="${group}">
      <div class="conversation-group-title">${group}</div>
      ${conversations.map((conversation) => `
        <div class="conversation ${conversation.id === state.conversationId ? 'active' : ''}" data-id="${escapeHtml(conversation.id)}">
          <button class="conversation-open" type="button" title="${escapeHtml(conversation.title || 'Untitled conversation')}">${escapeHtml(conversation.title || 'Untitled conversation')}</button>
          <span class="conversation-actions">
            <button class="conversation-action rename" type="button" aria-label="Rename ${escapeHtml(conversation.title || 'conversation')}">${icon('edit')}</button>
            <button class="conversation-action delete" type="button" aria-label="Delete ${escapeHtml(conversation.title || 'conversation')}">${icon('trash')}</button>
          </span>
        </div>`).join('')}
    </section>`).join('');

  $$('.conversation', host).forEach((row) => {
    $('.conversation-open', row).addEventListener('click', () => openConversation(row.dataset.id));
    $('.rename', row).addEventListener('click', () => beginConversationRename(row));
    $('.delete', row).addEventListener('click', () => deleteConversation(row.dataset.id));
  });
  syncSidebarAccessibility();
}

$('#conversation-search').addEventListener('input', renderConversationList);

async function beginConversationRename(row) {
  const conversation = state.conversations.find((item) => item.id === row.dataset.id);
  if (!conversation) return;
  const button = $('.conversation-open', row);
  const input = document.createElement('input');
  input.className = 'conversation-open';
  input.setAttribute('aria-label', `Rename ${conversation.title || 'conversation'}`);
  input.value = conversation.title || '';
  input.maxLength = 120;
  button.replaceWith(input);
  input.focus();
  input.select();
  let saved = false;
  const save = async () => {
    if (saved) return;
    saved = true;
    const title = input.value.trim();
    if (title && title !== conversation.title) {
      try {
        await api.send('PUT', `/api/conversations/${encodeURIComponent(conversation.id)}`, { title });
        conversation.title = title;
        if (state.conversationId === conversation.id) $('#chat-title').textContent = title;
      } catch (error) { toast(error.message, { type: 'error', title: 'Rename failed' }); }
    }
    renderConversationList();
    renderRecentConversations();
  };
  input.addEventListener('blur', save, { once: true });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
    if (event.key === 'Escape') { event.preventDefault(); saved = true; renderConversationList(); }
  });
}

async function deleteConversation(id) {
  const conversation = state.conversations.find((item) => item.id === id);
  const confirmed = await confirmAction({
    title: 'Delete this conversation?',
    message: `“${conversation?.title || 'Untitled conversation'}” and all of its messages will be removed from this workspace.`,
    action: 'Delete conversation',
  });
  if (!confirmed) return;
  try {
    await api.send('DELETE', `/api/conversations/${encodeURIComponent(id)}`);
    if (state.conversationId === id) startNewChat();
    await loadConversations();
    toast('Conversation deleted.', { type: 'success' });
  } catch (error) { toast(error.message, { type: 'error', title: 'Delete failed' }); }
}

async function openConversation(id) {
  const requestId = ++state.conversationRequestId;
  if (state.streaming) stopStreaming({ silent: true, abandon: true });
  try {
    const conversation = await api.get(`/api/conversations/${encodeURIComponent(id)}`);
    if (requestId !== state.conversationRequestId) return;
    state.conversationId = id;
    state.conversationPersonaId = conversation.persona_id || null;
    $('#messages').innerHTML = '';
    for (const message of conversation.messages || []) {
      addMessage(message.role === 'user' ? 'user' : 'assistant', message.content, {
        meta: message.model ? `${message.provider}/${message.model}` : '',
      });
    }
    if (conversation.persona_id && state.personas.some((persona) => persona.id === conversation.persona_id)) {
      $('#persona-select').value = conversation.persona_id;
    }
    $('#chat-title').textContent = conversation.title || 'Untitled conversation';
    updateRuntimeUI();
    showView('chat', { focus: true });
    renderConversationList();
    requestAnimationFrame(() => { $('#messages').scrollTop = $('#messages').scrollHeight; });
  } catch (error) {
    if (requestId === state.conversationRequestId) toast(error.message, { type: 'error', title: 'Could not open conversation' });
  }
}

function startNewChat() {
  state.conversationRequestId++;
  if (state.streaming) stopStreaming({ silent: true, abandon: true });
  state.conversationId = null;
  state.conversationPersonaId = null;
  $('#chat-title').textContent = 'New conversation';
  renderEmptyChat();
  renderConversationList();
  showView('chat');
  updateRuntimeUI();
  loadConversations().catch(() => {});
  setTimeout(() => $('#input').focus(), 0);
}

/* Personas and active context */
async function loadPersonas() {
  state.personas = await api.get('/api/personas');
  const select = $('#persona-select');
  const previous = select.value;
  select.innerHTML = state.personas.map((persona) => `<option value="${escapeHtml(persona.id)}">${escapeHtml(persona.name)}</option>`).join('');
  const preferred = previous || state.config?.defaults?.personaId;
  if (preferred && state.personas.some((persona) => persona.id === preferred)) select.value = preferred;
  renderChatContext();
}

function renderChatContext() {
  const persona = activePersona();
  if (!persona) return;
  const memoryOn = Boolean(persona.use_memory);
  const knowledgeOn = Boolean(persona.use_knowledge);
  const memoryChip = $('#chat-memory-state');
  const knowledgeChip = $('#chat-knowledge-state');
  memoryChip.classList.toggle('on', memoryOn);
  knowledgeChip.classList.toggle('on', knowledgeOn);
  memoryChip.innerHTML = `${icon('brain')}Memory ${memoryOn ? `· ${state.memories.length}` : 'off'}`;
  knowledgeChip.innerHTML = `${icon('book')}Knowledge ${knowledgeOn ? `· ${state.documents.length} docs` : 'off'}`;
  $('#chat-context-note').textContent = `${persona.name}: ${persona.description || 'custom behavior'}`;
  if (!state.conversationId && !state.streaming) renderEmptyChat();
}

$('#persona-select').addEventListener('change', async (event) => {
  const nextId = event.target.value;
  if (state.conversationId && state.conversationPersonaId && nextId !== state.conversationPersonaId) {
    const confirmed = await confirmAction({
      title: 'Start a new conversation?',
      message: 'A conversation keeps the persona it started with so its context stays consistent.',
      action: 'Start new',
    });
    if (!confirmed) {
      event.target.value = state.conversationPersonaId;
      return;
    }
    state.conversationId = null;
    state.conversationPersonaId = null;
    $('#chat-title').textContent = 'New conversation';
    renderConversationList();
  }
  updateRuntimeUI();
  renderEmptyChat();
});

/* Chat */
const messagesEl = $('#messages');
const inputEl = $('#input');

function renderEmptyChat() {
  if (state.conversationId || state.streaming) return;
  const persona = activePersona();
  const runtime = runtimeInfo(persona);
  const prompts = [];
  if (persona?.use_knowledge) prompts.push('What are the most important ideas in my documents?', 'Find useful connections across my knowledge base.');
  if (persona?.use_memory) prompts.push('What do you remember about how I like to work?');
  prompts.push('Help me turn my highest priority into a concrete plan.', 'Challenge my thinking on a decision I am facing.');
  messagesEl.innerHTML = `
    <div class="chat-empty">
      <div class="chat-empty-inner">
        <span class="empty-logo">${icon('spark')}</span>
        <h2>Work with ${escapeHtml(persona?.name || 'your AI')}</h2>
        <p>${escapeHtml(runtime.disclosure)} ${persona?.use_knowledge ? 'Relevant document excerpts can be included and shown as sources.' : ''}</p>
        <div class="prompt-grid">
          ${prompts.slice(0, 4).map((prompt) => `<button class="prompt-card" type="button" data-prompt="${escapeHtml(prompt)}"><span>${escapeHtml(prompt)}</span>${icon('chevron')}</button>`).join('')}
        </div>
      </div>
    </div>`;
  $$('.prompt-card', messagesEl).forEach((button) => button.addEventListener('click', () => {
    inputEl.value = button.dataset.prompt;
    autoGrow();
    inputEl.focus();
  }));
}

function addMessage(role, content, { meta = '', sources = [], streaming = false, error = false, retryText = '' } = {}) {
  $('.chat-empty', messagesEl)?.remove();
  const row = document.createElement('article');
  row.className = `message ${role}${error ? ' error' : ''}`;
  row.innerHTML = role === 'user'
    ? `<div class="message-content"><div class="message-bubble"></div></div>`
    : `<div class="message-avatar" aria-hidden="true">S</div><div class="message-content"><div class="message-role">${escapeHtml(activePersona()?.name || 'SovereignAI')}</div><div class="message-bubble"></div><div class="message-tools"></div></div>`;
  const bubble = $('.message-bubble', row);
  const tools = $('.message-tools', row);
  let raw = content || '';
  let renderFrame = null;
  let followAfterRender = false;

  const render = ({ cursor = false } = {}) => {
    renderFrame = null;
    bubble.innerHTML = renderMarkdown(raw) + (cursor ? '<span class="cursor" aria-hidden="true"></span>' : '');
    $$('.copy-code', bubble).forEach((button) => button.addEventListener('click', async () => {
      const code = button.closest('pre')?.querySelector('code')?.textContent || '';
      await copyText(code, button);
    }));
  };
  const scheduleRender = ({ follow = false } = {}) => {
    followAfterRender ||= follow;
    if (renderFrame !== null) return;
    renderFrame = requestAnimationFrame(() => {
      render({ cursor: true });
      if (followAfterRender) maybeScrollToBottom(true);
      followAfterRender = false;
    });
  };

  const finish = ({ nextMeta = meta, nextSources = sources, wasError = error } = {}) => {
    const shouldFollow = followAfterRender || nearBottom();
    if (renderFrame !== null) cancelAnimationFrame(renderFrame);
    render();
    followAfterRender = false;
    if (role !== 'assistant') {
      if (shouldFollow) maybeScrollToBottom(true);
      return;
    }
    tools.innerHTML = `<button class="message-tool copy-message" type="button">${icon('copy')}Copy</button>${nextMeta ? `<span class="message-meta">${escapeHtml(nextMeta)}</span>` : ''}`;
    $('.copy-message', tools).addEventListener('click', (event) => copyText(raw, event.currentTarget));
    if (wasError) {
      const retry = document.createElement('button');
      retry.className = 'message-tool';
      retry.type = 'button';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => sendMessage(retryText || lastUserMessage()));
      tools.appendChild(retry);
    }
    if (nextSources?.length) $('.message-content', row).appendChild(renderSources(nextSources));
    if (shouldFollow) maybeScrollToBottom(true);
  };

  if (streaming) render({ cursor: true });
  else finish();
  messagesEl.appendChild(row);
  maybeScrollToBottom(true);
  return {
    row,
    bubble,
    append(text, options) { raw += text; scheduleRender(options); },
    set(text) { raw = text; scheduleRender(); },
    get text() { return raw; },
    finish,
  };
}

function renderSources(sources) {
  const details = document.createElement('details');
  details.className = 'source-panel';
  details.innerHTML = `
    <summary>${icon('book')} ${sources.length} private source${sources.length === 1 ? '' : 's'} used</summary>
    <div class="source-list">
      ${sources.map((source, index) => `
        <div class="source-item">
          <div class="source-head"><strong>[${index + 1}] ${escapeHtml(source.document || 'Document')}</strong><span>${escapeHtml(source.method || 'retrieval')} · ${Math.round((Number(source.score) || 0) * 100)}%</span></div>
          ${source.content || source.excerpt ? `<p>${escapeHtml(String(source.content || source.excerpt).slice(0, 900))}</p>` : ''}
        </div>`).join('')}
    </div>`;
  return details;
}

async function copyText(text, button) {
  try {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); }
      catch { legacyCopyText(text); }
    } else {
      legacyCopyText(text);
    }
    const original = button.innerHTML;
    button.innerHTML = `${icon('check')}Copied`;
    setTimeout(() => { button.innerHTML = original; }, 1400);
  } catch {
    toast('Clipboard access is unavailable in this browser.', { type: 'error' });
  }
}

function legacyCopyText(text) {
  const previousFocus = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.select();
    if (!document.execCommand?.('copy')) throw new Error('Copy command was rejected');
  } finally {
    textarea.remove();
    if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus();
  }
}

function lastUserMessage() {
  const bubbles = $$('.message.user .message-bubble', messagesEl);
  return bubbles[bubbles.length - 1]?.textContent?.trim() || '';
}

function nearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}

function maybeScrollToBottom(force = false) {
  if (force || nearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
  $('#scroll-bottom').hidden = nearBottom();
}

messagesEl.addEventListener('scroll', () => { $('#scroll-bottom').hidden = nearBottom(); });
$('#scroll-bottom').addEventListener('click', () => maybeScrollToBottom(true));

async function sendMessage(overrideText) {
  if (state.streaming) {
    stopStreaming();
    return;
  }
  const text = (overrideText ?? inputEl.value).trim();
  if (!text) return;
  const personaId = $('#persona-select').value || undefined;
  inputEl.value = '';
  autoGrow();
  addMessage('user', text);
  const pending = addMessage('assistant', '', { streaming: true, retryText: text });
  const streamId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  state.streamId = streamId;
  state.streaming = true;
  state.abortController = new AbortController();
  setStreamingUI(true);
  let metadata = null;
  let usage = null;
  let streamError = null;
  let completionStatus = 'Response complete';

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...SOVEREIGN_HEADERS() },
      signal: state.abortController.signal,
      body: JSON.stringify({
        message: text,
        conversationId: state.conversationId,
        personaId,
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || response.statusText);
    }
    for await (const packet of sseIterate(response.body)) {
      if (state.streamId !== streamId) return;
      if (packet.event === 'meta') {
        metadata = packet.data;
        state.conversationId = metadata.conversationId;
        state.conversationPersonaId = personaId || null;
        $('#chat-title').textContent = metadata.conversationTitle || text.slice(0, 64);
        $('#chat-model').textContent = `${metadata.persona} · ${metadata.provider}/${metadata.model || 'default'}`;
      } else if (packet.event === 'delta') {
        const shouldScroll = nearBottom();
        pending.append(packet.data.text || '', { follow: shouldScroll });
      } else if (packet.event === 'done') {
        usage = packet.data.usage || null;
      } else if (packet.event === 'error') {
        streamError = packet.data.message || 'The model request failed.';
        completionStatus = 'Response interrupted';
      }
    }
    if (!pending.text) throw new Error(streamError || 'The model returned an empty response.');
    const metaBits = [];
    if (usage?.input_tokens != null) metaBits.push(`${usage.input_tokens} in · ${usage.output_tokens ?? '?'} out`);
    if (metadata?.model) metaBits.push(`${metadata.provider}/${metadata.model}`);
    if (streamError) metaBits.push('stream interrupted');
    pending.finish({ nextMeta: metaBits.join(' · '), nextSources: metadata?.sources || [], wasError: Boolean(streamError) });
    if (streamError) toast(streamError, { type: 'error', title: 'Response interrupted' });
  } catch (error) {
    if (state.streamId !== streamId) return;
    if (error.name === 'AbortError') {
      completionStatus = 'Generation stopped';
      if (!pending.text) pending.set('Generation stopped.');
      pending.finish({ nextMeta: 'stopped by you' });
    } else {
      completionStatus = 'Response failed';
      const message = error.message || 'The request failed.';
      pending.set(pending.text || `I could not complete that request: ${message}`);
      pending.finish({ nextMeta: 'request failed', wasError: true });
      toast(message, { type: 'error', title: 'Chat failed' });
    }
  } finally {
    if (state.streamId === streamId) {
      state.streaming = false;
      state.abortController = null;
      state.streamId = null;
      setStreamingUI(false, completionStatus);
      await loadConversations().catch(() => {});
      refreshCounts().catch(() => {});
    }
  }
}

function setStreamingUI(streaming, statusText = streaming ? 'Generating response' : 'Response complete') {
  const button = $('#send');
  button.classList.toggle('streaming', streaming);
  button.querySelector('span').textContent = streaming ? 'Stop' : 'Send';
  button.setAttribute('aria-label', streaming ? 'Stop generating' : 'Send message');
  $('#persona-select').disabled = streaming;
  messagesEl.setAttribute('aria-busy', String(streaming));
  $('#chat-status').textContent = statusText;
}

function stopStreaming({ silent = false, abandon = false } = {}) {
  if (!state.streaming) return;
  const controller = state.abortController;
  if (abandon) {
    state.streamId = null;
    state.streaming = false;
    state.abortController = null;
    setStreamingUI(false, '');
  }
  controller?.abort();
  if (!silent) toast('Stopping generation…');
}

async function* sseIterate(body) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    buffer = buffer.replace(/\r\n/g, '\n');
    if (done && buffer.trim() && !buffer.endsWith('\n\n')) buffer += '\n\n';
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length) {
        try { yield { event, data: JSON.parse(dataLines.join('\n')) }; }
        catch { /* Ignore malformed frames without breaking the conversation. */ }
      }
    }
    if (done) break;
  }
}

$('#send').addEventListener('click', () => sendMessage());
inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
});
inputEl.addEventListener('input', autoGrow);
function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 200)}px`;
}
$('#new-chat').addEventListener('click', startNewChat);

/* Knowledge */
window.filePayload = async function filePayload(file) {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`File exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} safe upload limit`);
  if (/\.(pdf|docx)$/i.test(file.name)) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
    return { name: file.name, contentBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  }
  return { name: file.name, content: await file.text() };
};

const dropZone = $('#drop-zone');
$('#doc-upload').addEventListener('click', () => $('#doc-file').click());
$('#composer-upload').addEventListener('click', () => $('#doc-file').click());
dropZone.addEventListener('click', () => $('#doc-file').click());
dropZone.addEventListener('dragover', (event) => { event.preventDefault(); dropZone.classList.add('over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('over');
  uploadFiles(event.dataTransfer?.files).catch(showLoadError);
});
$('#doc-file').addEventListener('change', (event) => {
  uploadFiles(event.target.files).catch(showLoadError);
  event.target.value = '';
});

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  showView('knowledge');
  for (const file of files) {
    const item = document.createElement('div');
    item.className = 'upload-item';
    item.innerHTML = `${icon('file')}<span><strong>${escapeHtml(file.name)}</strong><br><small>Preparing ${formatBytes(file.size)}…</small></span><small>Working</small>`;
    $('#upload-queue').prepend(item);
    try {
      const documentRecord = await api.send('POST', '/api/documents', await filePayload(file));
      item.classList.add('success');
      $('small', $('span', item)).textContent = `${documentRecord.chunk_count} searchable chunks`;
      item.lastElementChild.textContent = 'Added';
    } catch (error) {
      item.classList.add('error');
      $('small', $('span', item)).textContent = error.message;
      item.lastElementChild.textContent = 'Failed';
    }
  }
  await loadDocuments();
  await refreshCounts();
}

async function loadDocuments() {
  const requestId = ++state.documentsRequestId;
  const documents = await api.get('/api/documents');
  if (requestId !== state.documentsRequestId) return;
  state.documents = documents;
  renderDocuments();
  $('#nav-doc-count').textContent = state.documents.length;
}

function renderDocuments() {
  const chunks = state.documents.reduce((sum, documentRecord) => sum + Number(documentRecord.chunk_count || 0), 0);
  const semantic = state.documents.filter((documentRecord) => documentRecord.embedded).length;
  $('#knowledge-doc-count').textContent = state.documents.length;
  $('#knowledge-chunk-count').textContent = chunks;
  $('#knowledge-semantic-count').textContent = semantic;
  const query = $('#document-filter').value.trim().toLowerCase();
  const documents = state.documents.filter((documentRecord) => !query || documentRecord.name.toLowerCase().includes(query));
  const host = $('#document-list');
  if (!documents.length) {
    host.innerHTML = `<div class="panel-empty">${query ? 'No documents match this filter.' : 'No documents yet. Add a file above to make your AI useful on your own material.'}</div>`;
    return;
  }
  host.innerHTML = documents.map((documentRecord) => `
    <article class="document-card">
      <span class="document-icon">${icon('file')}</span>
      <span class="document-copy"><strong title="${escapeHtml(documentRecord.name)}">${escapeHtml(documentRecord.name)}</strong><span class="document-meta"><span>${formatBytes(documentRecord.size)}</span><span>${documentRecord.chunk_count} chunks</span><span>${documentRecord.embedded ? 'Semantic' : 'Keyword'}</span><span>${formatDate(documentRecord.created_at)}</span></span></span>
      <span class="document-actions"><button class="mini-btn danger" type="button" data-delete-document="${escapeHtml(documentRecord.id)}" aria-label="Delete ${escapeHtml(documentRecord.name)}">${icon('trash')}</button></span>
    </article>`).join('');
  $$('[data-delete-document]', host).forEach((button) => button.addEventListener('click', () => deleteDocument(button.dataset.deleteDocument)));
}

$('#document-filter').addEventListener('input', renderDocuments);

async function deleteDocument(id) {
  const documentRecord = state.documents.find((item) => item.id === id);
  const confirmed = await confirmAction({
    title: 'Remove this document?',
    message: `“${documentRecord?.name || 'This document'}” will no longer be searched or used in future answers.`,
    action: 'Remove document',
  });
  if (!confirmed) return;
  try {
    await api.send('DELETE', `/api/documents/${encodeURIComponent(id)}`);
    await loadDocuments();
    await refreshCounts();
    toast('Document removed.', { type: 'success' });
  } catch (error) { toast(error.message, { type: 'error', title: 'Delete failed' }); }
}

$('#kb-search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = $('#kb-search').value.trim();
  if (!query) return;
  const searchId = ++state.knowledgeSearchId;
  const button = $('#kb-search-btn');
  button.disabled = true;
  button.textContent = 'Searching…';
  $('#kb-results').innerHTML = '<div class="results-empty">Searching your local index…</div>';
  try {
    const results = await api.get(`/api/search?q=${encodeURIComponent(query)}&limit=8`);
    if (searchId !== state.knowledgeSearchId) return;
    $('#kb-results').innerHTML = results.length ? results.map((result) => `
      <article class="kb-result">
        <div class="kb-result-head"><strong>${escapeHtml(result.document)}</strong><span class="retrieval-badge ${result.method === 'hybrid' ? 'semantic' : ''}">${result.method === 'hybrid' ? 'Semantic + keyword' : 'Keyword fallback'} · ${Math.round(result.score * 100)}%</span></div>
        <p>${escapeHtml(result.content.slice(0, 650))}${result.content.length > 650 ? '…' : ''}</p>
      </article>`).join('') : '<div class="results-empty">No matching excerpts. Try a name, exact phrase, or a more specific concept.</div>';
    $('#kb-clear').hidden = false;
  } catch (error) {
    if (searchId !== state.knowledgeSearchId) return;
    $('#kb-results').innerHTML = `<div class="results-empty">${escapeHtml(error.message)}</div>`;
  } finally {
    if (searchId === state.knowledgeSearchId) {
      button.disabled = false;
      button.textContent = 'Search';
    }
  }
});
$('#kb-clear').addEventListener('click', () => {
  state.knowledgeSearchId++;
  $('#kb-search').value = '';
  $('#kb-results').innerHTML = '';
  $('#kb-clear').hidden = true;
  $('#kb-search-btn').disabled = false;
  $('#kb-search-btn').textContent = 'Search';
  $('#kb-search').focus();
});

/* Memory */
async function loadMemories() {
  const requestId = ++state.memoriesRequestId;
  const memories = await api.get('/api/memories');
  if (requestId !== state.memoriesRequestId) return;
  state.memories = memories;
  renderMemories();
  $('#nav-memory-count').textContent = state.memories.length;
  const auto = Boolean(state.config?.memory?.autoExtract);
  $('#memory-mode-badge').className = `runtime-badge ${auto ? 'ok' : 'neutral'}`;
  $('#memory-mode-badge').textContent = auto ? 'Auto-learning on' : 'Manual memory';
}

function renderMemories() {
  const query = $('#memory-search').value.trim().toLowerCase();
  const memories = state.memories.filter((memory) => !query || memory.content.toLowerCase().includes(query));
  $('#memory-count').textContent = state.memories.length;
  const host = $('#memory-list');
  if (!memories.length) {
    host.innerHTML = `<div class="panel-empty">${query ? 'No memories match this search.' : 'Nothing saved yet. Add one stable fact or preference above.'}</div>`;
    return;
  }
  host.innerHTML = memories.map((memory) => `
    <article class="memory-card" data-id="${escapeHtml(memory.id)}">
      <div><div class="memory-content">${escapeHtml(memory.content)}</div><div class="memory-date">Saved ${formatDate(memory.created_at, { relative: true })}</div></div>
      <div class="memory-actions"><button class="mini-btn edit-memory" type="button" aria-label="Edit memory">${icon('edit')}</button><button class="mini-btn danger delete-memory" type="button" aria-label="Forget memory">${icon('trash')}</button></div>
    </article>`).join('');
  $$('.memory-card', host).forEach((card) => {
    $('.edit-memory', card).addEventListener('click', () => editMemory(card));
    $('.delete-memory', card).addEventListener('click', () => deleteMemory(card.dataset.id));
  });
}

$('#memory-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#memory-input');
  const content = input.value.trim();
  if (!content) return;
  const button = $('#memory-add');
  button.disabled = true;
  try {
    await api.send('POST', '/api/memories', { content });
    input.value = '';
    $('#memory-char-count').textContent = '0 / 2000';
    await loadMemories();
    await refreshCounts();
    toast('Memory saved.', { type: 'success' });
  } catch (error) { toast(error.message, { type: 'error', title: 'Could not save memory' }); }
  finally { button.disabled = false; }
});
$('#memory-input').addEventListener('input', (event) => { $('#memory-char-count').textContent = `${event.target.value.length} / 2000`; });
$('#memory-search').addEventListener('input', renderMemories);

function editMemory(card) {
  const memory = state.memories.find((item) => item.id === card.dataset.id);
  if (!memory || $('.memory-edit', card)) return;
  const editor = document.createElement('div');
  editor.className = 'memory-edit';
  editor.innerHTML = `<textarea maxlength="2000" aria-label="Edit memory">${escapeHtml(memory.content)}</textarea><div class="memory-edit-actions"><button class="btn small ghost cancel" type="button">Cancel</button><button class="btn small primary save" type="button">Save memory</button></div>`;
  card.appendChild(editor);
  const textarea = $('textarea', editor);
  textarea.focus();
  $('.cancel', editor).addEventListener('click', () => editor.remove());
  $('.save', editor).addEventListener('click', async () => {
    const content = textarea.value.trim();
    if (!content) return;
    try {
      await api.send('PUT', `/api/memories/${encodeURIComponent(memory.id)}`, { content });
      await loadMemories();
      toast('Memory updated.', { type: 'success' });
    } catch (error) { toast(error.message, { type: 'error', title: 'Update failed' }); }
  });
}

async function deleteMemory(id) {
  const confirmed = await confirmAction({ title: 'Forget this memory?', message: 'It will no longer be included in future conversations.', action: 'Forget memory' });
  if (!confirmed) return;
  try {
    await api.send('DELETE', `/api/memories/${encodeURIComponent(id)}`);
    await loadMemories();
    await refreshCounts();
    toast('Memory forgotten.', { type: 'success' });
  } catch (error) { toast(error.message, { type: 'error', title: 'Delete failed' }); }
}

$$('[data-settings-target]').forEach((button) => button.addEventListener('click', () => {
  if (button.closest('.settings-nav')) return;
  if (state.view !== 'settings') showView('settings');
  setTimeout(() => scrollToSettings(button.dataset.settingsTarget), 50);
}));

/* Settings */
async function loadSettings() {
  if (!state.config) state.config = await api.get('/api/config');
  $('#cfg-name').value = state.config.name || '';
  $('#cfg-ollama-enabled').checked = Boolean(state.config.providers?.ollama?.enabled);
  $('#cfg-ollama-url').value = state.config.providers?.ollama?.baseUrl || '';
  $('#cfg-openai-enabled').checked = Boolean(state.config.providers?.openai?.enabled);
  $('#cfg-openai-url').value = state.config.providers?.openai?.baseUrl || '';
  $('#cfg-openai-key').value = state.config.providers?.openai?.apiKey || '';
  $('#cfg-anthropic-enabled').checked = Boolean(state.config.providers?.anthropic?.enabled);
  $('#cfg-anthropic-key').value = state.config.providers?.anthropic?.apiKey || '';
  $('#cfg-default-provider').value = state.config.defaults?.provider || 'ollama';
  $('#cfg-default-model').value = state.config.defaults?.model || '';
  $('#cfg-embed-model').value = state.config.embeddings?.model || '';
  $('#cfg-auto-memory').checked = Boolean(state.config.memory?.autoExtract);
  renderPersonaEditor();
  state.settingsLoaded = true;
  markSettingsDirty(false);
  await refreshModelOptions();
  renderProviderStatus();
}

function markSettingsDirty(dirty = true) {
  state.settingsDirty = dirty;
  $('#save-status').textContent = dirty ? 'Unsaved changes' : 'No unsaved changes';
}
$('#settings-body').addEventListener('input', (event) => {
  if (!event.target.closest('.save-bar')) markSettingsDirty(true);
});

async function refreshModelOptions() {
  const requestId = ++state.modelRequestId;
  const provider = $('#cfg-default-provider').value;
  try {
    const { models } = await api.get(`/api/models?provider=${encodeURIComponent(provider)}`);
    if (requestId !== state.modelRequestId || $('#cfg-default-provider').value !== provider) return;
    $('#model-options').innerHTML = (models || []).map((model) => `<option value="${escapeHtml(model.id)}"></option>`).join('');
  } catch {
    if (requestId === state.modelRequestId && $('#cfg-default-provider').value === provider) $('#model-options').innerHTML = '';
  }
}
$('#cfg-default-provider').addEventListener('change', refreshModelOptions);

async function checkProviders() {
  const button = $('#providers-check');
  button.disabled = true;
  button.textContent = 'Testing…';
  try {
    state.providers = await api.get('/api/providers');
    renderProviderStatus();
    updateRuntimeUI();
    renderDashboard();
  } catch (error) { toast(error.message, { type: 'error', title: 'Provider check failed' }); }
  finally { button.disabled = false; button.textContent = 'Test connections'; }
}
$('#providers-check').addEventListener('click', checkProviders);

function renderProviderStatus() {
  const host = $('#provider-status');
  if (!state.providers.length) {
    host.innerHTML = '<span class="provider-pill">Not checked</span>';
    return;
  }
  host.innerHTML = state.providers.map((provider) => {
    const css = !provider.configured ? '' : provider.ok ? 'ok' : 'bad';
    const detail = !provider.configured ? 'off' : provider.ok ? 'ready' : 'unavailable';
    return `<span class="provider-pill ${css}" title="${escapeHtml(provider.detail || '')}">${escapeHtml(provider.label)} · ${detail}</span>`;
  }).join('');
}

$('#settings-save').addEventListener('click', async () => {
  const button = $('#settings-save');
  button.disabled = true;
  button.textContent = 'Saving…';
  $('#save-status').textContent = 'Saving changes…';
  const update = {
    name: $('#cfg-name').value.trim(),
    providers: {
      ollama: { enabled: $('#cfg-ollama-enabled').checked, baseUrl: $('#cfg-ollama-url').value.trim() },
      openai: { enabled: $('#cfg-openai-enabled').checked, baseUrl: $('#cfg-openai-url').value.trim(), apiKey: $('#cfg-openai-key').value },
      anthropic: { enabled: $('#cfg-anthropic-enabled').checked, apiKey: $('#cfg-anthropic-key').value },
    },
    defaults: { provider: $('#cfg-default-provider').value, model: $('#cfg-default-model').value.trim() },
    embeddings: { provider: 'ollama', model: $('#cfg-embed-model').value.trim() },
    memory: { autoExtract: $('#cfg-auto-memory').checked },
  };
  try {
    if (update.defaults.provider !== 'anthropic' && !update.defaults.model) {
      throw new Error(`Choose a default model ID for ${update.defaults.provider === 'ollama' ? 'Ollama' : 'the OpenAI-compatible provider'}.`);
    }
    const personaChanges = collectPersonaChanges(update.defaults);
    state.config = await api.send('PUT', '/api/config', update);
    await savePersonas(personaChanges);
    $('#instance-name').textContent = state.config.name || 'SovereignAI';
    document.title = state.config.name || 'SovereignAI';
    markSettingsDirty(false);
    toast('Workspace settings saved.', { type: 'success' });
    await Promise.allSettled([checkProviders(), loadMemories()]);
  } catch (error) {
    $('#save-status').textContent = 'Save failed — your changes are still here';
    toast(error.message, { type: 'error', title: 'Could not save settings' });
  } finally {
    button.disabled = false;
    button.textContent = 'Save changes';
  }
});

function renderPersonaEditor() {
  const host = $('#persona-editor');
  host.innerHTML = '';
  for (const persona of state.personas) host.appendChild(personaCard(persona));
}

function personaCard(persona = {}) {
  const card = document.createElement('article');
  card.className = 'persona-card';
  card.dataset.id = persona.id || '';
  const initial = (persona.name || 'N').trim().charAt(0).toUpperCase();
  card.innerHTML = `
    <button class="persona-summary" type="button" aria-expanded="false">
      <span class="persona-avatar">${escapeHtml(initial)}</span>
      <span class="persona-summary-copy"><strong>${escapeHtml(persona.name || 'New persona')}</strong><small>${escapeHtml(persona.description || 'Custom AI behavior')}</small></span>
      <span class="persona-flags"><span class="persona-flag">${persona.use_memory ? 'Memory' : 'No memory'}</span><span class="persona-flag">${persona.use_knowledge ? 'Knowledge' : 'No knowledge'}</span></span>
      ${icon('chevron')}
    </button>
    <div class="persona-fields">
      <div class="form-grid">
        <label>Name<input class="p-name" maxlength="80" value="${escapeHtml(persona.name || '')}" /></label>
        <label>Description<input class="p-desc" maxlength="240" value="${escapeHtml(persona.description || '')}" /></label>
        <label>Provider<select class="p-provider"><option value="">Use workspace default</option><option value="ollama">Ollama</option><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option></select></label>
        <label>Model<input class="p-model" value="${escapeHtml(persona.model || '')}" placeholder="Required when overriding provider" /></label>
        <label>Temperature<input class="p-temperature" type="number" min="0" max="2" step="0.1" value="${escapeHtml(persona.temperature ?? '')}" placeholder="Provider default" /></label>
        <label class="span-2">System prompt<textarea class="p-prompt" rows="6">${escapeHtml(persona.system_prompt || '')}</textarea></label>
      </div>
      <div class="persona-options">
        <label class="check-row"><input type="checkbox" class="p-memory" ${persona.use_memory ? 'checked' : ''}/><span><strong>Use memory</strong></span></label>
        <label class="check-row"><input type="checkbox" class="p-knowledge" ${persona.use_knowledge ? 'checked' : ''}/><span><strong>Use knowledge</strong></span></label>
        <button class="btn small danger p-delete" type="button">Delete persona</button>
      </div>
    </div>`;
  $('.p-provider', card).value = persona.provider || '';
  $('.persona-summary', card).addEventListener('click', (event) => {
    const open = card.classList.toggle('open');
    event.currentTarget.setAttribute('aria-expanded', String(open));
  });
  $('.p-name', card).addEventListener('input', (event) => {
    $('.persona-summary-copy strong', card).textContent = event.target.value || 'New persona';
    $('.persona-avatar', card).textContent = (event.target.value || 'N').charAt(0).toUpperCase();
  });
  $('.p-desc', card).addEventListener('input', (event) => { $('.persona-summary-copy small', card).textContent = event.target.value || 'Custom AI behavior'; });
  $('.p-delete', card).addEventListener('click', async () => {
    if (state.personas.length <= 1 && card.dataset.id) {
      toast('Keep at least one persona in the workspace.', { type: 'error' });
      return;
    }
    const confirmed = await confirmAction({ title: 'Delete this persona?', message: 'Existing conversations remain, but this behavior profile will be removed.', action: 'Delete persona' });
    if (!confirmed) return;
    const wasDirty = state.settingsDirty;
    try {
      if (card.dataset.id) await api.send('DELETE', `/api/personas/${encodeURIComponent(card.dataset.id)}`);
      card.remove();
      await loadPersonas();
      markSettingsDirty(wasDirty);
    } catch (error) { toast(error.message, { type: 'error', title: 'Delete failed' }); }
  });
  return card;
}

$('#persona-new').addEventListener('click', () => {
  const card = personaCard({ name: 'New persona', description: 'A focused role for your workspace', system_prompt: 'You are a capable, candid assistant. Be clear, useful, and honest about uncertainty.', use_memory: true, use_knowledge: false });
  $('#persona-editor').prepend(card);
  card.classList.add('open');
  $('.persona-summary', card).setAttribute('aria-expanded', 'true');
  $('.p-name', card).focus();
  markSettingsDirty(true);
});

function collectPersonaChanges(defaults = state.config?.defaults || {}) {
  return $$('.persona-card', $('#persona-editor')).map((card) => {
    const temperatureValue = $('.p-temperature', card).value;
    const temperature = temperatureValue === '' ? null : Number(temperatureValue);
    const payload = {
      name: $('.p-name', card).value.trim(),
      description: $('.p-desc', card).value.trim(),
      system_prompt: $('.p-prompt', card).value.trim(),
      provider: $('.p-provider', card).value || null,
      model: $('.p-model', card).value.trim() || null,
      temperature,
      use_memory: $('.p-memory', card).checked,
      use_knowledge: $('.p-knowledge', card).checked,
    };
    if (!payload.name || !payload.system_prompt) throw new Error('Every persona needs a name and system prompt.');
    if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
      throw new Error(`${payload.name} needs a temperature between 0 and 2.`);
    }
    const resolvedProvider = payload.provider || defaults.provider;
    const resolvedModel = payload.model || (resolvedProvider === defaults.provider ? defaults.model : null);
    if (resolvedProvider !== 'anthropic' && !resolvedModel) {
      throw new Error(`${payload.name} needs a model ID for ${resolvedProvider || 'its provider'}.`);
    }
    return { card, payload };
  });
}

async function savePersonas(changes = collectPersonaChanges()) {
  for (const { card, payload } of changes) {
    if (card.dataset.id) {
      await api.send('PUT', `/api/personas/${encodeURIComponent(card.dataset.id)}`, payload);
    } else {
      const created = await api.send('POST', '/api/personas', payload);
      if (!created?.id) throw new Error(`SovereignAI did not return an ID for ${payload.name}.`);
      card.dataset.id = created.id;
    }
  }
  await loadPersonas();
  renderPersonaEditor();
}

$('#bake-btn').addEventListener('click', async () => {
  const name = $('#bake-name').value.trim();
  const base = $('#bake-base').value.trim();
  const system = $('#bake-system').value.trim();
  const status = $('#bake-status');
  if (!name || !base || !system) {
    status.textContent = 'Add a name, base model, and personality first.';
    return;
  }
  const button = $('#bake-btn');
  button.disabled = true;
  status.textContent = 'Creating the model on your configured Ollama endpoint. This can take a moment…';
  try {
    const result = await api.send('POST', '/api/create-model', { name, base, system });
    status.textContent = `Created “${result.model}”. You can now select it in a persona.`;
    toast(`Ollama model ${result.model} is ready.`, { type: 'success' });
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});

function scrollToSettings(id) {
  const section = document.getElementById(id);
  if (!section) return;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  section.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  $$('.settings-nav button').forEach((button) => button.classList.toggle('active', button.dataset.settingsTarget === id));
}
$$('.settings-nav button').forEach((button) => button.addEventListener('click', () => scrollToSettings(button.dataset.settingsTarget)));

$('#export-btn').addEventListener('click', async () => {
  const button = $('#export-btn');
  button.disabled = true;
  try {
    const backup = await api.get('/api/export');
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `sovereign-export-${new Date().toISOString().slice(0, 10)}.json`;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast('Workspace backup created. Provider secrets are excluded; settings must be reconfigured after a restore.', { type: 'success' });
  } catch (error) { toast(error.message, { type: 'error', title: 'Export failed' }); }
  finally { button.disabled = false; }
});
$('#import-btn').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const confirmed = await confirmAction({ title: 'Import this workspace backup?', message: 'Personas, chats, memory, and knowledge will be merged. Provider settings and secrets will not be changed.', action: 'Import backup' });
  if (!confirmed) return;
  try {
    const parsed = JSON.parse(await file.text());
    const result = await api.send('POST', '/api/import', parsed);
    const count = Object.values(result.imported || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    toast(`${count} records imported. Reloading the workspace…`, { type: 'success' });
    setTimeout(() => location.reload(), 800);
  } catch (error) { toast(error.message, { type: 'error', title: 'Import failed' }); }
});

async function refreshCounts() {
  state.status = await api.get('/api/status');
  renderDashboard();
}

/* Boot */
(async function boot() {
  try {
    const [status, config, personas, conversations, documents, memories] = await Promise.all([
      api.get('/api/status'),
      api.get('/api/config'),
      api.get('/api/personas'),
      api.get('/api/conversations'),
      api.get('/api/documents'),
      api.get('/api/memories'),
    ]);
    state.status = status;
    state.config = config;
    state.personas = personas;
    state.conversations = conversations;
    state.documents = documents;
    state.memories = memories;
    $('#instance-name').textContent = status.name || 'SovereignAI';
    document.title = status.name || 'SovereignAI';
    $('#conversation-count').textContent = conversations.length;
    $('#nav-doc-count').textContent = documents.length;
    $('#nav-memory-count').textContent = memories.length;
    await loadPersonas();
    renderConversationList();
    renderDocuments();
    renderMemories();
    renderEmptyChat();
    showView(routeFromHash(), { updateHash: true });
    updateRuntimeUI();
    renderDashboard();
    checkProviders().catch(() => {});
  } catch (error) {
    $('#runtime-label').textContent = error.status === 401 ? 'Access token required' : 'Workspace unavailable';
    $('#runtime-detail').textContent = error.status === 401 ? 'Open the secure URL printed by SovereignAI' : error.message;
    $('#runtime-dot').className = 'status-dot bad';
    toast(error.status === 401 ? 'Open the secure #token URL printed in your terminal.' : error.message, { type: 'error', title: 'Could not connect to SovereignAI' });
    renderEmptyChat();
  }
})();
