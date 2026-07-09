const DEFAULT_SERVER = 'http://127.0.0.1:4321';
const log = document.getElementById('log');
const input = document.getElementById('in');
const sendBtn = document.getElementById('send');
let conversationId = null;
let busy = false;

async function serverUrl() {
  const { serverUrl } = await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER });
  return serverUrl.replace(/\/$/, '');
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
    const base = await serverUrl();
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text, conversationId }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);

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
        try { parsed = JSON.parse(data.join('\n')); } catch { continue; }
        if (event === 'meta') conversationId = parsed.conversationId;
        else if (event === 'delta') {
          acc += parsed.text;
          bubble.textContent = acc;
          log.scrollTop = log.scrollHeight;
        } else if (event === 'error') throw new Error(parsed.message);
      }
    }
    if (!acc) bubble.textContent = '(no response)';
  } catch (err) {
    bubble.className = 'msg err';
    bubble.textContent = `⚠️ ${err.message} — is your server running? (sovereign start)`;
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
  chrome.tabs.create({ url: await serverUrl() });
});

const settingsEl = document.getElementById('settings');
const serverInput = document.getElementById('server-url');
document.getElementById('toggle-settings').addEventListener('click', async (e) => {
  e.preventDefault();
  settingsEl.style.display = settingsEl.style.display === 'block' ? 'none' : 'block';
  serverInput.value = await serverUrl();
});
serverInput?.addEventListener('change', () => {
  chrome.storage.sync.set({ serverUrl: serverInput.value.trim() || DEFAULT_SERVER });
});
