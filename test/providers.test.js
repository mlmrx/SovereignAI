import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ollama } from '../src/providers/ollama.js';
import { openai } from '../src/providers/openai.js';
import { sseEvents } from '../src/providers/parsers.js';
import { withTimeoutSignal } from '../src/util.js';

test('Ollama receives the configured output-token limit', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(
      '{"message":{"content":"hello"},"done":false}\n' +
        '{"done":true,"prompt_eval_count":5,"eval_count":2}\n',
      { status: 200, headers: { 'content-type': 'application/x-ndjson' } }
    );
  };
  try {
    const parts = [];
    for await (const part of ollama.chatStream({
      cfg: { baseUrl: 'http://localhost:11434' },
      model: 'test-model',
      system: 'Be useful.',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.25,
      maxTokens: 321,
    })) {
      parts.push(part);
    }
    assert.equal(request.options.num_predict, 321);
    assert.equal(request.options.temperature, 0.25);
    assert.equal(parts[0].text, 'hello');
    assert.deepEqual(parts.at(-1).usage, { input_tokens: 5, output_tokens: 2 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI-compatible chat drops unsupported usage options without losing token limits', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'Unknown field stream_options' } }), { status: 400 });
    }
    return openAiStreamResponse('compatible');
  };
  try {
    const parts = [];
    for await (const part of openai.chatStream({
      cfg: { baseUrl: 'http://localhost:8000', apiKey: '' },
      model: 'legacy-compatible-model',
      system: '',
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 321,
    })) parts.push(part);

    assert.equal(requests.length, 2);
    assert.equal(requests[0].stream_options.include_usage, true);
    assert.equal('stream_options' in requests[1], false);
    assert.equal(requests[1].max_tokens, 321);
    assert.equal(parts[0].text, 'compatible');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI-compatible chat follows a provider request for max_completion_tokens', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." },
      }), { status: 400 });
    }
    return openAiStreamResponse('reasoning-compatible');
  };
  try {
    for await (const _part of openai.chatStream({
      cfg: { baseUrl: 'https://api.openai.com', apiKey: 'test-key' },
      model: 'reasoning-model',
      system: '',
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 654,
    })) { /* consume */ }

    assert.equal(requests.length, 2);
    assert.equal('max_tokens' in requests[1], false);
    assert.equal(requests[1].max_completion_tokens, 654);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI-compatible chat exhausts a safe four-step parameter fallback chain', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const errors = [
    'Extra inputs are not permitted: stream_options',
    "Unsupported parameter 'max_tokens'; use max_completion_tokens instead",
    'max_completion_tokens must be less than or equal to 4096',
  ];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const message = errors[requests.length - 1];
    return message
      ? new Response(JSON.stringify({ error: { message } }), { status: 400 })
      : openAiStreamResponse('fallback-complete');
  };
  try {
    for await (const _part of openai.chatStream({
      cfg: { baseUrl: 'http://localhost:8000', apiKey: '' },
      model: 'strict-compatible-model',
      system: '',
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 32_000,
    })) { /* consume */ }

    assert.equal(requests.length, 4);
    assert.equal('stream_options' in requests[1], false);
    assert.equal(requests[2].max_completion_tokens, 32_000);
    assert.equal('max_tokens' in requests[3], false);
    assert.equal('max_completion_tokens' in requests[3], false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider timeout signals compose with caller cancellation', async () => {
  const caller = new AbortController();
  const combined = withTimeoutSignal(caller.signal, 25);
  assert.equal(combined.aborted, false);
  caller.abort();
  assert.equal(combined.aborted, true);

  const timed = withTimeoutSignal(undefined, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(timed.aborted, true);
});

test('concurrent provider streams keep fragmented UTF-8 decoder state isolated', async () => {
  let firstController;
  let secondController;
  const firstStream = new ReadableStream({ start(controller) { firstController = controller; } });
  const secondStream = new ReadableStream({ start(controller) { secondController = controller; } });
  const first = sseEvents(firstStream)[Symbol.asyncIterator]();
  const second = sseEvents(secondStream)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const firstBytes = encoder.encode('data: {"text":"caf\u00e9"}\n\n');
  const split = firstBytes.indexOf(0xc3) + 1;

  const firstResult = first.next();
  firstController.enqueue(firstBytes.subarray(0, split));
  await Promise.resolve();

  const secondResult = second.next();
  secondController.enqueue(encoder.encode('data: {"text":"second"}\n\n'));
  secondController.close();
  assert.equal((await secondResult).value.data.text, 'second');

  firstController.enqueue(firstBytes.subarray(split));
  firstController.close();
  assert.equal((await firstResult).value.data.text, 'caf\u00e9');
});

function openAiStreamResponse(text) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n` +
      'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
}
