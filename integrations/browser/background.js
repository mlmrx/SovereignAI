/* SovereignAI browser extension — background worker.
   Context menu actions that feed your private AI. Talks only to your own server. */

const DEFAULT_SERVER = 'http://127.0.0.1:4321';

hardenTokenStorage();

async function hardenTokenStorage() {
  try {
    await chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // Firefox and older Chromium builds already keep storage.local inside the extension.
  }
}

async function serverUrl() {
  const { serverUrl = DEFAULT_SERVER } = await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER });
  const parsed = new URL(String(serverUrl).trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Invalid SovereignAI server URL');
  if (parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('Invalid SovereignAI server URL');
  }
  return parsed.origin;
}

async function authToken(base) {
  const { authTokens = {} } = await chrome.storage.local.get({ authTokens: {} });
  if (!authTokens || typeof authTokens !== 'object' || Array.isArray(authTokens)) return '';
  return typeof authTokens[base] === 'string' ? authTokens[base] : '';
}

function hasBuiltInPermission(base) {
  const parsed = new URL(base);
  return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
}

async function requireServerPermission(base) {
  if (hasBuiltInPermission(base)) return;
  const parsed = new URL(base);
  const granted = await chrome.permissions?.contains?.({ origins: [`${parsed.protocol}//${parsed.hostname}/*`] });
  if (!granted) throw new Error('Open SovereignAI extension settings and save this server to grant browser access.');
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'sovereign-save-knowledge',
    title: 'Save selection to SovereignAI knowledge',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'sovereign-remember',
    title: 'Remember with SovereignAI (long-term memory)',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const text = info.selectionText?.trim();
  if (!text) return;
  try {
    const base = await serverUrl();
    if (info.menuItemId === 'sovereign-save-knowledge') {
      const name = `${tab?.title ?? 'Web clip'} — ${new URL(info.pageUrl).hostname}`;
      const content = `Source: ${info.pageUrl}\n\n${text}`;
      await post(`${base}/api/documents`, { name, content });
      flashBadge('✓');
    } else if (info.menuItemId === 'sovereign-remember') {
      await post(`${base}/api/memories`, { content: text });
      flashBadge('✓');
    }
  } catch (err) {
    flashBadge('!', err.message);
  }
});

async function post(url, body) {
  const base = new URL(url).origin;
  await requireServerPermission(base);
  const token = await authToken(base);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** Visual feedback on the toolbar icon: ✓ saved, ! error. */
function flashBadge(text, detail = '') {
  chrome.action.setBadgeBackgroundColor({ color: text === '!' ? '#e5534b' : '#4ac26b' });
  chrome.action.setBadgeText({ text });
  chrome.action.setTitle({ title: detail ? `SovereignAI: ${detail}` : 'SovereignAI' });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'SovereignAI' });
  }, 2500);
}
