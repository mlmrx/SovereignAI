import { sseEvents, ensureOk } from './parsers.js';
import { withTimeoutSignal, safeFetch } from '../util.js';

/** Any OpenAI-compatible chat-completions server: vLLM, llama.cpp, LM Studio, Groq, Mistral, OpenAI… */
export const openai = {
  id: 'openai',
  label: 'OpenAI-compatible',

  isConfigured(cfg) {
    return Boolean(cfg.enabled && cfg.baseUrl);
  },

  headers(cfg) {
    const headers = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    return headers;
  },

  async health(cfg) {
    const res = await safeFetch(`${cfg.baseUrl}/v1/models`, { headers: this.headers(cfg), signal: AbortSignal.timeout(5000) });
    await ensureOk(res, 'OpenAI-compatible endpoint');
    return { ok: true, detail: `Reachable at ${cfg.baseUrl}` };
  },

  async listModels(cfg) {
    const res = await safeFetch(`${cfg.baseUrl}/v1/models`, { headers: this.headers(cfg), signal: AbortSignal.timeout(10000) });
    await ensureOk(res, 'OpenAI-compatible endpoint');
    const { data = [] } = await res.json();
    return data.map((m) => ({ id: m.id, label: m.id }));
  },

  async *chatStream({ cfg, model, system, messages, temperature, maxTokens = 32000, signal }) {
    const body = {
      model,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
    };
    if (temperature !== null && temperature !== undefined) body.temperature = temperature;
    const res = await compatibleChatRequest(cfg, this.headers(cfg), body, withTimeoutSignal(signal));
    let usage = {};
    let stopReason = 'end_turn';
    for await (const { data, raw } of sseEvents(res.body)) {
      if (raw === '[DONE]') break;
      if (typeof data !== 'object' || data === null) continue;
      if (data.error) throw new Error(`Provider error: ${data.error.message ?? JSON.stringify(data.error)}`);
      const choice = data.choices?.[0];
      const text = choice?.delta?.content;
      if (text) yield { type: 'delta', text };
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      if (data.usage) {
        usage = { input_tokens: data.usage.prompt_tokens ?? null, output_tokens: data.usage.completion_tokens ?? null };
      }
    }
    yield { type: 'done', usage, stopReason };
  },
};

async function compatibleChatRequest(cfg, headers, initialBody, signal) {
  let body = initialBody;
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await safeFetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (response.ok) return response;

    let detail = '';
    try { detail = await response.clone().text(); } catch { /* use the original provider error below */ }
    const adjusted = compatibilityAdjustment(response.status, body, detail);
    if (!adjusted) {
      await ensureOk(response, 'OpenAI-compatible endpoint');
      return response;
    }
    body = adjusted;
  }
  throw new Error('OpenAI-compatible endpoint rejected all supported chat parameter variants');
}

function compatibilityAdjustment(status, body, detail) {
  if (status !== 400 && status !== 422) return null;
  const message = detail.toLowerCase();
  const unsupported = /(unsupported|unknown|unrecognized|unexpected|forbidden|not (?:allowed|supported|permitted)|extra (?:fields?|inputs?))/;
  const invalidLimit = /(must be|maximum|less than|greater than|too (?:large|high)|context length|out of range|invalid)/;
  const next = { ...body };
  let changed = false;

  // stream_options is an OpenAI usage-reporting extension that some otherwise
  // compatible servers do not implement. Omitting it changes only telemetry.
  if (next.stream_options && message.includes('stream_options') && unsupported.test(message)) {
    delete next.stream_options;
    changed = true;
  }

  if (
    Object.hasOwn(next, 'max_tokens') &&
    message.includes('max_tokens') &&
    (unsupported.test(message) || invalidLimit.test(message))
  ) {
    if (message.includes('max_completion_tokens')) next.max_completion_tokens = next.max_tokens;
    delete next.max_tokens;
    changed = true;
  } else if (
    Object.hasOwn(next, 'max_completion_tokens') &&
    message.includes('max_completion_tokens') &&
    (unsupported.test(message) || invalidLimit.test(message))
  ) {
    delete next.max_completion_tokens;
    changed = true;
  }

  return changed ? next : null;
}
