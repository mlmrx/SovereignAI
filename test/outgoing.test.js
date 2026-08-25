// The customs declaration (ADR-26): what leaves your machine is shown before
// it leaves. These tests pin what makes the feature honest — the preview IS
// the request (byte-identical), it writes nothing, local never gates, no
// secret or URL escapes into the manifest, headless channels are unchanged,
// and the web UI is wired to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createApp } from '../src/server.js';
import { DEFAULT_CONFIG, loadConfig, mergeConfigUpdate, normalizeConfig } from '../src/config.js';
import { isLocalProviderEndpoint } from '../src/providers/index.js';

const root = path.resolve(import.meta.dirname, '..');
const pub = (file) => fs.readFileSync(path.join(root, 'public', file), 'utf8');

// A host that reads as remote to isLocalProviderEndpoint and resolves to
// nothing: safeFetch swallows the DNS miss and hands the URL to global fetch,
// which the stub below answers in-process. No network, no SSRF trick — the
// same interception test/reasoning.test.js uses at the provider level.
const REMOTE_HOST = 'remote-mock.example';
const REMOTE_KEY = 'sk-test-never-in-a-manifest-0123456789';
const REPLY = 'The codename is Aurora.';

const remoteConfig = {
  providers: { ollama: { enabled: false }, openai: { enabled: true, baseUrl: `https://${REMOTE_HOST}`, apiKey: REMOTE_KEY } },
  defaults: { provider: 'openai', model: 'mock-model' },
  embeddings: { model: '' },
  // Cognition stays home with a remote chat provider: extraction would skip.
  memory: { autoExtract: true, extractLocalOnly: true },
};

function stubRemoteProvider() {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith(`https://${REMOTE_HOST}/`)) return original(input, init);
    const { pathname } = new URL(url);
    if (pathname === '/v1/models') {
      return new Response(JSON.stringify({ data: [{ id: 'mock-model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    requests.push({ pathname, headers: init.headers ?? {}, body: JSON.parse(init.body) });
    const stream =
      `data: ${JSON.stringify({ choices: [{ delta: { content: REPLY }, finish_reason: 'stop' }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 21, completion_tokens: 6 } })}\n\n` +
      'data: [DONE]\n\n';
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

async function startTempApp(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-outgoing-'));
  fs.writeFileSync(path.join(home, 'sovereign.config.json'), JSON.stringify(config));
  const app = createApp(home, { env: {}, hardware: { detectGpu: async () => null } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app,
    base,
    async send(method, pathname, body) {
      const res = await fetch(base + pathname, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* SSE or empty */ }
      return { status: res.status, text, body: json };
    },
    async close() {
      await new Promise((resolve) => app.server.close(resolve));
      app.store.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function parseSse(text) {
  return text
    .split('\n\n')
    .map((block) => {
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      return data.length ? { event, data: JSON.parse(data.join('\n')) } : null;
    })
    .filter(Boolean);
}

// Every table a chat turn or an extraction could touch.
function snapshot(store) {
  const conversations = store.listConversations();
  return {
    ...store.getCounts(),
    messages: conversations.reduce((sum, c) => sum + store.listMessages(c.id).length, 0),
  };
}

function flatten(parts) {
  return [
    ...(parts.system ? [{ role: 'system', content: parts.system }] : []),
    ...parts.history,
    { role: 'user', content: parts.message },
  ];
}

function seedWorkspace(store) {
  const persona = store.createPersona({
    name: 'Customs',
    system_prompt: 'You are the customs officer. Cite sources by number.',
    use_memory: true,
    use_knowledge: true,
  });
  store.addMemory('The user ships on Windows 11 and tests on WSL before every release.');
  const document = store.addDocument({
    name: 'launch-notes.md',
    size: 40,
    chunks: [{ content: 'The private launch codename is Aurora.', embedding: null }],
    embedded: false,
  });
  return { persona, document };
}

test('the preview is the request: byte-identical context, nothing written, host only', async () => {
  const remote = stubRemoteProvider();
  const t = await startTempApp(remoteConfig);
  try {
    const { persona, document } = seedWorkspace(t.app.store);
    const question = 'What is the launch codename?';
    const before = snapshot(t.app.store);

    const preview = await t.send('POST', '/api/chat/preview', { message: question, personaId: persona.id });
    assert.equal(preview.status, 200, preview.text);
    const manifest = preview.body;
    assert.deepEqual(manifest.provider, { id: 'openai', label: 'OpenAI-compatible', local: false, host: REMOTE_HOST });
    assert.equal(manifest.model, 'mock-model');
    assert.deepEqual(Object.keys(manifest.parts), ['system', 'memories', 'sources', 'history', 'message']);
    assert.equal(manifest.parts.memories.length, 1);
    assert.match(manifest.parts.memories[0].content, /Windows 11/);
    assert.equal(manifest.parts.sources.length, 1);
    assert.equal(manifest.parts.sources[0].documentId, document.id);
    assert.equal(manifest.parts.sources[0].title, 'launch-notes.md');
    assert.equal(manifest.parts.sources[0].excerpt, 'The private launch codename is Aurora.');
    assert.deepEqual(manifest.parts.history, []);
    assert.equal(manifest.parts.message, question);
    // The system prompt is the one the model gets: persona + notes + excerpts.
    assert.match(manifest.parts.system, /customs officer/);
    assert.match(manifest.parts.system, /Windows 11/);
    assert.match(manifest.parts.system, /Aurora/);

    // "bytes" = UTF-8 length of the serialized outgoing context array (ADR-26).
    const context = flatten(manifest.parts);
    const chars = context.reduce((sum, part) => sum + part.content.length, 0);
    assert.deepEqual(manifest.totals, {
      chars,
      bytes: Buffer.byteLength(JSON.stringify(context), 'utf8'),
      approxTokens: Math.ceil(chars / 4),
      messages: 2,
    });
    assert.equal(manifest.extraction, null, 'cognition stays home refuses a remote extractor, so the declaration names none');

    // Host only — never the key, never a URL.
    assert.ok(!preview.text.includes(REMOTE_KEY), 'the manifest must not carry the API key');
    assert.ok(!preview.text.includes('sk-'), 'nothing key-shaped either');
    assert.ok(!preview.text.includes('://'), 'the manifest carries a host, never a URL');

    // A preview is a read: no conversation, message, or memory; no provider call.
    assert.deepEqual(snapshot(t.app.store), before);
    assert.equal(remote.requests.length, 0);

    // The real send: what the provider received is what the preview showed.
    const chat = await t.send('POST', '/api/chat', { message: question, personaId: persona.id });
    assert.equal(chat.status, 200);
    const events = parseSse(chat.text);
    assert.deepEqual(events.map((e) => e.event), ['meta', 'delta', 'done'], 'the stream is otherwise unchanged');
    const meta = events[0].data;
    assert.equal(remote.requests.length, 1);
    const sent = remote.requests[0];
    assert.equal(sent.pathname, '/v1/chat/completions');
    assert.deepEqual(sent.body.messages, context);
    assert.equal(sent.headers.authorization, `Bearer ${REMOTE_KEY}`, 'the send carries the key the manifest never did');
    assert.deepEqual(meta.outgoing, {
      bytes: Buffer.byteLength(JSON.stringify(sent.body.messages), 'utf8'),
      chars,
      approxTokens: Math.ceil(chars / 4),
      host: REMOTE_HOST,
    });
    assert.equal(meta.outgoing.bytes, manifest.totals.bytes);
    // The existing meta contract still holds: excerpt-only sources, excerpt-only memories.
    assert.equal(meta.sources[0].documentId, document.id);
    assert.ok(!('content' in meta.sources[0]));
    assert.match(meta.memories[0].excerpt, /Windows 11/);
    assert.equal(events[1].data.text, REPLY);

    const after = snapshot(t.app.store);
    assert.equal(after.conversations, before.conversations + 1, 'only the real send creates the conversation');
    assert.equal(after.messages, before.messages + 2);
    assert.equal(after.memories, before.memories);

    // Second turn: history parity, with the conversation now in play.
    const follow = 'And who chose it?';
    const preview2 = await t.send('POST', '/api/chat/preview', { message: follow, personaId: persona.id, conversationId: meta.conversationId });
    assert.equal(preview2.status, 200, preview2.text);
    assert.deepEqual(preview2.body.parts.history, [
      { role: 'user', content: question },
      { role: 'assistant', content: REPLY },
    ]);
    assert.equal(preview2.body.totals.messages, 4);
    assert.deepEqual(snapshot(t.app.store), after, 'a preview with a conversation still writes nothing');
    const chat2 = await t.send('POST', '/api/chat', { message: follow, personaId: persona.id, conversationId: meta.conversationId });
    assert.equal(chat2.status, 200);
    assert.deepEqual(remote.requests[1].body.messages, flatten(preview2.body.parts));
    const meta2 = parseSse(chat2.text)[0].data;
    assert.equal(meta2.outgoing.bytes, preview2.body.totals.bytes);
  } finally {
    remote.restore();
    await t.close();
  }
});

test('a local provider never gates: local flag, loopback host, no receipt, and rows say which is which', async () => {
  const seen = [];
  const ollama = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push(req.url);
      if (req.url === '/api/version') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ version: '0.0.0-mock' }));
      }
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ models: [{ name: 'llama3', digest: 'sha256:abc123' }] }));
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(
        JSON.stringify({ message: { content: 'Staying home.' }, done: false }) + '\n' +
          JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 4, eval_count: 2 }) + '\n'
      );
    });
  });
  await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${ollama.address().port}`;
  const t = await startTempApp({
    providers: { ollama: { enabled: true, baseUrl: `http://${host}` } },
    defaults: { provider: 'ollama', model: 'llama3' },
    embeddings: { model: '' },
  });
  try {
    const before = snapshot(t.app.store);
    const preview = await t.send('POST', '/api/chat/preview', { message: 'Does this leave?' });
    assert.equal(preview.status, 200, preview.text);
    assert.deepEqual(preview.body.provider, { id: 'ollama', label: 'Ollama', local: true, host });
    assert.ok(preview.body.provider.host.startsWith('127.0.0.1'), 'the host is the loopback host');
    assert.ok(!preview.text.includes('://'));
    assert.deepEqual(snapshot(t.app.store), before);
    assert.deepEqual(seen, [], 'a preview contacts no provider, local or not');

    const chat = await t.send('POST', '/api/chat', { message: 'Does this leave?' });
    assert.equal(chat.status, 200);
    const meta = parseSse(chat.text)[0].data;
    assert.ok('outgoing' in meta, 'the key is present so clients can tell "local" from "unknown"');
    assert.equal(meta.outgoing, null, 'nothing left, so there is no receipt');

    const providers = await t.send('GET', '/api/providers');
    assert.equal(providers.status, 200);
    const local = Object.fromEntries(providers.body.map((row) => [row.id, row.local]));
    assert.deepEqual(local, { ollama: true, freetoken: true, openai: false, anthropic: false });
    assert.ok(providers.body.every((row) => typeof row.local === 'boolean'), 'every row says whether it is local');
    // The row agrees with the rule the server gates on.
    assert.equal(local.ollama, isLocalProviderEndpoint('ollama', t.app.config.providers.ollama));

    // Trust is a config write with the same validation as the file.
    const trusted = await t.send('PUT', '/api/config', { privacy: { outgoingPreviewTrusted: ['anthropic'] } });
    assert.equal(trusted.status, 200, trusted.text);
    assert.deepEqual(trusted.body.privacy, { outgoingPreview: 'ask', outgoingPreviewTrusted: ['anthropic'] });
    const typo = await t.send('PUT', '/api/config', { privacy: { outgoingPreviewTrusted: ['gemini'] } });
    assert.equal(typo.status, 400);
    assert.match(typo.body.error, /outgoingPreviewTrusted\[0\] must be one of/);
    assert.deepEqual((await t.send('GET', '/api/config')).body.privacy.outgoingPreviewTrusted, ['anthropic'], 'a rejected update changes nothing');
  } finally {
    await t.close();
    await new Promise((resolve) => ollama.close(resolve));
  }
});

test('the declaration names the model that would write memory afterwards, exactly as extraction resolves it', async () => {
  // No provider is contacted by a preview, so no mock is needed here.
  const t = await startTempApp({
    providers: {
      ollama: { enabled: true, baseUrl: 'http://localhost:11434' },
      openai: { enabled: true, baseUrl: `https://${REMOTE_HOST}`, apiKey: REMOTE_KEY },
    },
    defaults: { provider: 'ollama', model: 'llama3' },
    embeddings: { model: '' },
    memory: { autoExtract: true, extractLocalOnly: false, extractionModel: 'qwen3:4b' },
  });
  try {
    const remotePersona = t.app.store.createPersona({ name: 'Abroad', system_prompt: 'x', provider: 'openai', model: 'mock-model', use_memory: true, use_knowledge: false });
    const withRole = await t.send('POST', '/api/chat/preview', { message: 'hi', personaId: remotePersona.id });
    assert.equal(withRole.status, 200, withRole.text);
    assert.equal(withRole.body.provider.local, false);
    assert.deepEqual(withRole.body.extraction, { provider: 'ollama', model: 'qwen3:4b', local: true }, 'the cognition role owns memory-writing');

    // Without the role, the chat model itself would extract — remotely.
    const noRole = await t.send('PUT', '/api/config', { memory: { extractionModel: '' } });
    assert.equal(noRole.status, 200, noRole.text);
    const sameModel = await t.send('POST', '/api/chat/preview', { message: 'hi', personaId: remotePersona.id });
    assert.deepEqual(sameModel.body.extraction, { provider: 'openai', model: 'mock-model', local: false });

    // A persona without memory never extracts; auto-extract off never extracts.
    const noMemory = t.app.store.createPersona({ name: 'Amnesiac', system_prompt: 'x', provider: 'openai', model: 'mock-model', use_memory: false, use_knowledge: false });
    assert.equal((await t.send('POST', '/api/chat/preview', { message: 'hi', personaId: noMemory.id })).body.extraction, null);
    await t.send('PUT', '/api/config', { memory: { autoExtract: false } });
    assert.equal((await t.send('POST', '/api/chat/preview', { message: 'hi', personaId: remotePersona.id })).body.extraction, null);
  } finally {
    await t.close();
  }
});

test('the preview validates exactly like the send, and a rejected preview writes nothing either', async () => {
  const t = await startTempApp({
    providers: { ollama: { enabled: true, baseUrl: 'http://localhost:11434' } },
    defaults: { provider: 'ollama', model: 'llama3' },
    embeddings: { model: '' },
  });
  try {
    const before = snapshot(t.app.store);
    const cases = [
      [{ message: '   ' }, 400, /message is required/],
      [{}, 400, /message is required/],
      [{ message: 'x'.repeat(200_001) }, 413, /at most 200,000/],
      [{ message: 'hi', conversationId: 'nope' }, 404, /Conversation not found/],
      [{ message: 'hi', personaId: 'nope' }, 404, /Persona not found/],
    ];
    for (const [body, status, pattern] of cases) {
      const res = await t.send('POST', '/api/chat/preview', body);
      assert.equal(res.status, status, res.text);
      assert.match(res.body.error, pattern);
    }
    const unconfigured = t.app.store.createPersona({ name: 'Nowhere', system_prompt: 'x', provider: 'anthropic', use_memory: false, use_knowledge: false });
    const res = await t.send('POST', '/api/chat/preview', { message: 'hi', personaId: unconfigured.id });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"anthropic" is not configured/);
    assert.deepEqual(snapshot(t.app.store), { ...before, personas: before.personas + 1 });
    // Same route rules as the rest of the API: JSON only.
    const plain = await fetch(t.base + '/api/chat/preview', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(plain.status, 415);
  } finally {
    await t.close();
  }
});

test('headless channels do not gate: /api/ask sends to a remote provider straight away, shape unchanged', async () => {
  const remote = stubRemoteProvider();
  const t = await startTempApp(remoteConfig);
  try {
    const res = await t.send('POST', '/api/ask', { message: 'Codename?' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.answer, REPLY);
    assert.equal(remote.requests.length, 1, 'no preview, no dialog — the request simply went');
    assert.deepEqual(Object.keys(res.body).sort(), ['answer', 'conversationId', 'model', 'persona', 'sources', 'usage']);
  } finally {
    remote.restore();
    await t.close();
  }
});

test('privacy config: defaults, the enum, and only known provider ids can be trusted', () => {
  assert.deepEqual(DEFAULT_CONFIG.privacy, { outgoingPreview: 'ask', outgoingPreviewTrusted: [] });
  assert.deepEqual(normalizeConfig(DEFAULT_CONFIG).privacy, { outgoingPreview: 'ask', outgoingPreviewTrusted: [] });
  const current = structuredClone(DEFAULT_CONFIG);
  assert.equal(mergeConfigUpdate(current, { privacy: { outgoingPreview: 'off' } }).privacy.outgoingPreview, 'off');
  assert.deepEqual(
    mergeConfigUpdate(current, { privacy: { outgoingPreviewTrusted: ['openai', 'openai', 'anthropic'] } }).privacy.outgoingPreviewTrusted,
    ['openai', 'anthropic'],
    'deduplicated, order kept'
  );
  assert.throws(() => mergeConfigUpdate(current, { privacy: { outgoingPreview: 'sometimes' } }), /outgoingPreview must be one of: ask, off/);
  assert.throws(() => mergeConfigUpdate(current, { privacy: { outgoingPreview: true } }), /must be a string/);
  assert.throws(() => mergeConfigUpdate(current, { privacy: { outgoingPreviewTrusted: ['gemini'] } }), /outgoingPreviewTrusted\[0\] must be one of/);
  assert.throws(() => mergeConfigUpdate(current, { privacy: { outgoingPreviewTrusted: 'openai' } }), /must be an array/);
  assert.throws(() => mergeConfigUpdate(current, { privacy: { surprise: true } }), /unknown field "surprise"/);
  // A config file written before the section existed loads with the defaults.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-outgoing-config-'));
  try {
    fs.writeFileSync(path.join(home, 'sovereign.config.json'), JSON.stringify({ name: 'Older' }));
    assert.deepEqual(loadConfig(home).privacy, { outgoingPreview: 'ask', outgoingPreviewTrusted: [] });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the web UI is wired: gate before send, dialog markup, receipt, trusted chips, no inline handlers', () => {
  const appJs = pub('app.js');
  const html = pub('app.html');
  const css = pub('style.css');
  const demo = pub('demo-api.js');
  assert.doesNotThrow(() => new vm.Script(appJs, { filename: 'public/app.js' }));
  assert.doesNotThrow(() => new vm.Script(demo, { filename: 'public/demo-api.js' }));

  assert.match(appJs, /'\/api\/chat\/preview'/, 'the preview route is called');
  assert.match(appJs, /#outgoing-dialog/, 'the dialog is driven from app.js');
  assert.match(appJs, /outgoingPreviewTrusted/, 'the trusted list is read and written');
  assert.match(appJs, /outgoingPreview === 'off'/, 'the switch is honoured');
  assert.match(appJs, /if \(!\(await outgoingClearance\(\{ text, personaId \}\)\)\)/, 'the gate runs before anything is cleared or sent');
  assert.ok(appJs.indexOf('await outgoingClearance(') < appJs.indexOf("await fetch('/api/chat'"), 'the gate precedes the send');
  assert.match(appJs, /row\?\.local === true\) return true/, "the server's locality verdict decides, never a client guess alone");
  assert.match(appJs, /manifest\.provider\.local\) return true/, 'a local verdict from the preview itself also clears');
  assert.match(appJs, /title: 'Nothing was sent'/, 'a failed preview never falls through to a send');
  assert.match(appJs, /body\.textContent = text/, 'parts are rendered as text, never markup');
  assert.match(appJs, /left the machine · \$\{formatBytes\(metadata\.outgoing\.bytes\)\} → /, 'the receipt on a remote answer');
  assert.match(appJs, /dialog\.returnValue = 'cancel';[\s\S]*?dialog\.showModal\(\);[\s\S]*?\$\('#outgoing-send'\)\.focus\(\)/, 'cancel by default, focus moves into the dialog');
  assert.match(appJs, /inputEl\.focus\(\);\s*resolve\(send\);/, 'focus returns to the composer');
  assert.match(appJs, /privacy: \{ outgoingPreviewTrusted: \[\.\.\.current, providerId\] \}/, '"don\'t ask again" is a config write');
  assert.match(appJs, /privacy: \{ outgoingPreview: \$\('#cfg-outgoing-preview'\)\.value, outgoingPreviewTrusted: state\.outgoingTrustedDraft/, 'settings save both keys');
  assert.match(appJs, /class="trusted-revoke"/, 'trusted providers are removable chips');

  assert.match(html, /<dialog id="outgoing-dialog"[^>]*aria-labelledby="outgoing-title"/);
  for (const id of ['outgoing-title', 'outgoing-summary', 'outgoing-parts', 'outgoing-extraction', 'outgoing-trust', 'outgoing-trust-label', 'outgoing-send', 'outgoing-cancel', 'cfg-outgoing-preview', 'cfg-outgoing-trusted']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /What leaves your machine/);
  assert.match(html, /<option value="ask">/);
  assert.match(html, /<option value="off">/);
  assert.match(html, /<button id="outgoing-cancel"[^>]*value="cancel"/);
  assert.match(html, /<button id="outgoing-send"[^>]*value="send"/);
  assert.doesNotMatch(html, /\son[a-z]+="/i, 'CSP forbids inline handlers');
  assert.doesNotMatch(html, /<script>[^<]/, 'CSP forbids inline scripts');
  assert.match(css, /\.outgoing-dialog \{/);
  assert.match(css, /\.outgoing-text \{[^}]*white-space: pre-wrap/);
  assert.match(css, /\.trusted-chip \{/);

  // The public demo answers the same calls with the same shapes, as a local provider.
  assert.match(demo, /path === '\/api\/chat\/preview' && method === 'POST'/);
  assert.match(demo, /provider: \{ id: 'ollama', label: 'Ollama', local: true, host: 'localhost:11434' \}/);
  assert.match(demo, /outgoing: null/);
  assert.match(demo, /privacy: \{ outgoingPreview: 'ask', outgoingPreviewTrusted: \[\] \}/);
  assert.match(demo, /id: 'anthropic'[^\n]*local: false/);
});
