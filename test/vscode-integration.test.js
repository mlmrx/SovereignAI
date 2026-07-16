import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import core from '../integrations/vscode/core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  ApiError,
  ChatSession,
  isLoopbackUrl,
  normalizeServerUrl,
  normalizeToken,
  parseSse,
  responseError,
  tokenStorageKey,
} = core;

function streamFrom(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test('VS Code server origins are normalized and unsafe URL forms are rejected', () => {
  assert.equal(normalizeServerUrl(' HTTP://LOCALHOST:4321/ '), 'http://localhost:4321');
  assert.equal(normalizeServerUrl('https://example.test:8443'), 'https://example.test:8443');
  assert.throws(() => normalizeServerUrl('file:///tmp/server'), /http:\/\/ or https:\/\//);
  assert.throws(() => normalizeServerUrl('http://user:secret@example.test'), /credentials/);
  assert.throws(() => normalizeServerUrl('https://example.test/api'), /only the server origin/);
  assert.throws(() => normalizeServerUrl('https://example.test/?token=secret'), /only the server origin/);
});

test('VS Code secret-storage keys are scoped to the normalized server origin', () => {
  assert.equal(tokenStorageKey('http://localhost:4321/'), tokenStorageKey('http://localhost:4321'));
  assert.notEqual(tokenStorageKey('http://localhost:4321'), tokenStorageKey('http://localhost:4322'));
  assert.notEqual(tokenStorageKey('http://localhost:4321'), tokenStorageKey('https://localhost:4321'));
  assert.equal(isLoopbackUrl('http://127.0.0.1:4321'), true);
  assert.equal(isLoopbackUrl('https://example.test'), false);
  assert.equal(normalizeToken('  abc+/=  '), 'abc+/=');
  assert.throws(() => normalizeToken('abc\r\ndef'), /line breaks/);
});

test('VS Code SSE parsing handles fragmented CRLF frames, comments, EOF flushing, and malformed data', async () => {
  const body = streamFrom([
    ':ok\r',
    '\n\r\nevent: me',
    'ta\r\ndata: {"conversationId":"c1"}\r\n\r\nevent: delta\n',
    'data: {"text":"hello"}\n\nevent: bad\ndata: {broken}\n\n',
    'event: done\ndata: {}',
  ]);
  const packets = [];
  for await (const packet of parseSse(body)) packets.push(packet);
  assert.deepEqual(packets, [
    { event: 'meta', data: { conversationId: 'c1' } },
    { event: 'delta', data: { text: 'hello' } },
    { event: 'protocol-error', data: { message: 'The server sent a malformed streaming event.' } },
    { event: 'done', data: {} },
  ]);
});

test('VS Code SSE parsing rejects a response without a readable body', async () => {
  await assert.rejects(async () => {
    for await (const _packet of parseSse(null)) { /* no-op */ }
  }, /no response stream/);
});

test('VS Code HTTP errors preserve useful server messages and explain token setup', async () => {
  const error = await responseError(new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    statusText: 'Unauthorized',
  }));
  assert.equal(error instanceof ApiError, true);
  assert.equal(error.status, 401);
  assert.match(error.message, /Unauthorized/);
  assert.match(error.message, /Set Bearer Token/);
});

test('VS Code chat reset aborts and invalidates stale streams before a new run starts', () => {
  const session = new ChatSession();
  const first = session.begin();
  assert.ok(first);
  assert.equal(session.setConversation(first, 'conversation-1'), true);
  session.reset();
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(session.conversationId, null);

  const second = session.begin();
  assert.ok(second);
  assert.notEqual(first.id, second.id);
  assert.equal(session.setConversation(first, 'stale-conversation'), false);
  assert.equal(session.setConversation(second, 'conversation-2'), true);
  assert.equal(session.finish(first), false);
  assert.equal(session.finish(second), true);
});

test('VS Code metadata and source enforce the v0.3 authentication and ingest contracts', () => {
  const root = path.join(__dirname, '..', 'integrations', 'vscode');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  assert.equal(manifest.version, '0.4.0');
  assert.equal(manifest.contributes.configuration.properties['sovereignai.serverUrl'].scope, 'machine');
  assert.equal(manifest.contributes.configuration.properties['sovereignai.authToken'].scope, 'machine');
  assert.match(manifest.contributes.configuration.properties['sovereignai.authToken'].description, /including on localhost/);
  assert.match(source, /context\.secrets\.store/);
  assert.match(source, /Only a user\/global legacy token is trusted/);
  assert.doesNotMatch(source, /\[inspected\.workspaceValue, workspaceServer\]/);
  assert.match(source, /context\.secrets|secretStorage/);
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /chatSession\.reset\(\)/);
  assert.match(source, /timeoutMs:\s*0[\s\S]*?body: JSON\.stringify\(\{ name, content:/);
  assert.doesNotMatch(manifest.description, /self-hosted|private memory|local models/i);
});
