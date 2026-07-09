const vscode = require('vscode');

let chatPanel = null;
let conversationId = null;

function cfg() {
  const c = vscode.workspace.getConfiguration('sovereignai');
  return {
    serverUrl: (c.get('serverUrl') || 'http://127.0.0.1:4321').replace(/\/$/, ''),
    persona: c.get('persona') || '',
    authToken: c.get('authToken') || '',
  };
}

function headers() {
  const h = { 'content-type': 'application/json' };
  const { authToken } = cfg();
  if (authToken) h.authorization = `Bearer ${authToken}`;
  return h;
}

async function resolvePersonaId() {
  const { serverUrl, persona } = cfg();
  if (!persona) return undefined;
  try {
    const res = await fetch(`${serverUrl}/api/personas`, { headers: headers() });
    const personas = await res.json();
    return personas.find((p) => p.name.toLowerCase() === persona.toLowerCase())?.id;
  } catch {
    return undefined;
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sovereignai.openChat', () => openChat()),
    vscode.commands.registerCommand('sovereignai.askSelection', askSelection),
    vscode.commands.registerCommand('sovereignai.saveSelectionToKnowledge', saveSelectionToKnowledge),
    vscode.commands.registerCommand('sovereignai.remember', remember)
  );
}

function openChat() {
  if (chatPanel) {
    chatPanel.reveal(vscode.ViewColumn.Beside);
    return chatPanel;
  }
  chatPanel = vscode.window.createWebviewPanel('sovereignai.chat', '⬡ SovereignAI', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  chatPanel.webview.html = webviewHtml();
  chatPanel.onDidDispose(() => {
    chatPanel = null;
  });
  chatPanel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'send') await streamChat(msg.text);
    if (msg.type === 'newChat') conversationId = null;
  });
  return chatPanel;
}

async function streamChat(text) {
  const { serverUrl } = cfg();
  const post = (m) => chatPanel?.webview.postMessage(m);
  post({ type: 'user', text });
  post({ type: 'start' });
  try {
    const personaId = await resolvePersonaId();
    const res = await fetch(`${serverUrl}/api/chat`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ message: text, conversationId, personaId }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);

    const reader = res.body.getReader();
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
        if (event === 'meta') {
          conversationId = parsed.conversationId;
          post({ type: 'meta', model: `${parsed.persona} · ${parsed.provider}/${parsed.model || 'default'}` });
        } else if (event === 'delta') {
          post({ type: 'delta', text: parsed.text });
        } else if (event === 'error') {
          post({ type: 'error', text: parsed.message });
        }
      }
    }
    post({ type: 'done' });
  } catch (err) {
    post({ type: 'error', text: `${err.message} — is the server running? (sovereign start)` });
    post({ type: 'done' });
  }
}

async function askSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showInformationMessage('Select some code or text first.');
    return;
  }
  const question = await vscode.window.showInputBox({
    prompt: 'Ask your sovereign AI about the selection',
    placeHolder: 'e.g. What does this do? Any bugs?',
  });
  if (question === undefined) return;
  const selection = editor.document.getText(editor.selection);
  const lang = editor.document.languageId;
  openChat();
  // give the webview a beat to initialize before streaming
  setTimeout(() => streamChat(`${question || 'Explain this.'}\n\n\`\`\`${lang}\n${selection}\n\`\`\``), 300);
}

async function saveSelectionToKnowledge() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showInformationMessage('Select some code or text first.');
    return;
  }
  const { serverUrl } = cfg();
  const name = `${vscode.workspace.asRelativePath(editor.document.uri)} (lines ${editor.selection.start.line + 1}–${editor.selection.end.line + 1})`;
  try {
    const res = await fetch(`${serverUrl}/api/documents`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name, content: editor.document.getText(editor.selection) }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const doc = await res.json();
    vscode.window.showInformationMessage(`⬡ Saved to your AI's knowledge: ${doc.name} (${doc.chunk_count} chunks)`);
  } catch (err) {
    vscode.window.showErrorMessage(`SovereignAI: ${err.message}`);
  }
}

async function remember() {
  const note = await vscode.window.showInputBox({
    prompt: 'What should your sovereign AI remember long-term?',
    placeHolder: 'e.g. This project uses pnpm, not npm.',
  });
  if (!note) return;
  const { serverUrl } = cfg();
  try {
    const res = await fetch(`${serverUrl}/api/memories`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ content: note }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    vscode.window.showInformationMessage('⬡ Remembered.');
  } catch (err) {
    vscode.window.showErrorMessage(`SovereignAI: ${err.message}`);
  }
}

function webviewHtml() {
  return /* html */ `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: dark light; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background);
         margin: 0; display: flex; flex-direction: column; height: 100vh; font-size: 13px; }
  #head { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; justify-content: space-between; align-items: center; }
  #model { opacity: 0.6; font-size: 11px; font-family: var(--vscode-editor-font-family); }
  #log { flex: 1; overflow-y: auto; padding: 12px; }
  .msg { margin-bottom: 14px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: break-word; }
  .msg.user { color: var(--vscode-textLink-foreground); }
  .msg.user::before { content: "you  "; opacity: 0.5; font-size: 11px; }
  .msg.ai::before { content: "⬡  "; opacity: 0.8; }
  .msg.err { color: var(--vscode-errorForeground); }
  #bar { display: flex; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--vscode-panel-border); }
  textarea { flex: 1; resize: none; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
             border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 6px 8px; font-family: inherit; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 4px; padding: 6px 12px; cursor: pointer; }
  button.sec { background: transparent; color: var(--vscode-foreground); opacity: 0.7; }
</style>
</head>
<body>
  <div id="head"><span>Your sovereign AI</span><span id="model"></span></div>
  <div id="log"></div>
  <div id="bar">
    <textarea id="in" rows="2" placeholder="Ask anything… (Enter to send)"></textarea>
    <button id="send">Send</button>
    <button id="new" class="sec" title="New conversation">↺</button>
  </div>
<script>
  const vscodeApi = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('in');
  let current = null;

  function add(cls, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + cls;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    vscodeApi.postMessage({ type: 'send', text });
  }
  document.getElementById('send').addEventListener('click', send);
  document.getElementById('new').addEventListener('click', () => { vscodeApi.postMessage({ type: 'newChat' }); log.innerHTML = ''; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'user') add('user', m.text);
    else if (m.type === 'start') current = add('ai', '…');
    else if (m.type === 'meta') document.getElementById('model').textContent = m.model;
    else if (m.type === 'delta') { if (current.textContent === '…') current.textContent = ''; current.textContent += m.text; log.scrollTop = log.scrollHeight; }
    else if (m.type === 'error') add('err', '⚠️ ' + m.text);
    else if (m.type === 'done') current = null;
  });
</script>
</body>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
