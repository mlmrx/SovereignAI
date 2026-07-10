'use strict';

const crypto = require('node:crypto');
const vscode = require('vscode');
const {
  ApiError,
  ChatSession,
  DEFAULT_SERVER_URL,
  isLoopbackUrl,
  normalizeServerUrl,
  normalizeToken,
  parseSse,
  responseError,
  tokenStorageKey,
} = require('./core');

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CHAT_CHARS = 200_000;
const MAX_MEMORY_CHARS = 2_000;

let chatPanel = null;
let panelReady = false;
let pendingPanelMessages = [];
let secretStorage = null;
const chatSession = new ChatSession();

function settings() {
  const config = vscode.workspace.getConfiguration('sovereignai');
  return {
    serverUrl: normalizeServerUrl(config.get('serverUrl') || DEFAULT_SERVER_URL),
    persona: String(config.get('persona') || '').trim(),
  };
}

async function authToken(serverUrl) {
  if (!secretStorage) return '';
  return (await secretStorage.get(tokenStorageKey(serverUrl))) || '';
}

async function requestHeaders(serverUrl, { json = false, accept = 'application/json' } = {}) {
  const token = await authToken(serverUrl);
  return {
    accept,
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function apiFetch(path, options = {}) {
  const { serverUrl } = settings();
  const headers = await requestHeaders(serverUrl, {
    json: typeof options.body === 'string',
    accept: options.accept,
  });
  return fetch(`${serverUrl}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
}

function linkedRequest(externalSignal, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) onAbort();
  else externalSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Request timed out'));
  }, timeoutMs) : null;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    },
  };
}

async function requestJson(path, options = {}) {
  const {
    signal: externalSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
    ...requestOptions
  } = options;
  const linked = linkedRequest(externalSignal, timeoutMs);
  try {
    const response = await apiFetch(path, { ...requestOptions, signal: linked.signal });
    if (!response.ok) throw await responseError(response);
    try {
      return await response.json();
    } catch {
      throw new ApiError('The server returned an invalid JSON response.', response.status);
    }
  } catch (error) {
    if (linked.timedOut()) throw new Error(`The server did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
    throw error;
  } finally {
    linked.cleanup();
  }
}

async function resolvePersonaId(signal) {
  const { persona } = settings();
  if (!persona) return undefined;
  const personas = await requestJson('/api/personas', { signal });
  if (!Array.isArray(personas)) throw new Error('The server returned an invalid persona list.');
  const match = personas.find((entry) => String(entry?.name || '').toLowerCase() === persona.toLowerCase());
  if (!match) throw new Error(`Persona “${persona}” was not found. Update sovereignai.persona or leave it blank.`);
  return match.id;
}

async function activate(context) {
  secretStorage = context.secrets;
  context.subscriptions.push(
    vscode.commands.registerCommand('sovereignai.openChat', openChat),
    vscode.commands.registerCommand('sovereignai.askSelection', askSelection),
    vscode.commands.registerCommand('sovereignai.saveSelectionToKnowledge', saveSelectionToKnowledge),
    vscode.commands.registerCommand('sovereignai.remember', remember),
    vscode.commands.registerCommand('sovereignai.setAuthToken', setAuthToken),
    vscode.commands.registerCommand('sovereignai.clearAuthToken', clearAuthToken),
    vscode.commands.registerCommand('sovereignai.testConnection', testConnection),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('sovereignai')) return;
      chatSession.reset();
      post({ type: 'reset' });
      void refreshConnectionState();
    })
  );
  await migrateLegacyToken(context);
}

async function migrateLegacyToken(context) {
  const config = vscode.workspace.getConfiguration('sovereignai');
  const inspected = config.inspect('authToken');
  if (!inspected) return;
  const legacy = typeof inspected.globalValue === 'string' ? inspected.globalValue.trim() : '';
  const hasLegacyValue = ['globalValue', 'workspaceValue', 'workspaceFolderValue']
    .some((field) => inspected[field] !== undefined);
  if (!hasLegacyValue) return;

  try {
    const server = config.inspect('serverUrl') || {};
    const globalServer = server.globalValue || server.defaultValue || DEFAULT_SERVER_URL;
    // Only a user/global legacy token is trusted. Repository-controlled
    // workspace/folder values are deleted below without ever entering
    // SecretStorage or being sent to the machine-scoped server URL.
    if (legacy) await context.secrets.store(tokenStorageKey(globalServer), normalizeToken(legacy));
    const targets = [
      ['workspaceFolderValue', vscode.ConfigurationTarget.WorkspaceFolder],
      ['workspaceValue', vscode.ConfigurationTarget.Workspace],
      ['globalValue', vscode.ConfigurationTarget.Global],
    ];
    for (const [field, target] of targets) {
      if (inspected[field] !== undefined) await config.update('authToken', undefined, target);
    }
    if (legacy) {
      vscode.window.showInformationMessage('SovereignAI moved your bearer token from user settings into VS Code SecretStorage.');
    } else {
      vscode.window.showInformationMessage('SovereignAI removed an insecure workspace-scoped legacy token setting.');
    }
  } catch (error) {
    vscode.window.showWarningMessage(`SovereignAI could not migrate the old token setting: ${error.message}`);
  }
}

function openChat() {
  if (chatPanel) {
    chatPanel.reveal(vscode.ViewColumn.Beside);
    return chatPanel;
  }

  chatPanel = vscode.window.createWebviewPanel('sovereignai.chat', 'SovereignAI', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [],
  });
  panelReady = false;
  pendingPanelMessages = [];
  chatPanel.webview.html = webviewHtml(chatPanel.webview);
  chatPanel.onDidDispose(() => {
    chatSession.reset();
    chatPanel = null;
    panelReady = false;
    pendingPanelMessages = [];
  });
  chatPanel.webview.onDidReceiveMessage((message) => void handleWebviewMessage(message));
  return chatPanel;
}

async function handleWebviewMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'ready') {
    panelReady = true;
    for (const pending of pendingPanelMessages.splice(0)) void post(pending);
    await refreshConnectionState();
  } else if (message.type === 'send') {
    await streamChat(message.text);
  } else if (message.type === 'stop') {
    if (chatSession.stop()) post({ type: 'status', text: 'Stopping generation…' });
  } else if (message.type === 'newChat') {
    chatSession.reset();
    post({ type: 'reset' });
  } else if (message.type === 'openSettings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:sovereignai.sovereignai');
  } else if (message.type === 'setToken') {
    await setAuthToken();
  }
}

function post(message) {
  return chatPanel?.webview.postMessage(message);
}

function queuePanelMessage(message) {
  if (panelReady) void post(message);
  else pendingPanelMessages.push(message);
}

async function refreshConnectionState() {
  if (!chatPanel || !panelReady) return;
  try {
    const { serverUrl, persona } = settings();
    post({
      type: 'connection',
      serverUrl,
      persona: persona || 'server default',
      tokenSaved: Boolean(await authToken(serverUrl)),
      insecureRemote: !isLoopbackUrl(serverUrl) && serverUrl.startsWith('http:'),
    });
  } catch (error) {
    post({ type: 'connectionError', text: error.message });
  }
}

async function streamChat(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return;
  if (text.length > MAX_CHAT_CHARS) {
    post({ type: 'notice', level: 'error', text: `Messages are limited to ${MAX_CHAT_CHARS.toLocaleString()} characters.` });
    return;
  }

  const run = chatSession.begin();
  if (!run) {
    post({ type: 'notice', level: 'warning', text: 'A response is already in progress. Stop it before sending another message.' });
    return;
  }

  post({ type: 'user', streamId: run.id, text });
  post({ type: 'start', streamId: run.id });
  let connectTimer = null;
  let connectTimedOut = false;
  let sawDone = false;
  let sawDelta = false;
  let streamError = '';

  try {
    const personaId = await resolvePersonaId(run.controller.signal);
    if (!chatSession.isCurrent(run)) return;
    connectTimer = setTimeout(() => {
      connectTimedOut = true;
      run.controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const response = await apiFetch('/api/chat', {
      method: 'POST',
      accept: 'text/event-stream',
      signal: run.controller.signal,
      body: JSON.stringify({
        message: text,
        conversationId: chatSession.conversationId,
        personaId,
      }),
    });
    clearTimeout(connectTimer);
    connectTimer = null;
    if (!response.ok) throw await responseError(response);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      throw new Error('The server returned a non-streaming response for chat.');
    }

    for await (const packet of parseSse(response.body)) {
      if (!chatSession.isCurrent(run)) return;
      if (packet.event === 'meta') {
        chatSession.setConversation(run, packet.data.conversationId);
        post({
          type: 'meta',
          streamId: run.id,
          model: `${packet.data.persona || 'Assistant'} · ${packet.data.provider || 'provider'}/${packet.data.model || 'default'}`,
        });
      } else if (packet.event === 'delta') {
        const delta = typeof packet.data.text === 'string' ? packet.data.text : '';
        if (delta) {
          sawDelta = true;
          post({ type: 'delta', streamId: run.id, text: delta });
        }
      } else if (packet.event === 'done') {
        sawDone = true;
      } else if (packet.event === 'error' || packet.event === 'protocol-error') {
        streamError = packet.data.message || 'The model request was interrupted.';
      }
    }

    if (streamError) {
      post({ type: 'streamError', streamId: run.id, text: streamError, hasPartial: sawDelta });
    } else if (!sawDone) {
      throw new Error('The connection closed before the response completed.');
    } else if (!sawDelta) {
      throw new Error('The model returned an empty response.');
    }
    post({ type: 'done', streamId: run.id, status: streamError ? 'Response interrupted' : 'Response complete' });
  } catch (error) {
    if (!chatSession.isCurrent(run)) return;
    if (run.controller.signal.aborted && !connectTimedOut) {
      post({ type: 'done', streamId: run.id, status: 'Generation stopped' });
    } else {
      const message = connectTimedOut
        ? 'The server did not begin responding within 30 seconds.'
        : describeError(error);
      post({ type: 'streamError', streamId: run.id, text: message, hasPartial: sawDelta });
      post({ type: 'done', streamId: run.id, status: 'Response failed' });
    }
  } finally {
    if (connectTimer) clearTimeout(connectTimer);
    chatSession.finish(run);
  }
}

function describeError(error) {
  if (error instanceof ApiError) return error.message;
  if (error?.name === 'AbortError') return 'The request was cancelled.';
  if (error instanceof TypeError) {
    try {
      return `Could not reach ${settings().serverUrl}. Start SovereignAI or check the configured server URL.`;
    } catch {
      return 'Could not reach the configured SovereignAI server.';
    }
  }
  return error?.message || 'The request failed.';
}

async function askSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showInformationMessage('Select some code or text first.');
    return;
  }
  const question = await vscode.window.showInputBox({
    prompt: 'Ask SovereignAI about the selection',
    placeHolder: 'For example: What does this do? Are there any bugs?',
    ignoreFocusOut: true,
  });
  if (question === undefined) return;
  const selection = editor.document.getText(editor.selection);
  const language = editor.document.languageId;
  const prompt = `${question.trim() || 'Explain this.'}\n\n\`\`\`${language}\n${selection}\n\`\`\``;
  if (prompt.length > MAX_CHAT_CHARS) {
    vscode.window.showErrorMessage(`SovereignAI messages are limited to ${MAX_CHAT_CHARS.toLocaleString()} characters. Select a smaller range.`);
    return;
  }
  openChat();
  queuePanelMessage({ type: 'prefill', text: prompt, send: true });
}

async function saveSelectionToKnowledge() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showInformationMessage('Select some code or text first.');
    return;
  }
  const name = `${vscode.workspace.asRelativePath(editor.document.uri)} (lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1})`;
  try {
    const document = await requestJson('/api/documents', {
      method: 'POST',
      // Ingestion is not idempotent. Do not time out locally: a retry after the
      // server commits could otherwise create a duplicate document.
      timeoutMs: 0,
      body: JSON.stringify({ name, content: editor.document.getText(editor.selection) }),
    });
    vscode.window.showInformationMessage(`Saved to SovereignAI knowledge: ${document.name} (${document.chunk_count} chunks).`);
  } catch (error) {
    await showCommandError(error);
  }
}

async function remember() {
  const note = await vscode.window.showInputBox({
    prompt: 'What should SovereignAI remember long-term?',
    placeHolder: 'For example: This project uses pnpm, not npm.',
    ignoreFocusOut: true,
    validateInput: (value) => value.length > MAX_MEMORY_CHARS ? `Memories are limited to ${MAX_MEMORY_CHARS.toLocaleString()} characters.` : undefined,
  });
  if (!note?.trim()) return;
  try {
    await requestJson('/api/memories', {
      method: 'POST',
      body: JSON.stringify({ content: note.trim() }),
    });
    vscode.window.showInformationMessage('Saved to SovereignAI memory.');
  } catch (error) {
    await showCommandError(error);
  }
}

async function setAuthToken() {
  let serverUrl;
  try {
    ({ serverUrl } = settings());
  } catch (error) {
    await showCommandError(error);
    return;
  }
  const existing = await authToken(serverUrl);
  const value = await vscode.window.showInputBox({
    title: 'SovereignAI bearer token',
    prompt: `${existing ? 'Replace' : 'Save'} the token for ${serverUrl}. It is stored in VS Code SecretStorage, not settings.`,
    password: true,
    ignoreFocusOut: true,
    placeHolder: existing ? 'Enter a replacement token' : 'Paste SOVEREIGN_TOKEN',
    validateInput: (input) => {
      if (!input.trim()) return 'Enter a bearer token.';
      if (/\r|\n/.test(input)) return 'The token cannot contain line breaks.';
      return undefined;
    },
  });
  if (value === undefined) return;
  try {
    await secretStorage.store(tokenStorageKey(serverUrl), normalizeToken(value));
    vscode.window.showInformationMessage(`SovereignAI bearer token saved securely for ${serverUrl}.`);
    await refreshConnectionState();
  } catch (error) {
    await showCommandError(error);
  }
}

async function clearAuthToken() {
  let serverUrl;
  try {
    ({ serverUrl } = settings());
  } catch (error) {
    await showCommandError(error);
    return;
  }
  if (!(await authToken(serverUrl))) {
    vscode.window.showInformationMessage(`No SovereignAI bearer token is saved for ${serverUrl}.`);
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Forget the SovereignAI bearer token for ${serverUrl}?`,
    { modal: true },
    'Forget token'
  );
  if (choice !== 'Forget token') return;
  await secretStorage.delete(tokenStorageKey(serverUrl));
  vscode.window.showInformationMessage(`SovereignAI bearer token removed for ${serverUrl}.`);
  await refreshConnectionState();
}

async function testConnection() {
  try {
    const status = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Testing SovereignAI connection…', cancellable: true },
      async (_progress, cancellation) => {
        const controller = new AbortController();
        const subscription = cancellation.onCancellationRequested(() => controller.abort());
        try {
          return await requestJson('/api/status', { signal: controller.signal });
        } finally {
          subscription.dispose();
        }
      }
    );
    const model = status?.defaults?.model ? ` · ${status.defaults.provider || 'provider'}/${status.defaults.model}` : '';
    vscode.window.showInformationMessage(`Connected to ${status.name || 'SovereignAI'} v${status.version || 'unknown'}${model}.`);
  } catch (error) {
    if (error?.name !== 'AbortError') await showCommandError(error);
  }
}

async function showCommandError(error) {
  const message = `SovereignAI: ${describeError(error)}`;
  const actions = error instanceof ApiError && error.status === 401
    ? ['Set bearer token', 'Open settings']
    : ['Open settings'];
  const choice = await vscode.window.showErrorMessage(message, ...actions);
  if (choice === 'Set bearer token') await setAuthToken();
  if (choice === 'Open settings') await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:sovereignai.sovereignai');
}

function webviewHtml(webview) {
  const nonce = crypto.randomBytes(18).toString('base64');
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<style nonce="${nonce}">
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; display: flex; flex-direction: column; height: 100vh; font-size: 13px; }
  #head { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 8px; justify-content: space-between; align-items: center; }
  #identity { min-width: 0; }
  #title { font-weight: 600; }
  #connection, #model { opacity: 0.7; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #head-actions { display: flex; gap: 2px; }
  #log { flex: 1; overflow-y: auto; padding: 12px; }
  .empty { opacity: 0.72; max-width: 45rem; margin: 18vh auto 0; text-align: center; line-height: 1.55; }
  .msg { margin-bottom: 14px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
  .msg.user { color: var(--vscode-textLink-foreground); }
  .msg.user::before { content: "you  "; opacity: 0.6; font-size: 11px; }
  .msg.ai::before { content: "AI  "; opacity: 0.7; font-size: 11px; }
  .msg.err { color: var(--vscode-errorForeground); }
  #status { min-height: 20px; padding: 2px 12px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  #bar { display: flex; gap: 6px; align-items: flex-end; padding: 8px 12px 10px; border-top: 1px solid var(--vscode-panel-border); }
  textarea { flex: 1; min-height: 32px; max-height: 180px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 7px 8px; font: inherit; }
  textarea:focus, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 3px; padding: 7px 12px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: transparent; color: var(--vscode-foreground); }
  button:disabled { cursor: default; opacity: 0.55; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <header id="head">
    <div id="identity"><div id="title">SovereignAI</div><div id="connection">Checking connection settings…</div><div id="model"></div></div>
    <div id="head-actions">
      <button id="token" class="secondary" title="Set bearer token" aria-label="Set bearer token">Token</button>
      <button id="settings" class="secondary" title="Open extension settings" aria-label="Open extension settings">Settings</button>
      <button id="new" class="secondary" title="Start a new conversation" aria-label="Start a new conversation">New</button>
    </div>
  </header>
  <main id="log" aria-live="polite" aria-busy="false"><div class="empty">Ask a question, or use “SovereignAI: Ask About Selection” from the command palette. Responses use the provider configured on your SovereignAI server.</div></main>
  <div id="status" role="status" aria-live="polite"></div>
  <div id="bar">
    <label for="in" hidden>Message</label>
    <textarea id="in" rows="2" maxlength="${MAX_CHAT_CHARS}" placeholder="Ask anything… (Enter to send)"></textarea>
    <button id="send">Send</button>
    <button id="stop" hidden>Stop</button>
  </div>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('in');
  const sendButton = document.getElementById('send');
  const stopButton = document.getElementById('stop');
  const status = document.getElementById('status');
  let current = null;
  let accumulated = '';
  let activeStreamId = null;
  let busy = false;

  function removeEmpty() { log.querySelector('.empty')?.remove(); }
  function add(className, text) {
    removeEmpty();
    const element = document.createElement('div');
    element.className = 'msg ' + className;
    element.textContent = text;
    log.appendChild(element);
    log.scrollTop = log.scrollHeight;
    return element;
  }
  function setBusy(next) {
    busy = next;
    sendButton.hidden = next;
    stopButton.hidden = !next;
    input.disabled = next;
    log.setAttribute('aria-busy', String(next));
  }
  function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    vscodeApi.postMessage({ type: 'send', text });
  }
  function resetConversation() {
    // Keep a sentinel until the next host-confirmed user event so packets from
    // an aborted request cannot repopulate a freshly reset conversation.
    activeStreamId = -1;
    current = null;
    accumulated = '';
    setBusy(false);
    log.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'New conversation ready.';
    log.appendChild(empty);
    document.getElementById('model').textContent = '';
    status.textContent = 'New conversation';
    input.focus();
  }

  sendButton.addEventListener('click', send);
  stopButton.addEventListener('click', () => vscodeApi.postMessage({ type: 'stop' }));
  document.getElementById('new').addEventListener('click', () => {
    resetConversation();
    vscodeApi.postMessage({ type: 'newChat' });
  });
  document.getElementById('settings').addEventListener('click', () => vscodeApi.postMessage({ type: 'openSettings' }));
  document.getElementById('token').addEventListener('click', () => vscodeApi.postMessage({ type: 'setToken' }));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'connection') {
      const auth = message.tokenSaved ? 'token saved' : 'no saved token';
      const warning = message.insecureRemote ? ' · remote HTTP can expose credentials' : '';
      document.getElementById('connection').textContent = message.serverUrl + ' · ' + message.persona + ' · ' + auth + warning;
      return;
    }
    if (message.type === 'connectionError') {
      document.getElementById('connection').textContent = message.text;
      return;
    }
    if (message.type === 'prefill') {
      input.value = message.text;
      input.focus();
      if (message.send && !busy) send();
      return;
    }
    if (message.type === 'reset') { resetConversation(); return; }
    if (message.type === 'status') { status.textContent = message.text; return; }
    if (message.type === 'notice') { add(message.level === 'error' ? 'err' : 'ai', message.text); return; }
    if (message.streamId != null && activeStreamId != null && message.streamId !== activeStreamId && message.type !== 'user') return;
    if (message.type === 'user') {
      activeStreamId = message.streamId;
      add('user', message.text);
    } else if (message.type === 'start') {
      activeStreamId = message.streamId;
      accumulated = '';
      current = add('ai', 'Generating…');
      status.textContent = 'Generating response';
      setBusy(true);
    } else if (message.type === 'meta') {
      document.getElementById('model').textContent = message.model;
    } else if (message.type === 'delta') {
      accumulated += message.text;
      if (current) current.textContent = accumulated;
      log.scrollTop = log.scrollHeight;
    } else if (message.type === 'streamError') {
      if (message.hasPartial) add('err', 'Response interrupted: ' + message.text);
      else if (current) { current.className = 'msg err'; current.textContent = message.text; }
      else add('err', message.text);
    } else if (message.type === 'done') {
      current = null;
      accumulated = '';
      activeStreamId = null;
      status.textContent = message.status || 'Response complete';
      setBusy(false);
      input.focus();
    }
  });
  vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

function deactivate() {
  chatSession.reset();
}

module.exports = { activate, deactivate };
