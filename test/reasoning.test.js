import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openai } from '../src/providers/openai.js';
import { ollama } from '../src/providers/ollama.js';
import { anthropic } from '../src/providers/anthropic.js';
import { createApp } from '../src/server.js';

const root = path.resolve(import.meta.dirname, '..');

function sse(...frames) {
  return frames.map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('');
}

function streamResponse(body, contentType = 'text/event-stream') {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

async function collect(stream) {
  const parts = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

const openAiArgs = {
  cfg: { baseUrl: 'http://localhost:1919', apiKey: '' },
  model: 'served-model',
  system: '',
  messages: [{ role: 'user', content: 'Hi' }],
};

// A FreeToken-shaped stream: role chunk with empty content, reasoning, content,
// finish chunk with an empty delta, usage chunk with no choices, then [DONE].
const freeTokenStream = sse(
  { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { reasoning_content: 'Let me ' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { reasoning_content: 'think.' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: '!' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } },
  '[DONE]'
);

test('OpenAI-compatible provider surfaces FreeToken reasoning before the answer and keeps usage', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => streamResponse(freeTokenStream);
  try {
    const parts = await collect(openai.chatStream(openAiArgs));
    assert.deepEqual(parts.map((part) => part.type), ['reasoning', 'reasoning', 'delta', 'delta', 'done']);
    assert.equal(parts.filter((part) => part.type === 'reasoning').map((part) => part.text).join(''), 'Let me think.');
    assert.equal(parts.filter((part) => part.type === 'delta').map((part) => part.text).join(''), 'Hi!');
    assert.deepEqual(parts.at(-1).usage, { input_tokens: 5, output_tokens: 7 });
    assert.equal(parts.at(-1).stopReason, 'stop');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI-compatible provider understands the llama.cpp "reasoning" delta spelling', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    streamResponse(
      sse(
        { choices: [{ delta: { reasoning: 'hmm' }, finish_reason: null }] },
        { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
        '[DONE]'
      )
    );
  try {
    const parts = await collect(openai.chatStream(openAiArgs));
    assert.deepEqual(
      parts.map((part) => [part.type, part.text ?? null]),
      [['reasoning', 'hmm'], ['delta', 'ok'], ['done', null]]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a flat 503 "model is still loading" body becomes a readable provider error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('{"error":"model is still loading"}', { status: 503, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(collect(openai.chatStream(openAiArgs)), (err) => {
      assert.match(err.message, /still loading/);
      assert.match(err.message, /HTTP 503/);
      assert.doesNotMatch(err.message, /object Object|undefined/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a mid-stream error line on HTTP 200 rejects the chat with its message', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    streamResponse(
      sse(
        { choices: [{ delta: { reasoning_content: 'partial' }, finish_reason: null }] },
        { error: { message: 'boom', type: 'server_error', code: null } },
        { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
        '[DONE]'
      )
    );
  try {
    await assert.rejects(collect(openai.chatStream(openAiArgs)), /boom/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Ollama surfaces message.thinking as reasoning ahead of the answer', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    streamResponse(
      '{"message":{"role":"assistant","content":"","thinking":"Weighing it."},"done":false}\n' +
        '{"message":{"role":"assistant","content":"Yes."},"done":false}\n' +
        '{"message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":3,"eval_count":4}\n',
      'application/x-ndjson'
    );
  try {
    const parts = await collect(
      ollama.chatStream({ cfg: { baseUrl: 'http://localhost:11434' }, model: 'm', system: '', messages: [{ role: 'user', content: 'Hi' }] })
    );
    assert.deepEqual(
      parts.map((part) => [part.type, part.text ?? null]),
      [['reasoning', 'Weighing it.'], ['delta', 'Yes.'], ['done', null]]
    );
    assert.deepEqual(parts.at(-1).usage, { input_tokens: 3, output_tokens: 4 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic surfaces thinking_delta as reasoning ahead of text_delta', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    streamResponse(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Considering."}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done."}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    );
  try {
    const parts = await collect(
      anthropic.chatStream({ cfg: { baseUrl: 'https://api.anthropic.com', apiKey: 'k' }, model: '', system: '', messages: [{ role: 'user', content: 'Hi' }] })
    );
    assert.deepEqual(
      parts.map((part) => [part.type, part.text ?? null]),
      [['reasoning', 'Considering.'], ['delta', 'Done.'], ['done', null]]
    );
    assert.deepEqual(parts.at(-1).usage, { input_tokens: 9, output_tokens: 2 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('/api/chat relays reasoning as its own SSE event, counts it, and never stores it', async () => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(freeTokenStream);
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-reasoning-'));
  fs.writeFileSync(
    path.join(rootDir, 'sovereign.config.json'),
    JSON.stringify({
      providers: { ollama: { enabled: false }, openai: { enabled: true, baseUrl: providerUrl } },
      defaults: { provider: 'openai', model: 'served-model' },
      embeddings: { model: '' },
    })
  );
  const app = createApp(rootDir, { env: {}, hardware: { detectGpu: async () => null } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const memoriesBefore = await (await fetch(base + '/api/memories')).json();
    const documentsBefore = await (await fetch(base + '/api/documents')).json();

    const response = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Say hi' }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();

    const frames = body.split('\n\n').filter(Boolean).map((frame) => {
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
    const events = frames.map((frame) => frame.event);
    assert.ok(events.includes('reasoning'), `no reasoning event in ${events.join(',')}`);
    assert.ok(events.indexOf('reasoning') < events.indexOf('delta'), 'reasoning must precede the first delta');
    assert.equal(events.lastIndexOf('reasoning') < events.indexOf('delta'), true);
    const reasoning = frames.filter((frame) => frame.event === 'reasoning').map((frame) => frame.data.text).join('');
    const answer = frames.filter((frame) => frame.event === 'delta').map((frame) => frame.data.text).join('');
    assert.equal(reasoning, 'Let me think.');
    assert.equal(answer, 'Hi!');

    const done = frames.find((frame) => frame.event === 'done').data;
    assert.equal(done.reasoningChars, 'Let me think.'.length);
    assert.equal(done.stopReason, 'stop');
    assert.deepEqual(done.usage, { input_tokens: 5, output_tokens: 7 });
    assert.ok(done.messageId);

    const conversation = await (await fetch(base + `/api/conversations/${encodeURIComponent(done.conversationId)}`)).json();
    const assistant = conversation.messages.find((message) => message.role === 'assistant');
    assert.equal(assistant.content, 'Hi!');
    assert.ok(!JSON.stringify(conversation).includes('Let me think.'), 'reasoning must not be persisted anywhere on the conversation');

    assert.deepEqual(await (await fetch(base + '/api/memories')).json(), memoriesBefore);
    assert.deepEqual(await (await fetch(base + '/api/documents')).json(), documentsBefore);

    // The non-streaming door sees only the answer: reasoning never reaches /api/ask callers.
    const ask = await fetch(base + '/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Say hi' }),
    });
    assert.equal(ask.status, 200);
    const asked = await ask.json();
    assert.equal(asked.answer, 'Hi!');
    assert.ok(!JSON.stringify(asked).includes('Let me think.'), 'reasoning must not leak into /api/ask');
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.store.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('the command center renders reasoning live and styles it as not-saved', () => {
  const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
  assert.match(appJs, /appendReasoning/);
  assert.match(appJs, /packet\.event === 'reasoning'/);
  assert.match(appJs, /shown live, not saved/);
  assert.match(appJs, /reasoning shown, not saved/);
  assert.match(appJs, /whole output budget on reasoning/);
  // The budget wording is only used when the provider said the budget was the reason.
  assert.match(appJs, /packet\.data\.stopReason/);
  assert.match(appJs, /stopReason === 'length'/);
  assert.match(css, /\.message-reasoning\b/);
  assert.match(css, /\.message-reasoning-body/);
});
