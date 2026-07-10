const DEFAULT_SERVER = 'http://127.0.0.1:4321';
const log = document.getElementById('log');
const input = document.getElementById('in');
const sendBtn = document.getElementById('send');
const settingsEl = document.getElementById('settings');
const serverInput = document.getElementById('server-url');
const tokenInput = document.getElementById('auth-token');
const settingsStatus = document.getElementById('settings-status');
const clearTokenBtn = document.getElementById('clear-token');
let conversationId = null;
let busy = false;

// Keep secrets unavailable to any future content scripts. Firefox does not yet
// expose setAccessLevel, so guard the Chrome-only hardening call.
hardenTokenStorage();

async function hardenTokenStorage() {
  try {
    await chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // storage.local is already extension-only when this API is unavailable
  }
}

async function storedServerUrl() {
  const { serverUrl = DEFAULT_SERVER } = await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER });
  return serverUrl;
}

async function serverUrl() {
  return normalizeServerUrl(await storedServerUrl());
}

async function authTokens() {
  const { authTokens = {} } = await chrome.storage.local.get({ authTokens: {} });
  return authTokens && typeof authTokens === 'object' && !Array.isArray(authTokens) ? authTokens : {};
}

async function authToken(base) {
  const origin = base ?? await serverUrl();
  const tokens = await authTokens();
  return typeof tokens[origin] === 'string' ? tokens[origin] : '';
}

function normalizeServerUrl(value) {
  const raw = String(value || DEFAULT_SERVER).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Enter a valid server URL, such as http://100.64.0.5:4321');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Server URL must use http:// or https://');
  }
  if (parsed.username || parsed.password) throw new Error('Do not put credentials in the server URL; use the bearer-token field.');
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('Enter only the server origin, without a path, query, or fragment.');
  }
  return parsed.origin;
}

function permissionPattern(base) {
  const parsed = new URL(base);
  // Browser match patterns do not scope host permissions by port. Request the
  // narrowest supported pattern: this scheme + host, across its ports.
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

function hasBuiltInPermission(base) {
  const parsed = new URL(base);
  return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
}

async function requireServerPermission(base) {
  if (hasBuiltInPermission(base)) return;
  const granted = await chrome.permissions?.contains?.({ origins: [permissionPattern(base)] });
  if (!granted) throw new Error('Browser access to this server is not granted. Open server settings and click Save.');
}

async function requestServerPermission(base) {
  if (hasBuiltInPermission(base)) return true;
  if (!chrome.permissions?.request) throw new Error('This browser cannot request access to a custom server origin.');
  return chrome.permissions.request({ origins: [permissionPattern(base)] });
}

async function removeOldServerPermission(previous, next) {
  if (
    !previous ||
    previous === next ||
    permissionPattern(previous) === permissionPattern(next) ||
    hasBuiltInPermission(previous) ||
    !chrome.permissions?.remove
  ) return;
  try {
    await chrome.permissions.remove({ origins: [permissionPattern(previous)] });
  } catch {
    // The old origin may have been granted to another extension feature; a
    // failed cleanup must not undo the newly saved server.
  }
}

async function apiHeaders(base) {
  const token = await authToken(base);
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function apiFetch(path, options = {}) {
  const base = await serverUrl();
  await requireServerPermission(base);
  return fetch(`${base}${path}`, {
    ...options,
    headers: { ...(await apiHeaders(base)), ...(options.headers ?? {}) },
  });
}

function add(cls, text) {
  document.getElementById('empty')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = '';
  busy = true;
  sendBtn.disabled = true;
  add('user', text);
  const bubble = add('ai', '…');
  try {
    const res = await apiFetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message: text, conversationId }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Server returned HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let acc = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = 'message';
        const data = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        let parsed;
        try {
          parsed = JSON.parse(data.join('\n'));
        } catch {
          continue;
        }
        if (event === 'meta') conversationId = parsed.conversationId;
        else if (event === 'delta') {
          acc += parsed.text;
          bubble.textContent = acc;
          log.scrollTop = log.scrollHeight;
        } else if (event === 'error') {
          throw new Error(parsed.message);
        }
      }
    }
    if (!acc) bubble.textContent = '(no response)';
  } catch (err) {
    bubble.className = 'msg err';
    bubble.textContent = `⚠️ ${err.message}`;
  } finally {
    busy = false;
    sendBtn.disabled = false;
  }
}

sendBtn.addEventListener('click', send);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

document.getElementById('open-ui').addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    const base = await serverUrl();
    const token = await authToken(base);
    chrome.tabs.create({ url: `${base}/${token ? `#token=${encodeURIComponent(token)}` : ''}` });
  } catch (err) {
    setSettingsStatus(err.message, 'err');
    settingsEl.style.display = 'block';
  }
});

document.getElementById('toggle-settings').addEventListener('click', async (e) => {
  e.preventDefault();
  const opening = settingsEl.style.display !== 'block';
  settingsEl.style.display = opening ? 'block' : 'none';
  if (opening) await renderSettings();
});

document.getElementById('save-settings').addEventListener('click', saveSettings);
clearTokenBtn.addEventListener('click', async () => {
  const base = await serverUrl();
  const tokens = await authTokens();
  delete tokens[base];
  await chrome.storage.local.set({ authTokens: tokens });
  await chrome.storage.local.remove('authToken'); // discard unscoped pre-v0.3 storage
  tokenInput.value = '';
  await renderTokenState();
  setSettingsStatus('Saved bearer token removed from this browser.', 'ok');
});

async function renderSettings() {
  serverInput.value = await storedServerUrl();
  await renderTokenState();
  setSettingsStatus('', '');
}

async function renderTokenState() {
  const saved = Boolean(await authToken());
  tokenInput.value = '';
  tokenInput.placeholder = saved ? 'Saved locally — leave blank to keep' : 'Paste the token printed by SovereignAI';
  clearTokenBtn.disabled = !saved;
}

async function saveSettings() {
  setSettingsStatus('', '');
  let next;
  try {
    next = normalizeServerUrl(serverInput.value || DEFAULT_SERVER);
    // Keep this permission request as the first async operation in the click
    // handler so browsers retain the required user activation.
    const granted = await requestServerPermission(next);
    if (!granted) throw new Error(`Access to ${next} was not granted; server settings were not changed.`);

    let previous = null;
    try {
      previous = await serverUrl();
    } catch {
      // A malformed legacy value can be safely replaced.
    }
    const enteredToken = tokenInput.value.trim();
    await chrome.storage.sync.set({ serverUrl: next });
    if (enteredToken) {
      const tokens = await authTokens();
      tokens[next] = enteredToken;
      await chrome.storage.local.set({ authTokens: tokens });
    }
    await chrome.storage.local.remove('authToken'); // never send an unscoped legacy token
    await removeOldServerPermission(previous, next);
    serverInput.value = next;
    await renderTokenState();
    setSettingsStatus('Server saved. Requests use only this configured URL.', 'ok');
  } catch (err) {
    setSettingsStatus(err.message, 'err');
  }
}

function setSettingsStatus(message, kind) {
  settingsStatus.textContent = message;
  settingsStatus.className = kind;
}
