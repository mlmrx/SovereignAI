/* SovereignAI command center — no framework, no build step, no telemetry. */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const VIEW_TITLES = { mind: 'Mind', home: 'Command center', chat: 'Chat', knowledge: 'Knowledge', memory: 'Memory', finetune: 'Fine-tuning', settings: 'Settings' };
const MAX_UPLOAD_BYTES = 14 * 1024 * 1024;
const MAX_MODEL_RECIPE_BYTES = 20 * 1024 * 1024;
const MODEL_RECIPE_FORMAT = 'sovereignai.model-recipe';
const MODEL_RECIPE_VERSION = 1;
const PROVIDER_NAMES = Object.freeze({ ollama: 'Ollama', freetoken: 'FreeToken', openai: 'OpenAI-compatible', anthropic: 'Anthropic' });
const MODEL_PARAMETER_FIELDS = Object.freeze({
  temperature: 'model-temperature',
  num_ctx: 'model-num-ctx',
  top_k: 'model-top-k',
  top_p: 'model-top-p',
  min_p: 'model-min-p',
  repeat_last_n: 'model-repeat-last-n',
  repeat_penalty: 'model-repeat-penalty',
  seed: 'model-seed',
  num_predict: 'model-num-predict',
});

const state = {
  view: 'home',
  status: null,
  config: null,
  providers: [],
  personas: [],
  conversations: [],
  documents: [],
  memories: [],
  modelRecipes: [],
  modelRecipe: null,
  modelRecipeId: null,
  modelRecipeDirty: false,
  modelRecipesLoaded: false,
  modelRecipeRequestId: 0,
  modelRecipeDetailRequestId: 0,
  modelRecipeBusy: false,
  hfSearchRequestId: 0,
  hfFilesRequestId: 0,
  hfExpandedRepo: null,
  modelRecommendation: null,
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
  ollamaModelRequestId: 0,
  settingsDirty: false,
  settingsLoaded: false,
  // Settings draft of privacy.outgoingPreviewTrusted: chips revoke here, Save persists.
  outgoingTrustedDraft: [],
};

/* Accept an auth token once, keep it out of proxy logs, and send it on API calls.
   On the public demo host no instance can exist, so no token is ever read,
   stored, or sent there: a real install's #token= link pasted into the demo
   must not leave a credential behind on a marketing origin. The fragment is
   still scrubbed, so the secret does not linger in history either. */
window.SOVEREIGN_PUBLIC_DEMO = /(^|\.)mysovereign\.ai$|\.vercel\.app$/.test(location.hostname);
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
    if (token && window.SOVEREIGN_PUBLIC_DEMO) {
      token = '';
      try { url.hash = '#/home'; history.replaceState(null, '', url); } catch { /* fine */ }
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
    if (window.SOVEREIGN_PUBLIC_DEMO) return {};
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
  const match = location.hash.match(/^#\/(mind|home|chat|knowledge|memory|finetune|settings)\/?$/);
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
  // pushState, not replaceState: moving between views is navigation, and the
  // browser's own back and forward buttons are how people expect to retrace
  // it. Replacing the entry left no trail, so Back from any view jumped
  // straight out of the app instead of to the view before it. Restoring a
  // route (boot, or a popstate) passes updateHash: false and adds nothing.
  if (updateHash && location.hash !== `#/${name}`) history.pushState(null, '', `#/${name}`);
  closeSidebar();
  if (name === 'mind') loadMind().catch(showLoadError);
  if (name === 'knowledge') loadDocuments().catch(showLoadError);
  if (name === 'memory') loadMemories().catch(showLoadError);
  if (name === 'finetune') setTimeout(() => window.SOVEREIGN_FINE_TUNE?.load().catch(showLoadError), 0);
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
  if (provider === 'ollama' || provider === 'freetoken' || provider === 'openai') {
    try {
      const host = new URL(providerConfig.baseUrl).hostname.toLowerCase().replace(/\.$/, '');
      local = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal', 'ollama'].includes(host) || host.startsWith('127.');
    } catch { local = false; }
  }
  const names = PROVIDER_NAMES;
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
  $('#nav-training-count').textContent = counts.training_projects ?? 0;

  const runtime = runtimeInfo();
  const providerReady = runtime.status?.ok === true;
  const hasDocuments = (counts.documents ?? 0) > 0;
  const hasMemories = (counts.memories ?? 0) > 0;
  const hasPersonas = (counts.personas ?? 0) > 0;
  const score = (providerReady ? 55 : 0) + (hasPersonas ? 15 : 0) + (hasDocuments ? 15 : 0) + (hasMemories ? 15 : 0);
  $('#readiness-score').textContent = `${score}%`;
  $('#readiness-ring').style.strokeDashoffset = String(100 - score);
  $('#readiness-kicker').textContent = providerReady ? `${runtime.label} is ready` : 'One step from ready';
  $('#readiness-title').textContent = providerReady ? 'Ask anything. It answers from what you own.' : 'Your data is home. Now pick its brain.';
  $('#readiness-copy').textContent = providerReady
    ? `${activePersona()?.name || 'Your AI'} answers from ${counts.documents || 0} document${counts.documents === 1 ? '' : 's'} you indexed and ${counts.memories || 0} memor${counts.memories === 1 ? 'y' : 'ies'} that show their receipts. All of it stays on this machine — and all of it leaves with you whenever you ask.`
    : 'Everything you add stays on this machine either way. Choose local weights you own, or rent a frontier model on your terms — the dial is yours, in Settings.';

  const checklist = [
    { done: providerReady, label: 'Intelligence connected', note: providerReady ? runtime.label : 'Local weights you own, or a rented frontier — your dial', action: 'settings', actionLabel: providerReady ? 'Review' : 'Connect' },
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

  const importSelect = $('#chat-import-persona');
  if (importSelect) {
    const previousImportValue = importSelect.value;
    importSelect.innerHTML =
      '<option value="">No persona</option>' +
      state.personas.map((persona) => `<option value="${escapeHtml(persona.id)}">${escapeHtml(persona.name)}</option>`).join('');
    if (state.personas.some((persona) => persona.id === previousImportValue)) importSelect.value = previousImportValue;
  }
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
  // Reasoning is stream-only by design: the server relays the model's thinking
  // live and never stores it, so openConversation() has nothing to re-render.
  // The panel is created lazily on the first reasoning delta and sits before
  // the bubble, so Copy still copies only the answer.
  let reasoningPanel = null;
  let reasoningBody = null;
  let reasoningText = '';
  const appendReasoning = (text) => {
    if (role !== 'assistant' || !text) return;
    if (!reasoningPanel) {
      reasoningPanel = document.createElement('details');
      reasoningPanel.className = 'message-reasoning';
      reasoningPanel.open = true;
      reasoningPanel.innerHTML = '<summary>Reasoning</summary><div class="message-reasoning-body"></div>';
      reasoningBody = $('.message-reasoning-body', reasoningPanel);
      bubble.before(reasoningPanel);
    }
    reasoningText += text;
    // A text node needs no escaping; appending keeps each delta O(delta) and the
    // body follows its own tail while the panel is open.
    reasoningBody.append(document.createTextNode(text));
    if (reasoningPanel.open) reasoningBody.scrollTop = reasoningBody.scrollHeight;
  };

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
    if (reasoningPanel) $('summary', reasoningPanel).textContent = 'Reasoning · shown live, not saved';
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
    append(text, options) {
      // The first answer delta folds the reasoning panel so the reply takes over.
      if (reasoningPanel && !raw && text) reasoningPanel.open = false;
      raw += text;
      scheduleRender(options);
    },
    set(text) { raw = text; scheduleRender(); },
    get text() { return raw; },
    get reasoningText() { return reasoningText; },
    appendReasoning,
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
  // The customs declaration (ADR-26): a send to a remote provider shows what
  // would leave first. Cancelling keeps the message in the composer.
  if (!(await outgoingClearance({ text, personaId }))) {
    if (overrideText !== undefined && !inputEl.value.trim()) { inputEl.value = text; autoGrow(); }
    return;
  }
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
  let reasoningChars = 0;
  let stopReason = null;
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
      } else if (packet.event === 'reasoning') {
        pending.appendReasoning(packet.data.text || '');
      } else if (packet.event === 'done') {
        usage = packet.data.usage || null;
        reasoningChars = Number(packet.data.reasoningChars) || 0;
        stopReason = packet.data.stopReason || null;
        state.lastModelDigest = packet.data.modelDigest || null;
      } else if (packet.event === 'error') {
        streamError = packet.data.message || 'The model request failed.';
        completionStatus = 'Response interrupted';
      }
    }
    if (!pending.text) {
      if (!streamError && pending.reasoningText) {
        // Only blame the reply budget when the provider said so (finish_reason 'length' /
        // 'max_tokens'); the limit lives in sovereign.config.json, not in this UI.
        throw new Error(stopReason === 'length' || stopReason === 'max_tokens'
          ? 'The model spent its whole output budget on reasoning and returned no answer — raise limits.maxTokens in sovereign.config.json or try a model that thinks less.'
          : `The model returned reasoning but no answer (stop reason: ${stopReason || 'unknown'}). Try again or pick a different model.`);
      }
      throw new Error(streamError || 'The model returned an empty response.');
    }
    const metaBits = [];
    if (usage?.input_tokens != null) metaBits.push(`${usage.input_tokens} in · ${usage.output_tokens ?? '?'} out`);
    if (metadata?.model) metaBits.push(`${metadata.provider}/${metadata.model}`);
    if (state.lastModelDigest) metaBits.push(`weights ${state.lastModelDigest.slice(0, 12)}`);
    if (reasoningChars > 0) metaBits.push('reasoning shown, not saved');
    // The receipt: present only when the provider was remote and something left.
    if (metadata?.outgoing) metaBits.push(`left the machine · ${formatBytes(metadata.outgoing.bytes)} → ${metadata.outgoing.host || 'remote host'}`);
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

/* The customs declaration (ADR-26). Before a message goes to a REMOTE
   provider, ask the server for exactly what would leave and show it. Local
   providers never gate — nothing leaves. The server's locality verdict wins:
   /api/providers rows carry `local`, and until that has loaded the preview's
   own manifest.provider.local decides. A failed preview never falls through
   to a send the user could not see. */
async function outgoingClearance({ text, personaId }) {
  const privacy = state.config?.privacy || {};
  if (privacy.outgoingPreview === 'off') return true;
  const trusted = Array.isArray(privacy.outgoingPreviewTrusted) ? privacy.outgoingPreviewTrusted : [];
  const persona = state.personas.find((item) => item.id === personaId) || activePersona();
  const providerId = persona?.provider || state.config?.defaults?.provider || 'ollama';
  if (trusted.includes(providerId)) return true;
  const row = state.providers.find((item) => item.id === providerId);
  if (row?.local === true) return true;
  let manifest;
  try {
    manifest = await api.send('POST', '/api/chat/preview', { message: text, conversationId: state.conversationId, personaId });
  } catch (error) {
    toast(error.message || 'Could not preview what would leave.', { type: 'error', title: 'Nothing was sent' });
    return false;
  }
  if (!manifest?.provider || !manifest.totals) {
    toast('The preview came back malformed, so nothing was sent.', { type: 'error', title: 'Nothing was sent' });
    return false;
  }
  if (manifest.provider.local) return true;
  if (trusted.includes(manifest.provider.id)) return true;
  return showOutgoingDialog(manifest);
}

function showOutgoingDialog(manifest) {
  const dialog = $('#outgoing-dialog');
  const label = manifest.provider.label || manifest.provider.id;
  const summary = `To ${label} at ${manifest.provider.host || 'an unknown host'} · ${formatBytes(manifest.totals.bytes)} · ~${Number(manifest.totals.approxTokens || 0).toLocaleString()} tokens`;
  if (!dialog?.showModal) return Promise.resolve(window.confirm(`What leaves your machine\n\n${summary}\n\nSend it?`));
  if (dialog.open) return Promise.resolve(false);
  $('#outgoing-summary').textContent = summary;
  renderOutgoingParts(manifest.parts || {});
  const extraction = manifest.extraction;
  const extractionLine = $('#outgoing-extraction');
  extractionLine.hidden = !extraction;
  extractionLine.textContent = extraction
    ? `Afterwards, ${PROVIDER_NAMES[extraction.provider] || extraction.provider}${extraction.model ? ` (${extraction.model})` : ''} — ${extraction.local ? 'on this machine' : 'also remote'} — may write memory from this exchange.`
    : '';
  const trust = $('#outgoing-trust');
  trust.checked = false;
  $('#outgoing-trust-label').textContent = `Don't ask again for ${label}`;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  $('#outgoing-send').focus();
  return new Promise((resolve) => {
    dialog.addEventListener('close', async () => {
      const send = dialog.returnValue === 'send';
      if (send && trust.checked) await trustProvider(manifest.provider.id);
      inputEl.focus();
      resolve(send);
    }, { once: true });
  });
}

/* Every part is rendered as text (textContent, never markup): this is the
   user's own prompt, notes, and documents, shown exactly as they would go. */
function renderOutgoingParts(parts) {
  const host = $('#outgoing-parts');
  host.innerHTML = '';
  const count = (n, noun) => `${Number(n).toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
  const system = String(parts.system || '');
  const memories = Array.isArray(parts.memories) ? parts.memories : [];
  const sources = Array.isArray(parts.sources) ? parts.sources : [];
  const history = Array.isArray(parts.history) ? parts.history : [];
  const message = String(parts.message || '');
  const documents = new Set(sources.map((source) => source.documentId)).size;
  const rows = [
    ['System prompt', `${count(system.length, 'char')} · includes the notes and excerpts below`, system],
    ['Memories', count(memories.length, 'note'), memories.map((memory) => `- ${memory.content}`).join('\n\n')],
    ['Knowledge excerpts', `${count(sources.length, 'excerpt')} from ${count(documents, 'document')}`, sources.map((source, index) => `[${index + 1}] ${source.title || 'Document'}\n${source.excerpt || ''}`).join('\n\n')],
    ['Prior messages', count(history.length, 'message'), history.map((turn) => `${turn.role}: ${turn.content}`).join('\n\n')],
    ['Your message', count(message.length, 'char'), message],
  ];
  for (const [label, detail, text] of rows) {
    const part = document.createElement('details');
    part.className = 'outgoing-part';
    const summary = document.createElement('summary');
    const name = document.createElement('span');
    name.textContent = label;
    const meta = document.createElement('span');
    meta.className = 'outgoing-count';
    meta.textContent = detail;
    summary.append(name, meta);
    const body = document.createElement('pre');
    body.className = 'outgoing-text';
    body.textContent = text || '(nothing)';
    part.append(summary, body);
    host.appendChild(part);
  }
}

async function trustProvider(providerId) {
  const current = state.config?.privacy?.outgoingPreviewTrusted || [];
  if (current.includes(providerId)) return;
  try {
    state.config = await api.send('PUT', '/api/config', { privacy: { outgoingPreviewTrusted: [...current, providerId] } });
    state.outgoingTrustedDraft = [...(state.config.privacy?.outgoingPreviewTrusted || [])];
    if (state.settingsLoaded) renderOutgoingTrusted();
    toast(`${PROVIDER_NAMES[providerId] || providerId} will not ask again. Revoke that under Settings → Data & privacy.`);
  } catch (error) {
    toast(error.message || 'Could not save that choice.', { type: 'error', title: 'Still asking next time' });
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
      <div><div class="memory-content">${escapeHtml(memory.content)}</div><div class="memory-date">Saved ${formatDate(memory.created_at, { relative: true })}${memoryProvenance(memory)}</div></div>
      <div class="memory-actions"><button class="mini-btn edit-memory" type="button" aria-label="Edit memory">${icon('edit')}</button><button class="mini-btn danger delete-memory" type="button" aria-label="Forget memory">${icon('trash')}</button></div>
    </article>`).join('');
  $$('.memory-card', host).forEach((card) => {
    $('.edit-memory', card).addEventListener('click', () => editMemory(card));
    $('.delete-memory', card).addEventListener('click', () => deleteMemory(card.dataset.id));
  });
}

/* Provenance is shown exactly as recorded; rows saved before tracking
   existed say so instead of pretending an origin was known. */
function memoryProvenance(memory) {
  const notes = [];
  if (memory.origin === 'manual') notes.push('added by you');
  else if (memory.origin === 'extracted') notes.push('auto-extracted from a chat');
  else if (memory.origin === 'distilled') notes.push('distilled from imported history');
  else notes.push('recorded before provenance tracking');
  if (memory.author_provider) notes.push(`written by ${memory.author_provider}/${memory.author_model || 'default model'}`);
  if (memory.updated_at) notes.push(`edited ${formatDate(memory.updated_at, { relative: true })}`);
  return ` · ${notes.map(escapeHtml).join(' · ')}`;
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
  $('#cfg-freetoken-enabled').checked = Boolean(state.config.providers?.freetoken?.enabled);
  $('#cfg-freetoken-url').value = state.config.providers?.freetoken?.baseUrl || '';
  $('#cfg-openai-enabled').checked = Boolean(state.config.providers?.openai?.enabled);
  $('#cfg-openai-url').value = state.config.providers?.openai?.baseUrl || '';
  $('#cfg-openai-key').value = state.config.providers?.openai?.apiKey || '';
  $('#cfg-anthropic-enabled').checked = Boolean(state.config.providers?.anthropic?.enabled);
  $('#cfg-anthropic-key').value = state.config.providers?.anthropic?.apiKey || '';
  $('#cfg-default-provider').value = state.config.defaults?.provider || 'ollama';
  $('#cfg-default-model').value = state.config.defaults?.model || '';
  $('#cfg-embed-model').value = state.config.embeddings?.model || '';
  $('#cfg-auto-memory').checked = Boolean(state.config.memory?.autoExtract);
  $('#cfg-extract-local-only').checked = Boolean(state.config.memory?.extractLocalOnly);
  $('#cfg-extraction-model').value = state.config.memory?.extractionModel || '';
  $('#cfg-outgoing-preview').value = state.config.privacy?.outgoingPreview || 'ask';
  state.outgoingTrustedDraft = [...(state.config.privacy?.outgoingPreviewTrusted || [])];
  renderOutgoingTrusted();
  renderPersonaEditor();
  state.settingsLoaded = true;
  markSettingsDirty(false);
  renderModelOwnership();
  await Promise.all([refreshModelOptions(), refreshOllamaModelOptions(), loadModelRecipes(), loadModelRecommendation()]);
  renderProviderStatus();
}

/** Best-effort "what should run on this machine" hint for the Hugging Face browser. Non-critical: Model Studio works fine without it. */
async function loadModelRecommendation() {
  if (!state.modelRecommendation) {
    try { state.modelRecommendation = await api.get('/api/model-recommendation'); }
    catch { state.modelRecommendation = null; }
  }
  renderModelFitHint();
}

function renderModelFitHint() {
  const hint = $('#model-fit-hint');
  const fit = state.modelRecommendation?.modelFit;
  const sparse = state.modelRecommendation?.sparseFit;
  // The sparse (MoE) ceiling is appended only when it actually applies here;
  // a remote engine or unreadable memory says nothing rather than hedging.
  hint.textContent = fit ? fit.reasoning + (sparse?.applies && sparse.reasoning ? ` ${sparse.reasoning}` : '') : '';
}

function markSettingsDirty(dirty = true) {
  state.settingsDirty = dirty;
  $('#save-status').textContent = dirty
    ? 'Unsaved workspace changes'
    : state.modelRecipeDirty ? 'Recipe edits save separately in Model Studio' : 'No unsaved changes';
}
$('#settings-body').addEventListener('input', (event) => {
  if (!event.target.closest('.save-bar, [data-independent-settings]')) markSettingsDirty(true);
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

async function refreshOllamaModelOptions() {
  const requestId = ++state.ollamaModelRequestId;
  try {
    const { models } = await api.get('/api/models?provider=ollama');
    if (requestId !== state.ollamaModelRequestId) return;
    $('#ollama-model-options').innerHTML = (models || []).map((model) => `<option value="${escapeHtml(model.id)}"></option>`).join('');
  } catch {
    if (requestId === state.ollamaModelRequestId) $('#ollama-model-options').innerHTML = '';
  }
}

/* Model Studio */
function currentModelRecipe() {
  return state.modelRecipe?.id === state.modelRecipeId ? state.modelRecipe : null;
}

function modelEndpointInfo() {
  const configured = state.config?.providers?.ollama || {};
  let endpoint = configured.baseUrl || 'configured Ollama endpoint';
  let local = false;
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    url.username = '';
    url.password = '';
    endpoint = url.toString().replace(/\/$/, '');
  } catch { /* Keep the generic endpoint label for malformed legacy settings. */ }
  return { endpoint, local, enabled: Boolean(configured.enabled) };
}

function renderModelOwnership() {
  const { endpoint, local, enabled } = modelEndpointInfo();
  const host = $('#model-ownership');
  host.dataset.mode = local ? 'local' : 'remote';
  $('#model-endpoint-kind').textContent = local ? 'Local Ollama' : 'Remote Ollama endpoint';
  const location = local ? `on this device at ${endpoint}` : `at ${endpoint}`;
  $('#model-endpoint-note').textContent = enabled
    ? `Recipes stay in this workspace's local SQLite database. Builds send the recipe to Ollama ${location}, where the artifact is stored.`
    : `Recipes stay in this workspace's local SQLite database. Enable and save Ollama in Providers before building at ${endpoint}.`;
}

function setModelStudioStatus(message, type = '') {
  const status = $('#model-studio-status');
  status.textContent = message;
  status.className = `model-studio-status${type ? ` ${type}` : ''}`;
}

function renderModelRecipeControls() {
  const recipe = currentModelRecipe();
  const busy = state.modelRecipeBusy;
  const form = $('#model-recipe-form');
  $$('input:not([type="hidden"]), textarea, select, button', form).forEach((control) => { control.disabled = busy; });
  $('#model-import-btn').disabled = busy;
  $('#model-new-btn').disabled = busy;
  $('#model-import-file').disabled = busy;
  $$('.model-recipe-item', $('#model-recipe-list')).forEach((button) => { button.disabled = busy; });
  if (!busy) {
    $('#model-delete-btn').disabled = !recipe;
    $('#model-modelfile-btn').disabled = !recipe?.modelfile || state.modelRecipeDirty;
  }
}

function setModelStudioBusy(busy) {
  state.modelRecipeBusy = Boolean(busy);
  renderModelRecipeControls();
}

function renderModelRecipeState() {
  const badge = $('#model-recipe-state');
  const recipe = currentModelRecipe();
  badge.className = 'recipe-state';
  if (state.modelRecipeDirty) {
    badge.textContent = 'Unsaved changes';
    badge.classList.add('dirty');
  } else if (recipe?.last_built_at) {
    badge.textContent = 'Build recorded';
    badge.classList.add('built');
  } else if (recipe) {
    badge.textContent = 'Saved';
  } else {
    badge.textContent = 'Not saved';
  }
  renderModelRecipeControls();
}

function markModelRecipeDirty(dirty = true) {
  state.modelRecipeDirty = Boolean(dirty);
  if (!state.settingsDirty) {
    $('#save-status').textContent = state.modelRecipeDirty ? 'Recipe edits save separately in Model Studio' : 'No unsaved changes';
  }
  renderModelRecipeState();
}

function renderModelRecipeList() {
  const host = $('#model-recipe-list');
  $('#model-recipe-count').textContent = state.modelRecipes.length;
  if (!state.modelRecipes.length) {
    host.innerHTML = '<div class="model-library-empty">No saved recipes yet. Start with a new portable blueprint.</div>';
    return;
  }
  host.innerHTML = state.modelRecipes.map((recipe) => {
    const active = recipe.id === state.modelRecipeId;
    const activity = recipe.last_built_at
      ? `Build recorded ${formatDate(recipe.last_built_at, { relative: true })}`
      : `Saved ${formatDate(recipe.updated_at, { relative: true })}`;
    return `<div role="listitem"><button class="model-recipe-item${active ? ' active' : ''}" type="button" data-id="${escapeHtml(recipe.id)}"${active ? ' aria-current="true"' : ''}${state.modelRecipeBusy ? ' disabled' : ''}>
      <strong>${escapeHtml(recipe.title)}</strong>
      <span>${escapeHtml(recipe.name)}</span>
      <small class="${recipe.last_built_at ? 'recipe-built' : ''}">${escapeHtml(activity)}</small>
    </button></div>`;
  }).join('');
  $$('.model-recipe-item', host).forEach((button) => button.addEventListener('click', () => selectModelRecipe(button.dataset.id)));
}

function renderModelMessages(messages = []) {
  const host = $('#model-message-list');
  if (!messages.length) {
    host.innerHTML = '<div class="model-message-empty">No seed messages. Add a user or assistant example when the behavior needs one.</div>';
    return;
  }
  host.innerHTML = messages.map((message, index) => `
    <div class="model-message-row" data-index="${index}">
      <select class="model-message-role" aria-label="Seed message ${index + 1} role">
        ${['system', 'user', 'assistant'].map((role) => `<option value="${role}"${message.role === role ? ' selected' : ''}>${role.charAt(0).toUpperCase() + role.slice(1)}</option>`).join('')}
      </select>
      <textarea class="model-message-content" rows="2" maxlength="65536" aria-label="Seed message ${index + 1} content" placeholder="Example message content">${escapeHtml(message.content || '')}</textarea>
      <button class="mini-btn danger model-message-remove" type="button" aria-label="Remove seed message ${index + 1}">${icon('trash')}</button>
    </div>`).join('');
  $$('.model-message-remove', host).forEach((button) => button.addEventListener('click', () => {
    const index = Number(button.closest('.model-message-row').dataset.index);
    const next = modelMessagesFromForm({ allowEmpty: true });
    next.splice(index, 1);
    renderModelMessages(next);
    markModelRecipeDirty(true);
  }));
}

function renderModelStops(stops = []) {
  const host = $('#model-stop-list');
  if (!stops.length) {
    host.innerHTML = '<div class="model-stop-empty">No custom stop sequences. The base model or Ollama defaults will apply.</div>';
    return;
  }
  host.innerHTML = stops.map((stop, index) => `
    <div class="model-stop-row" data-index="${index}">
      <textarea class="model-stop-content" rows="2" maxlength="4096" aria-label="Stop sequence ${index + 1}" placeholder="Exact sequence to stop on">${escapeHtml(stop)}</textarea>
      <button class="mini-btn danger model-stop-remove" type="button" aria-label="Remove stop sequence ${index + 1}">${icon('trash')}</button>
    </div>`).join('');
  $$('.model-stop-remove', host).forEach((button) => button.addEventListener('click', () => {
    const index = Number(button.closest('.model-stop-row').dataset.index);
    const next = modelStopsFromForm({ allowEmpty: true });
    next.splice(index, 1);
    renderModelStops(next);
    markModelRecipeDirty(true);
  }));
}

function modelStopsFromForm({ allowEmpty = false } = {}) {
  return $$('.model-stop-row', $('#model-stop-list')).map((row, index) => {
    const content = $('.model-stop-content', row).value;
    if (!allowEmpty && content.length === 0) {
      $('.model-stop-content', row).setAttribute('aria-invalid', 'true');
      throw new Error(`Stop sequence ${index + 1} needs content or should be removed.`);
    }
    return content;
  });
}

function modelMessagesFromForm({ allowEmpty = false } = {}) {
  return $$('.model-message-row', $('#model-message-list')).map((row, index) => {
    const content = $('.model-message-content', row).value;
    if (!allowEmpty && !content.trim()) {
      $('.model-message-content', row).setAttribute('aria-invalid', 'true');
      throw new Error(`Seed message ${index + 1} needs content or should be removed.`);
    }
    return { role: $('.model-message-role', row).value, content };
  });
}

function newModelRecipeDefaults() {
  const useDefault = state.config?.defaults?.provider === 'ollama';
  return {
    title: '',
    name: '',
    base: useDefault ? state.config.defaults?.model || '' : '',
    system: '',
    parameters: {},
    template: '',
    license: '',
    messages: [],
    quantize: null,
  };
}

function displayModelRecipe(recipe = null) {
  const value = recipe || newModelRecipeDefaults();
  state.modelRecipe = recipe;
  state.modelRecipeId = recipe?.id || null;
  $('#model-recipe-id').value = recipe?.id || '';
  $('#model-recipe-name').value = value.title || '';
  $('#model-artifact-name').value = value.name || '';
  $('#model-base').value = value.base || '';
  $('#model-system').value = value.system || '';
  for (const [parameter, id] of Object.entries(MODEL_PARAMETER_FIELDS)) {
    $(`#${id}`).value = value.parameters?.[parameter] ?? '';
  }
  renderModelStops(value.parameters?.stop || []);
  $('#model-quantize').value = value.quantize || '';
  $('#model-template').value = value.template || '';
  $('#model-license').value = value.license || '';
  renderModelMessages(value.messages || []);
  $$('[aria-invalid="true"]', $('#model-recipe-form')).forEach((field) => field.removeAttribute('aria-invalid'));
  $('#model-editor-heading').textContent = recipe?.title || 'New model recipe';
  const advanced = $$('.model-advanced', $('#model-recipe-form'));
  if (advanced[0]) advanced[0].open = Boolean(Object.keys(value.parameters || {}).length || value.quantize);
  if (advanced[1]) advanced[1].open = Boolean(value.template || value.license || value.messages?.length);
  renderModelRecipeList();
  markModelRecipeDirty(false);
  setModelStudioStatus(recipe
    ? `Saved locally. ${recipe.last_built_at ? `Last build recorded ${formatDate(recipe.last_built_at, { relative: true })}.` : 'Build it whenever the recipe is ready.'}`
    : 'Create a recipe, save it locally, then build the artifact when you choose.');
}

async function confirmDiscardModelRecipe() {
  if (!state.modelRecipeDirty) return true;
  return confirmAction({
    title: 'Discard unsaved recipe changes?',
    message: 'The current Model Studio edits have not been saved to your workspace.',
    action: 'Discard changes',
  });
}

async function selectModelRecipe(id) {
  if (id === state.modelRecipeId) return;
  if (!await confirmDiscardModelRecipe()) return;
  if (!state.modelRecipes.some((item) => item.id === id)) return;
  try { await loadModelRecipeDetail(id, { restoreListFocus: true }); }
  catch (error) { toast(error.message, { type: 'error', title: 'Could not load recipe' }); }
}

async function loadModelRecipes({ force = false, selectId = null } = {}) {
  if (state.modelRecipesLoaded && !force) {
    renderModelRecipeList();
    if (!state.modelRecipeId && !state.modelRecipeDirty) {
      if (state.modelRecipes[0]) await loadModelRecipeDetail(state.modelRecipes[0].id);
      else displayModelRecipe(null);
    }
    return state.modelRecipes;
  }
  const requestId = ++state.modelRecipeRequestId;
  setModelStudioBusy(true);
  setModelStudioStatus('Loading saved model recipes...');
  try {
    const recipes = await api.get('/api/model-recipes');
    if (requestId !== state.modelRecipeRequestId) return state.modelRecipes;
    state.modelRecipes = recipes;
    state.modelRecipesLoaded = true;
    if (state.modelRecipeDirty && !selectId) {
      renderModelRecipeList();
      return recipes;
    }
    const selectedId = recipes.some((recipe) => recipe.id === (selectId || state.modelRecipeId))
      ? (selectId || state.modelRecipeId)
      : recipes[0]?.id || null;
    if (selectedId) await loadModelRecipeDetail(selectedId);
    else displayModelRecipe(null);
    return recipes;
  } finally {
    if (requestId === state.modelRecipeRequestId) setModelStudioBusy(false);
  }
}

async function loadModelRecipeDetail(id, { restoreListFocus = false } = {}) {
  const requestId = ++state.modelRecipeDetailRequestId;
  setModelStudioBusy(true);
  setModelStudioStatus('Loading the selected recipe...');
  try {
    const recipe = await api.get(`/api/model-recipes/${encodeURIComponent(id)}`);
    if (requestId !== state.modelRecipeDetailRequestId) return null;
    displayModelRecipe(recipe);
    if (restoreListFocus) {
      requestAnimationFrame(() => {
        $$('.model-recipe-item', $('#model-recipe-list')).find((button) => button.dataset.id === id)?.focus();
      });
    }
    return recipe;
  } catch (error) {
    if (requestId === state.modelRecipeDetailRequestId) setModelStudioStatus(error.message, 'error');
    throw error;
  } finally {
    if (requestId === state.modelRecipeDetailRequestId) setModelStudioBusy(false);
  }
}

function collectModelRecipeForm() {
  const form = $('#model-recipe-form');
  $$('[aria-invalid="true"]', form).forEach((field) => field.removeAttribute('aria-invalid'));
  if (!form.checkValidity()) {
    $$('input, textarea, select', form).forEach((field) => {
      if (!field.checkValidity()) field.setAttribute('aria-invalid', 'true');
    });
    form.reportValidity();
    throw new Error('Fix the highlighted recipe fields before continuing.');
  }
  const parameters = {};
  for (const [parameter, id] of Object.entries(MODEL_PARAMETER_FIELDS)) {
    const raw = $(`#${id}`).value.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${parameter} must be a valid number.`);
    parameters[parameter] = value;
  }
  const stops = modelStopsFromForm();
  if (stops.length) parameters.stop = stops;
  return {
    title: $('#model-recipe-name').value.trim(),
    name: $('#model-artifact-name').value.trim(),
    base: $('#model-base').value.trim(),
    system: $('#model-system').value,
    parameters,
    template: $('#model-template').value,
    license: $('#model-license').value,
    messages: modelMessagesFromForm(),
    quantize: $('#model-quantize').value || null,
  };
}

function putClientModelRecipe(recipe) {
  state.modelRecipeRequestId++;
  state.modelRecipeDetailRequestId++;
  state.modelRecipe = recipe;
  const summary = {
    id: recipe.id,
    title: recipe.title,
    name: recipe.name,
    base: recipe.base,
    quantize: recipe.quantize,
    created_at: recipe.created_at,
    updated_at: recipe.updated_at,
    last_built_at: recipe.last_built_at,
  };
  state.modelRecipes = [summary, ...state.modelRecipes.filter((item) => item.id !== recipe.id)]
    .sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')));
  state.modelRecipesLoaded = true;
}

async function saveModelRecipe({ announce = true } = {}) {
  const payload = collectModelRecipeForm();
  const button = $('#model-save-btn');
  button.textContent = 'Saving...';
  setModelStudioBusy(true);
  setModelStudioStatus('Saving this portable recipe to the local workspace...');
  try {
    const saved = state.modelRecipeId
      ? await api.send('PUT', `/api/model-recipes/${encodeURIComponent(state.modelRecipeId)}`, payload)
      : await api.send('POST', '/api/model-recipes', payload);
    putClientModelRecipe(saved);
    displayModelRecipe(saved);
    setModelStudioStatus('Recipe saved in the local SovereignAI database.', 'success');
    if (announce) toast('Model recipe saved locally.', { type: 'success' });
    return saved;
  } catch (error) {
    setModelStudioStatus(error.message, 'error');
    throw error;
  } finally {
    button.textContent = 'Save recipe';
    setModelStudioBusy(false);
  }
}

function safeDownloadName(value, fallback = 'model-recipe') {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.slice(0, 80) || fallback;
}

function downloadModelFile(content, filename, type) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([content], { type }));
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#model-recipe-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await saveModelRecipe(); }
  catch (error) { toast(error.message, { type: 'error', title: 'Could not save recipe' }); }
});

$('#model-recipe-form').addEventListener('input', (event) => {
  event.target.removeAttribute?.('aria-invalid');
  $('#model-editor-heading').textContent = $('#model-recipe-name').value.trim() || 'New model recipe';
  markModelRecipeDirty(true);
});

$('#model-message-add').addEventListener('click', () => {
  const messages = modelMessagesFromForm({ allowEmpty: true });
  if (messages.length >= 128) {
    setModelStudioStatus('A recipe may contain at most 128 seed messages.', 'error');
    return;
  }
  messages.push({ role: messages.length && messages[messages.length - 1].role === 'user' ? 'assistant' : 'user', content: '' });
  renderModelMessages(messages);
  markModelRecipeDirty(true);
  const rows = $$('.model-message-row', $('#model-message-list'));
  $('.model-message-content', rows[rows.length - 1])?.focus();
});

$('#model-stop-add').addEventListener('click', () => {
  const stops = modelStopsFromForm({ allowEmpty: true });
  if (stops.length >= 64) {
    setModelStudioStatus('A recipe may contain at most 64 stop sequences.', 'error');
    return;
  }
  stops.push('');
  renderModelStops(stops);
  markModelRecipeDirty(true);
  const rows = $$('.model-stop-row', $('#model-stop-list'));
  $('.model-stop-content', rows[rows.length - 1])?.focus();
});

$('#model-new-btn').addEventListener('click', async () => {
  if (!await confirmDiscardModelRecipe()) return;
  displayModelRecipe(null);
  $('#model-recipe-name').focus();
});

$('#model-delete-btn').addEventListener('click', async () => {
  const recipe = currentModelRecipe();
  if (!recipe) return;
  const confirmed = await confirmAction({
    title: 'Delete this model recipe?',
    message: `“${recipe.title}” will be removed from this workspace. Any artifact already built in Ollama is not deleted.`,
    action: 'Delete recipe',
  });
  if (!confirmed) return;
  setModelStudioBusy(true);
  setModelStudioStatus('Deleting the local recipe...');
  try {
    await api.send('DELETE', `/api/model-recipes/${encodeURIComponent(recipe.id)}`);
    state.modelRecipeRequestId++;
    state.modelRecipeDetailRequestId++;
    state.modelRecipes = state.modelRecipes.filter((item) => item.id !== recipe.id);
    state.modelRecipe = null;
    state.modelRecipeId = null;
    toast('Model recipe deleted. The Ollama artifact, if built, was left intact.', { type: 'success' });
    if (state.modelRecipes[0]) {
      try { await loadModelRecipeDetail(state.modelRecipes[0].id); }
      catch (error) {
        setModelStudioStatus(`Recipe deleted, but the next recipe could not be loaded: ${error.message}`, 'error');
        toast(error.message, { type: 'error', title: 'Could not load next recipe' });
      }
    } else {
      displayModelRecipe(null);
    }
  } catch (error) {
    setModelStudioStatus(error.message, 'error');
    toast(error.message, { type: 'error', title: 'Could not delete recipe' });
  } finally { setModelStudioBusy(false); }
});

$('#model-build-btn').addEventListener('click', async () => {
  const button = $('#model-build-btn');
  try {
    let recipe = currentModelRecipe();
    if (!recipe || state.modelRecipeDirty) recipe = await saveModelRecipe({ announce: false });
    button.innerHTML = `${icon('spark')}Building...`;
    setModelStudioBusy(true);
    const { endpoint } = modelEndpointInfo();
    setModelStudioStatus(`Building “${recipe.name}” at ${endpoint}. Large models can take several minutes...`);
    const result = await api.send('POST', `/api/model-recipes/${encodeURIComponent(recipe.id)}/build`, {});
    if (result.recipe) {
      putClientModelRecipe(result.recipe);
      displayModelRecipe(result.recipe);
    }
    setModelStudioStatus(`Built “${result.model || recipe.name}” at ${endpoint}. The portable recipe remains stored locally.`, 'success');
    toast(`Ollama model ${result.model || recipe.name} is ready.`, { type: 'success' });
    await Promise.allSettled([refreshOllamaModelOptions(), refreshModelOptions()]);
  } catch (error) {
    setModelStudioStatus(error.message, 'error');
    toast(error.message, { type: 'error', title: 'Model build failed' });
  } finally {
    button.innerHTML = `${icon('spark')}Build on Ollama`;
    setModelStudioBusy(false);
  }
});

$('#model-download-btn').addEventListener('click', () => {
  try {
    const saved = currentModelRecipe();
    const draft = !saved?.portable || state.modelRecipeDirty;
    const core = draft ? collectModelRecipeForm() : saved.portable.recipe;
    const portable = draft ? { format: MODEL_RECIPE_FORMAT, version: MODEL_RECIPE_VERSION, recipe: core } : saved.portable;
    downloadModelFile(`${JSON.stringify(portable, null, 2)}\n`, `${safeDownloadName(core.name)}.sovereign-model.json`, 'application/json');
    setModelStudioStatus(draft
      ? 'Draft recipe JSON downloaded. Save it to run server-side validation before building.'
      : 'Portable recipe JSON downloaded.', 'success');
  } catch (error) {
    setModelStudioStatus(error.message, 'error');
    toast(error.message, { type: 'error', title: 'Could not export recipe' });
  }
});

$('#model-modelfile-btn').addEventListener('click', () => {
  const recipe = currentModelRecipe();
  if (!recipe?.modelfile || state.modelRecipeDirty) return;
  downloadModelFile(recipe.modelfile, `${safeDownloadName(recipe.name)}.Modelfile`, 'text/plain;charset=utf-8');
  setModelStudioStatus('Ollama Modelfile downloaded.', 'success');
});

$('#model-import-btn').addEventListener('click', () => $('#model-import-file').click());
$('#model-import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > MAX_MODEL_RECIPE_BYTES) {
    toast('Recipe files must be 20 MB or smaller.', { type: 'error', title: 'Import failed' });
    return;
  }
  if (!await confirmDiscardModelRecipe()) return;
  setModelStudioBusy(true);
  setModelStudioStatus('Validating and importing the recipe...');
  try {
    const parsed = JSON.parse(await file.text());
    const created = await api.send('POST', '/api/model-recipes', parsed);
    putClientModelRecipe(created);
    displayModelRecipe(created);
    setModelStudioStatus('Portable recipe imported into the local workspace.', 'success');
    toast('Model recipe imported.', { type: 'success' });
  } catch (error) {
    setModelStudioStatus(error instanceof SyntaxError ? 'This file is not valid JSON.' : error.message, 'error');
    toast(error instanceof SyntaxError ? 'This file is not valid JSON.' : error.message, { type: 'error', title: 'Import failed' });
  } finally { setModelStudioBusy(false); }
});

/* Model Studio — Hugging Face open-weight browser. Read-only lookups that
   only ever fill in the base model field; building still pulls straight from
   Hugging Face to the configured Ollama endpoint (see src/hf-catalog.js). */
function setHfStatus(message, type = '') {
  const status = $('#model-hf-status');
  status.textContent = message || 'Searches huggingface.co’s public API. Nothing downloads until you build — this only fills in the base model field above.';
  status.className = `model-studio-status${type ? ` ${type}` : ''}`;
}

function renderHfResults(results) {
  const host = $('#model-hf-results');
  if (!results.length) {
    host.innerHTML = '<div class="model-hf-empty">No GGUF repos matched that search.</div>';
    return;
  }
  host.innerHTML = results.map((model) => {
    const meta = [
      Number.isFinite(model.downloads) ? `${model.downloads.toLocaleString()} downloads` : null,
      Number.isFinite(model.likes) ? `${model.likes.toLocaleString()} likes` : null,
      model.license ? `license: ${escapeHtml(model.license)}` : 'license: unlisted — check the repo before building',
    ].filter(Boolean).join(' · ');
    return `<div class="model-hf-result" role="listitem">
      <div class="model-hf-result-head">
        <strong>${escapeHtml(model.id)}</strong>
        <a href="${escapeHtml(model.url)}" target="_blank" rel="noopener noreferrer">${icon('external')}<span class="sr-only">Open ${escapeHtml(model.id)} on Hugging Face</span></a>
      </div>
      <p class="model-hf-result-meta">${meta || 'No download/like counts reported'}</p>
      <button class="btn small model-hf-browse-btn" type="button" data-repo="${escapeHtml(model.id)}">Show GGUF files</button>
      <div class="model-hf-files" hidden></div>
    </div>`;
  }).join('');

  $$('.model-hf-browse-btn', host).forEach((button) => button.addEventListener('click', () => toggleHfFiles(button)));
}

async function toggleHfFiles(button) {
  const repo = button.dataset.repo;
  const filesHost = $('.model-hf-files', button.closest('.model-hf-result'));
  if (state.hfExpandedRepo === repo && !filesHost.hidden) {
    filesHost.hidden = true;
    button.textContent = 'Show GGUF files';
    state.hfExpandedRepo = null;
    return;
  }
  state.hfExpandedRepo = repo;
  filesHost.hidden = false;
  filesHost.innerHTML = '<div class="model-hf-empty">Loading files…</div>';
  button.textContent = 'Hide GGUF files';
  const requestId = ++state.hfFilesRequestId;
  try {
    const { files, license } = await api.get(`/api/model-catalog/files?repo=${encodeURIComponent(repo)}`);
    if (requestId !== state.hfFilesRequestId) return;
    const licenseNote = `<div class="model-hf-empty">Weights license: ${license ? escapeHtml(license) : 'unlisted — read the repo before building'}. The license travels with the weights, not with your recipe.</div>`;
    filesHost.innerHTML = files.length
      ? licenseNote + files.map((file) => `<button class="model-hf-file-btn" type="button" data-base="${escapeHtml(file.base)}" data-license="${escapeHtml(license ?? '')}"><span>${escapeHtml(file.filename)}</span>${file.quantization ? `<span>${escapeHtml(file.quantization)}</span>` : ''}</button>`).join('')
      : '<div class="model-hf-empty">No .gguf files found in this repo.</div>';
    $$('.model-hf-file-btn', filesHost).forEach((fileButton) => fileButton.addEventListener('click', () => applyHfBase(fileButton.dataset.base, fileButton.dataset.license)));
  } catch (error) {
    if (requestId !== state.hfFilesRequestId) return;
    filesHost.innerHTML = `<div class="model-hf-empty">${escapeHtml(error.message)}</div>`;
  }
}

function applyHfBase(base, license = '') {
  const input = $('#model-base');
  input.value = base;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  const licenseField = $('#model-license');
  if (license && licenseField && !licenseField.value.trim()) {
    licenseField.value = `Base model weights: ${license} (declared by the Hugging Face repo — verify before redistribution).`;
    licenseField.dispatchEvent(new Event('input', { bubbles: true }));
  }
  $('.model-hf-browse')?.removeAttribute('open');
  setHfStatus(
    license
      ? `Base model set to ${base} — weights license ${license}, noted on the recipe.`
      : `Base model set to ${base}. The repo lists no license — read it before building.`,
    'success'
  );
  toast(`Base model set to ${base}`, { type: 'success' });
}

/* The starter shelf: curated small models by job, sized for this machine. */
let shelfLoaded = false;
async function loadModelShelf() {
  if (shelfLoaded) return;
  shelfLoaded = true;
  const host = $('#model-shelf-body');
  try {
    const shelf = await api.get('/api/model-shelf');
    $('#model-shelf-note').textContent = `Curated ${shelf.curatedAt}. ${shelf.note}`;
    const FIT = { fits: ['fits here', 'ok'], tight: ['tight fit', 'warn'], 'too-big': ['needs more RAM', 'bad'] };
    const GPU_FIT = { fits: ['GPU: fits', 'ok'], tight: ['GPU: tight', 'warn'], 'too-big': ['GPU: needs more VRAM', 'bad'] };
    const pill = (css, [label, tone], title) => `<span class="${css} ${tone}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</span>`;
    host.innerHTML = shelf.roles.map((group) => `
      <div class="shelf-group">
        <h4>${escapeHtml(group.label)}</h4>
        <p class="shelf-job">${escapeHtml(group.job)}</p>
        ${group.models.map((model) => {
          const fit = model.fit ? FIT[model.fit] : null;
          const engine = model.engine || 'ollama';
          const sparse = model.architecture === 'moe';
          // A sparse entry is a default-model pick on whichever engine serves it — never a recipe base.
          const action = sparse || engine === 'freetoken' ? 'Use as default model' : group.role === 'memory-cognition' ? 'Use for cognition' : group.role === 'embeddings' ? 'Use for search' : 'Use as base';
          // Sparse entries: total params live in RAM. Under FreeToken the active set hits the GPU, so say
          // both numbers; under Ollama the whole weight set stays resident, so RAM is the only number.
          const size = sparse
            ? `${escapeHtml(String(model.paramsB))}B total · ${escapeHtml(String(model.activeParamsB))}B active · ~${escapeHtml(String(model.approxGBAtQ4))} GB RAM${engine === 'freetoken' ? ` · ~${escapeHtml(String(model.approxActiveGBAtQ4))} GB VRAM` : ' at Q4'}`
            : `${escapeHtml(String(model.paramsB))}B · ~${escapeHtml(String(model.approxGBAtQ4))} GB at Q4`;
          const gpuFit = sparse && model.gpuFit && GPU_FIT[model.gpuFit] ? GPU_FIT[model.gpuFit] : null;
          // The pill names the engine that serves THIS entry (the API's per-entry `engine`):
          // FreeToken for most of the tier, Ollama where it pulls the GGUF directly.
          const enginePill = sparse || engine === 'freetoken' ? shelfEnginePill(engine) : null;
          const pills = [
            fit ? pill('shelf-fit', fit) : '',
            gpuFit ? pill('shelf-fit', gpuFit) : '',
            enginePill ? pill('shelf-engine', [enginePill.label, enginePill.tone], enginePill.title) : '',
          ].filter(Boolean);
          return `<div class="shelf-model">
            <div><strong>${escapeHtml(model.base)}</strong>
              <span class="shelf-meta">${size}${pills.map((markup) => ` · ${markup}`).join('')}</span>
              <span class="shelf-meta">license: ${escapeHtml(model.license)}</span>
              <span class="shelf-why">${escapeHtml(model.why)}</span></div>
            <button class="btn small shelf-apply" type="button" data-role="${escapeHtml(group.role)}" data-engine="${escapeHtml(engine)}" data-base="${escapeHtml(model.base)}" data-hf="${escapeHtml(model.hf || model.base)}">${action}</button>
          </div>`;
        }).join('')}
      </div>`).join('');
    $$('.shelf-apply', host).forEach((button) => button.addEventListener('click', () => applyShelfModel(button.dataset.role, button.dataset.base, button.dataset)));
  } catch (error) {
    host.innerHTML = `<p class="model-studio-status">${escapeHtml(error.message)}</p>`;
  }
}

/** An engine's live status, from the last /api/providers check, as a pill — FreeToken or Ollama, per shelf entry. */
const SHELF_ENGINE_LABELS = { freetoken: 'FreeToken', ollama: 'Ollama' };
function shelfEnginePill(engine = 'freetoken') {
  const name = SHELF_ENGINE_LABELS[engine] || engine;
  const row = state.providers.find((provider) => provider.id === engine);
  if (row?.ok === true) return { label: `${name} ready`, tone: 'ok', title: row.detail || '' };
  if (row && (row.enabled || row.configured)) return { label: `${name} unavailable`, tone: 'bad', title: row.detail || '' };
  return { label: `needs ${name}`, tone: 'warn', title: `Enable ${name} in Settings → Providers` };
}

/** Re-render an already-open shelf so the engine pill tracks provider status. */
function refreshModelShelf() {
  if (!shelfLoaded) return;
  shelfLoaded = false;
  if ($('.model-shelf')?.open) loadModelShelf().catch(() => {});
}

async function applyShelfModel(role, base, { engine = 'ollama', hf = base } = {}) {
  try {
    if (engine === 'freetoken') {
      // A sparse model is not an Ollama recipe base: it becomes the default
      // model on the FreeToken provider, which serves it directly.
      const updated = await api.send('PUT', '/api/config', { defaults: { provider: 'freetoken', model: base } });
      state.config = updated;
      // The shelf sits inside Settings: mirror the new default into the already-
      // populated form (so a later Save keeps it) and into the runtime badges.
      $('#cfg-default-provider').value = 'freetoken';
      $('#cfg-default-model').value = base;
      refreshModelOptions().catch(() => {});
      updateRuntimeUI();
      renderDashboard();
      const row = state.providers.find((provider) => provider.id === 'freetoken');
      toast(
        row?.ok === true
          ? `Default model set to ${base} on FreeToken.`
          : row && (row.enabled || row.configured)
            ? `Default model set to ${base}. FreeToken is enabled but not reachable — serve it with: ft serve --model ${hf}`
            : `Default model set to ${base}. Enable FreeToken in Settings → Providers and serve it with: ft serve --model ${hf}`,
        { type: 'success' }
      );
      return;
    }
    if (role === 'frontier-moe') {
      // A sparse model Ollama pulls directly is still a default-model pick, not
      // a recipe base: it becomes the default model on the engine that serves it.
      const updated = await api.send('PUT', '/api/config', { defaults: { provider: engine, model: base } });
      state.config = updated;
      $('#cfg-default-provider').value = engine;
      $('#cfg-default-model').value = base;
      refreshModelOptions().catch(() => {});
      updateRuntimeUI();
      renderDashboard();
      const name = SHELF_ENGINE_LABELS[engine] || engine;
      toast(`Default model set to ${base} on ${name}.${engine === 'ollama' ? ` Pull it first: ollama pull ${base}` : ''}`, { type: 'success' });
      return;
    }
    if (role === 'memory-cognition') {
      const updated = await api.send('PUT', '/api/config', { memory: { ...state.config.memory, extractionModel: base } });
      state.config = updated;
      $('#cfg-extraction-model') && ($('#cfg-extraction-model').value = base);
      toast(`Cognition model set to ${base} — memory-writing now runs it on your default provider. Pull it first: ollama pull ${base}`, { type: 'success' });
      return;
    }
    if (role === 'embeddings') {
      const updated = await api.send('PUT', '/api/config', { embeddings: { model: base } });
      state.config = updated;
      toast(`Embedding model set to ${base}. Pull it first: ollama pull ${base}`, { type: 'success' });
      return;
    }
    applyHfBase(base);
  } catch (error) {
    toast(error.message, { type: 'error', title: 'Could not apply' });
  }
}

$('.model-shelf')?.addEventListener('toggle', (event) => {
  if (event.target.open) loadModelShelf().catch(() => {});
}, true);

async function searchHfModels() {
  const query = $('#model-hf-query').value.trim();
  if (!query) {
    $('#model-hf-results').innerHTML = '';
    setHfStatus();
    return;
  }
  const requestId = ++state.hfSearchRequestId;
  setHfStatus('Searching Hugging Face…');
  try {
    const { results } = await api.get(`/api/model-catalog/search?q=${encodeURIComponent(query)}`);
    if (requestId !== state.hfSearchRequestId) return;
    renderHfResults(results);
    setHfStatus(results.length ? `${results.length} repo${results.length === 1 ? '' : 's'} found. Nothing downloads until you build.` : undefined);
  } catch (error) {
    if (requestId !== state.hfSearchRequestId) return;
    $('#model-hf-results').innerHTML = '';
    setHfStatus(error.message, 'error');
  }
}

(() => {
  let hfSearchTimer;
  $('#model-hf-query').addEventListener('input', () => {
    clearTimeout(hfSearchTimer);
    hfSearchTimer = setTimeout(searchHfModels, 450);
  });
  $('#model-hf-query').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    clearTimeout(hfSearchTimer);
    searchHfModels();
  });
})();

window.addEventListener('beforeunload', (event) => {
  if (!state.settingsDirty && !state.modelRecipeDirty && !window.SOVEREIGN_FINE_TUNE?.isDirty?.()) return;
  event.preventDefault();
  event.returnValue = '';
});

async function checkProviders() {
  const button = $('#providers-check');
  button.disabled = true;
  button.textContent = 'Testing…';
  try {
    state.providers = await api.get('/api/providers');
    renderProviderStatus();
    updateRuntimeUI();
    renderDashboard();
    refreshModelShelf();
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

/* Providers the user told the customs declaration not to ask about again, as
   removable chips. Revoking edits the draft; Save changes persists it. */
function renderOutgoingTrusted() {
  const host = $('#cfg-outgoing-trusted');
  const list = state.outgoingTrustedDraft || [];
  if (!list.length) {
    host.innerHTML = '<span class="trusted-none">None — every remote send is shown first.</span>';
    return;
  }
  host.innerHTML = list.map((id) => {
    const name = escapeHtml(PROVIDER_NAMES[id] || id);
    return `<span class="trusted-chip"><span>${name}</span><button class="trusted-revoke" type="button" data-provider="${escapeHtml(id)}" aria-label="Ask again before sending to ${name}">Revoke</button></span>`;
  }).join('');
  $$('.trusted-revoke', host).forEach((button) => button.addEventListener('click', () => {
    state.outgoingTrustedDraft = (state.outgoingTrustedDraft || []).filter((id) => id !== button.dataset.provider);
    renderOutgoingTrusted();
    markSettingsDirty(true);
  }));
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
      freetoken: { enabled: $('#cfg-freetoken-enabled').checked, baseUrl: $('#cfg-freetoken-url').value.trim() },
      openai: { enabled: $('#cfg-openai-enabled').checked, baseUrl: $('#cfg-openai-url').value.trim(), apiKey: $('#cfg-openai-key').value },
      anthropic: { enabled: $('#cfg-anthropic-enabled').checked, apiKey: $('#cfg-anthropic-key').value },
    },
    defaults: { provider: $('#cfg-default-provider').value, model: $('#cfg-default-model').value.trim() },
    embeddings: { provider: 'ollama', model: $('#cfg-embed-model').value.trim() },
    memory: { autoExtract: $('#cfg-auto-memory').checked, extractLocalOnly: $('#cfg-extract-local-only').checked, extractionModel: $('#cfg-extraction-model').value.trim() },
    privacy: { outgoingPreview: $('#cfg-outgoing-preview').value, outgoingPreviewTrusted: state.outgoingTrustedDraft || [] },
  };
  try {
    if (update.defaults.provider !== 'anthropic' && !update.defaults.model) {
      const providerNames = { ollama: 'Ollama', freetoken: 'FreeToken', openai: 'the OpenAI-compatible provider' };
      throw new Error(`Choose a default model ID for ${providerNames[update.defaults.provider] || update.defaults.provider}.`);
    }
    const personaChanges = collectPersonaChanges(update.defaults);
    state.config = await api.send('PUT', '/api/config', update);
    await savePersonas(personaChanges);
    $('#instance-name').textContent = state.config.name || 'SovereignAI';
    document.title = state.config.name || 'SovereignAI';
    markSettingsDirty(false);
    renderModelOwnership();
    toast('Workspace settings saved.', { type: 'success' });
    await Promise.allSettled([checkProviders(), loadMemories(), refreshOllamaModelOptions(), refreshModelOptions()]);
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
        <label>Provider<select class="p-provider"><option value="">Use workspace default</option><option value="ollama">Ollama</option><option value="freetoken">FreeToken</option><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option></select></label>
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

function setChatImportStatus(html, type = '') {
  const status = $('#chat-import-status');
  status.innerHTML = html;
  status.className = `model-studio-status${type ? ` ${type}` : ''}`;
}

async function fileToBase64(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

$('#chat-import-btn').addEventListener('click', () => $('#chat-import-file').click());
$('#chat-import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > MAX_UPLOAD_BYTES) {
    setChatImportStatus(
      `File exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit here — run <code>sovereign import-chat</code> from the command line for a larger export.`,
      'error'
    );
    return;
  }
  const button = $('#chat-import-btn');
  button.disabled = true;
  setChatImportStatus('Reading and importing…');
  try {
    const contentBase64 = await fileToBase64(file);
    const platform = $('#chat-import-platform').value || undefined;
    const personaId = $('#chat-import-persona').value || undefined;
    const result = await api.send('POST', '/api/chat-import', { contentBase64, platform, personaId });
    const summary = `Detected ${escapeHtml(result.platform)}. Imported ${result.imported} conversation${result.imported === 1 ? '' : 's'}, skipped ${result.skipped} already imported (of ${result.totalParsed} parsed).`;
    const warningList = result.warnings.length
      ? `<br>${result.warnings.map((w) => `• ${escapeHtml(w)}`).join('<br>')}`
      : '';
    setChatImportStatus(summary + warningList, result.imported > 0 ? 'success' : '');
    if (result.imported > 0) {
      toast(`Imported ${result.imported} conversation${result.imported === 1 ? '' : 's'} from ${result.platform}.`, { type: 'success' });
      await Promise.allSettled([loadConversations(), refreshCounts()]);
    }
  } catch (error) {
    setChatImportStatus(escapeHtml(error.message), 'error');
    toast(error.message, { type: 'error', title: 'Import failed' });
  } finally {
    button.disabled = false;
  }
});

async function refreshCounts() {
  state.status = await api.get('/api/status');
  renderDashboard();
}

/* Mind: the context control room — what the AI knows, with receipts */
const ORIGIN_LABELS = {
  manual: 'added by you',
  extracted: 'learned from a chat',
  distilled: 'distilled from imported history',
  untracked: 'recorded before provenance tracking',
};

async function loadMind() {
  const [mind, life] = await Promise.all([api.get('/api/mind'), api.get('/api/life')]);
  state.mind = mind;
  renderMindLife(life);
  $('#mind-subtitle').textContent = `Every durable fact ${mind.name ? `${mind.name} keeps` : 'your AI keeps'}, where it came from, and where it can go next.`;
  $('#mind-count-total').textContent = mind.memories.total;
  $('#mind-count-manual').textContent = mind.memories.manual;
  $('#mind-count-extracted').textContent = mind.memories.extracted;
  $('#mind-count-distilled').textContent = mind.memories.distilled;
  const untrackedNote = $('#mind-untracked-note');
  untrackedNote.hidden = !mind.memories.untracked;
  if (mind.memories.untracked) {
    untrackedNote.textContent = `${mind.memories.untracked} memor${mind.memories.untracked === 1 ? 'y was' : 'ies were'} recorded before provenance tracking — origin honestly unknown.`;
  }
  renderMindIgnition(mind.memories);
  renderMindLedger(mind.memories.recent);
  renderMindImports(mind.imports);
  $('#mind-doc-count').textContent = mind.documents.count;
  $('#mind-doc-embedded').textContent = mind.documents.embedded;
}

/* One hex cell per memory (capped), colored by origin — data, not decoration. */
function renderMindIgnition(memories) {
  const host = $('#mind-ignition');
  const cells = [];
  const cap = 160;
  for (const origin of ['manual', 'extracted', 'distilled', 'untracked']) {
    for (let index = 0; index < Math.min(memories[origin], cap - cells.length); index++) {
      cells.push(`<span class="mind-cell ${origin}"></span>`);
    }
  }
  const overflow = memories.total - cells.length;
  host.innerHTML = cells.join('') + (overflow > 0 ? `<span class="mind-cell-more">+${overflow}</span>` : '');
}

function renderMindLedger(recent) {
  const host = $('#mind-ledger-list');
  if (!recent.length) {
    host.innerHTML = '<li class="panel-empty">Nothing yet. Add a memory, chat with auto-learning on, or bring your history home.</li>';
    return;
  }
  host.innerHTML = recent
    .map((memory) => {
      const receipts = [ORIGIN_LABELS[memory.origin ?? 'untracked'] || ORIGIN_LABELS.untracked];
      if (memory.source) {
        receipts.push(memory.source.deleted ? 'from a since-deleted conversation' : `from “${memory.source.title || 'Untitled conversation'}”`);
      }
      if (memory.author) receipts.push(`written by ${memory.author.provider}/${memory.author.model || 'default model'}`);
      if (memory.updated_at) receipts.push(`edited ${formatDate(memory.updated_at, { relative: true })}`);
      return `<li class="mind-ledger-item ${escapeHtml(memory.origin ?? 'untracked')}">
        <span class="mind-ledger-content">${escapeHtml(memory.content)}</span>
        <span class="mind-ledger-receipt">${escapeHtml(receipts.join(' · '))} · ${formatDate(memory.created_at, { relative: true })}</span>
      </li>`;
    })
    .join('');
}

function renderMindImports(imports) {
  const host = $('#mind-imports-body');
  const distillBtn = $('#mind-distill-btn');
  if (!imports.conversations) {
    host.innerHTML = '<p class="mind-note">No imported history yet. Your ChatGPT or Claude export can seed this mind in minutes.</p>';
    distillBtn.hidden = true;
    return;
  }
  host.innerHTML = `<ul class="mind-import-list">${imports.platforms
    .map((platform) => `<li><strong>${escapeHtml(platform.platform)}</strong> — ${platform.conversations} conversation${platform.conversations === 1 ? '' : 's'}${platform.undistilled ? `, ${platform.undistilled} not yet distilled` : ', fully distilled'}</li>`)
    .join('')}</ul>`;
  distillBtn.hidden = !imports.undistilled;
  if (imports.undistilled) {
    $('#mind-distill-btn-label').textContent = `Distill ${imports.undistilled} conversation${imports.undistilled === 1 ? '' : 's'} into memory`;
  }
}

function renderMindLife(life) {
  const host = $('#mind-life-body');
  if (!life.counts.total) {
    host.innerHTML =
      '<p class="mind-note">No life records yet. Scan your email archive for receipts, subscriptions, renewals, and bookings:</p>' +
      '<p class="mind-life-cmd"><code>sovereign import-email your-takeout.mbox</code></p>' +
      '<p class="mind-note">Get the file from Google Takeout (Mail → mbox) or any standard mail export.</p>';
    return;
  }
  const parts = [];
  const kinds = ['receipt', 'subscription', 'renewal', 'booking']
    .filter((kind) => life.counts[kind])
    .map((kind) => `${life.counts[kind]} ${kind}${life.counts[kind] === 1 ? '' : 's'}`)
    .join(' · ');
  parts.push(`<p class="mind-life-summary">${escapeHtml(kinds)}</p>`);

  if (life.audit.recurring.length) {
    parts.push(`<h3>Subscription audit${life.audit.estimatedMonthly ? ` — est. ${escapeHtml(String(life.audit.estimatedMonthly))}/mo` : ''}</h3>`);
    parts.push(`<ul class="mind-life-list">${life.audit.recurring.slice(0, 6).map((item) => `
      <li><strong>${escapeHtml(item.merchant)}</strong> — ${escapeHtml(item.cadence)}${item.amount ? `, ${escapeHtml(String(item.amount))} ${escapeHtml(item.currency ?? '')}` : ''}
      <span class="mind-life-meta">seen ${item.occurrences}×, last ${item.daysSinceLastSeen} day${item.daysSinceLastSeen === 1 ? '' : 's'} ago</span></li>`).join('')}</ul>`);
  }
  if (life.renewals.upcoming.length) {
    parts.push('<h3>Renewals radar — next 90 days</h3>');
    parts.push(`<ul class="mind-life-list">${life.renewals.upcoming.slice(0, 6).map((item) => `
      <li><strong>${escapeHtml(item.merchant)}</strong> — ${item.daysAway <= 0 ? 'due now' : `in ${item.daysAway} day${item.daysAway === 1 ? '' : 's'}`}${item.amount ? ` (${escapeHtml(String(item.amount))} ${escapeHtml(item.currency ?? '')})` : ''}
      <span class="mind-life-meta">${escapeHtml(item.subject)}</span></li>`).join('')}</ul>`);
  }
  if (life.renewals.undated) {
    parts.push(`<p class="mind-note">${life.renewals.undated} renewal notice${life.renewals.undated === 1 ? '' : 's'} without a readable date — check the Memory of the original email.</p>`);
  }
  if (!life.audit.recurring.length && !life.renewals.upcoming.length) {
    parts.push('<p class="mind-note">Records found, but no recurring pattern or upcoming renewal detected yet — that can be honest good news.</p>');
  }
  host.innerHTML = parts.join('');
}

/* Shared streaming distill runner: feeds any status element + feed list. */
async function runDistillStream({ statusEl, feedEl, limit, onConversation, onDone }) {
  const response = await fetch('/api/distill', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...SOVEREIGN_HEADERS() },
    body: JSON.stringify(limit ? { limit } : {}),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || response.statusText);
  }
  let result = { conversations: 0, memoriesAdded: 0, remaining: 0 };
  for await (const packet of sseIterate(response.body)) {
    if (packet.event === 'meta') {
      statusEl.textContent = packet.data.total
        ? `Distilling ${packet.data.total} conversation${packet.data.total === 1 ? '' : 's'} with ${packet.data.provider}/${packet.data.model || 'default model'} — one model call each.`
        : 'Nothing left to distill.';
    } else if (packet.event === 'conversation') {
      const item = document.createElement('li');
      const title = packet.data.title || 'Untitled conversation';
      item.innerHTML = packet.data.facts.length
        ? `<strong>${escapeHtml(title)}</strong> → ${packet.data.facts.map((fact) => escapeHtml(fact)).join(' · ')}`
        : `<span class="quiet">${escapeHtml(title)} — nothing durable</span>`;
      feedEl.appendChild(item);
      feedEl.scrollTop = feedEl.scrollHeight;
      statusEl.textContent = `Swept ${packet.data.index} of ${packet.data.total}…`;
      onConversation?.(packet.data);
    } else if (packet.event === 'done') {
      result = packet.data;
    } else if (packet.event === 'error') {
      throw new Error(`${packet.data.message} (stopped after ${packet.data.completed} conversation${packet.data.completed === 1 ? '' : 's'}; finished ones stay done — run again to resume)`);
    }
  }
  onDone?.(result);
  return result;
}

async function downloadPortfolio() {
  const portfolio = await api.get('/api/portfolio');
  const blob = new Blob([portfolio.markdown], { type: 'text/markdown' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `sovereign-portfolio-${new Date().toISOString().slice(0, 10)}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast('Portfolio downloaded. It contains personal context — treat it like a diary.', { type: 'success' });
}

$('#mind-portfolio-btn').addEventListener('click', () => downloadPortfolio().catch((error) => toast(error.message, { type: 'error', title: 'Portfolio failed' })));
$('#mind-open-memory').addEventListener('click', () => showView('memory'));
$('#mind-arrival-btn').addEventListener('click', () => openArrival());
$('#mind-distill-btn').addEventListener('click', async () => {
  const button = $('#mind-distill-btn');
  const progress = $('#mind-distill-progress');
  const feed = $('#mind-distill-feed');
  button.disabled = true;
  progress.hidden = false;
  feed.replaceChildren();
  try {
    const result = await runDistillStream({ statusEl: $('#mind-distill-status'), feedEl: feed, limit: 500 });
    $('#mind-distill-status').textContent = `Done: ${result.memoriesAdded} new memor${result.memoriesAdded === 1 ? 'y' : 'ies'} from ${result.conversations} conversation${result.conversations === 1 ? '' : 's'}.`;
    await Promise.allSettled([loadMind(), loadMemories(), refreshCounts()]);
  } catch (error) {
    $('#mind-distill-status').textContent = error.message;
    toast(error.message, { type: 'error', title: 'Distillation stopped' });
  } finally {
    button.disabled = false;
  }
});

/* Arrival: drop an export → import → watch memories ignite → reveal */
const ARRIVAL_SEEN_KEY = 'sovereign-arrival-seen';

function arrivalStage(name) {
  for (const stage of ['drop', 'distill', 'reveal']) {
    const element = $(`#arrival-stage-${stage}`);
    element.hidden = stage !== name;
    element.classList.toggle('active', stage === name);
  }
}

function openArrival() {
  try { localStorage.setItem(ARRIVAL_SEEN_KEY, '1'); } catch { /* private browsing */ }
  $('#arrival-drop-error').hidden = true;
  arrivalStage('drop');
  $('#arrival').classList.remove('hidden');
  document.body.classList.add('wizard-open');
  $('#arrival-drop').focus();
}

function closeArrival() {
  $('#arrival').classList.add('hidden');
  document.body.classList.remove('wizard-open');
}

function arrivalDropError(message) {
  const error = $('#arrival-drop-error');
  error.textContent = message;
  error.hidden = false;
}

async function arrivalImport(file) {
  if (!file) return;
  if (file.size > MAX_UPLOAD_BYTES) {
    arrivalDropError(`This export is larger than the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit — run "sovereign import-chat ${file.name}" from the terminal instead; it reads straight from disk.`);
    return;
  }
  arrivalStage('distill');
  const status = $('#arrival-distill-status');
  const feed = $('#arrival-feed');
  const ignition = $('#arrival-ignition');
  feed.replaceChildren();
  ignition.replaceChildren();
  let imported;
  try {
    status.textContent = `Importing ${file.name} — parsed on this machine, nothing leaves it…`;
    const contentBase64 = await fileToBase64(file);
    imported = await api.send('POST', '/api/chat-import', { contentBase64 });
  } catch (error) {
    arrivalStage('drop');
    arrivalDropError(error.message);
    return;
  }

  let ignited = 0;
  const stats = {
    imported: imported.imported,
    skipped: imported.skipped,
    platform: imported.platform,
    memories: 0,
    conversations: 0,
  };
  try {
    const result = await runDistillStream({
      statusEl: status,
      feedEl: feed,
      limit: 500,
      onConversation: (data) => {
        for (const fact of data.facts) {
          if (ignited < 200) {
            const cell = document.createElement('span');
            cell.className = 'mind-cell distilled ignite';
            cell.title = fact;
            ignition.appendChild(cell);
          }
          ignited++;
        }
      },
    });
    stats.memories = result.memoriesAdded;
    stats.conversations = result.conversations;
  } catch (error) {
    // Import succeeded even though distillation stopped — say exactly that.
    arrivalReveal(stats, { distillError: error.message });
    return;
  }
  arrivalReveal(stats);
  Promise.allSettled([loadMind(), loadMemories(), refreshCounts(), loadConversations()]);
}

async function arrivalReveal(stats, { distillError } = {}) {
  arrivalStage('reveal');
  const pieces = [`Imported ${stats.imported} conversation${stats.imported === 1 ? '' : 's'} from ${stats.platform}${stats.skipped ? ` (${stats.skipped} already here)` : ''}.`];
  if (stats.memories) pieces.push(`Distilled ${stats.memories} durable memor${stats.memories === 1 ? 'y' : 'ies'} — every one names the conversation it came from.`);
  else if (!distillError) pieces.push('Nothing new was durable enough to keep — your AI does not pad its memory to look smart.');
  $('#arrival-reveal-stats').textContent = pieces.join(' ');
  $('#arrival-reveal-note').textContent = distillError
    ? `Distillation stopped early: ${distillError}`
    : 'Review, edit, or strike any of it — this memory answers to you.';

  const greeting = $('#arrival-greeting');
  greeting.hidden = true;
  if (stats.memories) {
    try {
      const response = await api.send('POST', '/api/ask', {
        message:
          'In two or three warm sentences, greet me by name if you know it and mention two or three specific things you now remember about me. Do not invent anything not in your memory.',
      });
      if (response.answer) {
        greeting.textContent = response.answer;
        greeting.hidden = false;
      }
    } catch { /* The reveal stands on real stats; a greeting is a bonus, not a requirement. */ }
  }
}

$('#arrival-skip').addEventListener('click', closeArrival);
$('#arrival-skip-link').addEventListener('click', closeArrival);
$('#arrival-open-mind').addEventListener('click', () => { closeArrival(); showView('mind'); });
$('#arrival-open-chat').addEventListener('click', () => { closeArrival(); showView('chat'); });
$('#arrival-portfolio').addEventListener('click', () => downloadPortfolio().catch((error) => toast(error.message, { type: 'error', title: 'Portfolio failed' })));
$('#arrival-drop').addEventListener('click', () => $('#arrival-file').click());
$('#arrival-drop').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  $('#arrival-file').click();
});
$('#arrival-drop').addEventListener('dragover', (event) => {
  event.preventDefault();
  $('#arrival-drop').classList.add('over');
});
$('#arrival-drop').addEventListener('dragleave', () => $('#arrival-drop').classList.remove('over'));
$('#arrival-drop').addEventListener('drop', (event) => {
  event.preventDefault();
  $('#arrival-drop').classList.remove('over');
  arrivalImport(event.dataTransfer?.files?.[0]);
});
$('#arrival-file').addEventListener('change', (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  arrivalImport(file);
});

function maybeAutoOpenArrival() {
  let seen = false;
  try { seen = Boolean(localStorage.getItem(ARRIVAL_SEEN_KEY)); } catch { seen = true; }
  if (seen) return;
  if (!state.status?.setupComplete) return;
  if (state.memories.length || state.conversations.length) return;
  openArrival();
}

window.SOVEREIGN_APP = {
  $, $$, api, escapeHtml, formatDate, toast, confirmAction, icon, state, showView,
  loadPersonas, updateRuntimeUI, renderDashboard, refreshCounts,
};

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
    $('#nav-training-count').textContent = status.counts?.training_projects ?? 0;
    await loadPersonas();
    renderConversationList();
    renderDocuments();
    renderMemories();
    renderEmptyChat();
    showView(routeFromHash() || 'mind', { updateHash: true });
    updateRuntimeUI();
    renderDashboard();
    checkProviders().catch(() => {});
    maybeAutoOpenArrival();
  } catch (error) {
    $('#runtime-label').textContent = error.status === 401 ? 'Access token required' : 'Workspace unavailable';
    $('#runtime-detail').textContent = error.status === 401 ? 'Open the secure URL printed by SovereignAI' : error.message;
    $('#runtime-dot').className = 'status-dot bad';
    toast(error.status === 401 ? 'Open the secure #token URL printed in your terminal.' : error.message, { type: 'error', title: 'Could not connect to SovereignAI' });
    renderEmptyChat();
  }
})();
