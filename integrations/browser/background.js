/* SovereignAI browser extension — background worker.
   Context menu actions that feed your private AI. Talks only to your own server. */

const DEFAULT_SERVER = 'http://127.0.0.1:4321';

async function serverUrl() {
  const { serverUrl } = await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER });
  return serverUrl.replace(/\/$/, '');
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
  const base = await serverUrl();
  try {
    if (info.menuItemId === 'sovereign-save-knowledge') {
      const name = `${tab?.title ?? 'Web clip'} — ${new URL(info.pageUrl).hostname}`;
      const content = `Source: ${info.pageUrl}\n\n${text}`;
      await post(`${base}/api/documents`, { name, content });
      flashBadge('✓');
    } else if (info.menuItemId === 'sovereign-remember') {
      await post(`${base}/api/memories`, { content: text });
      flashBadge('✓');
    }
  } catch {
    flashBadge('!');
  }
});

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** Visual feedback on the toolbar icon: ✓ saved, ! error. */
function flashBadge(text) {
  chrome.action.setBadgeBackgroundColor({ color: text === '!' ? '#e5534b' : '#4ac26b' });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
}
