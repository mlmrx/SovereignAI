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
    await ensureOk(res, `${this.label} endpoint`);
    return { ok: true, detail: `Reachable at ${cfg.baseUrl}` };
  },

  async listModels(cfg) {
    const res = await safeFetch(`${cfg.baseUrl}/v1/models`, { headers: this.headers(cfg), signal: AbortSignal.timeout(10000) });
    await ensureOk(res, `${this.label} endpoint`);
    const { data = [] } = await res.json();
    return data.map((m) => ({ id: m.id, label: m.id }));
  },

  /**
   * Yields { type: 'reasoning', text } (0..n, model thinking — shown live, never
   * persisted), { type: 'delta', text } (0..n), then { type: 'done', usage, stopReason }.
   */
  async *chatStream({ cfg, model, system, messages, temperature, maxTokens = 32000, signal }) {
    const body = {
      model,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
    };
    if (temperature !== null && temperature !== undefined) body.temperature = temperature;
    const res = await compatibleChatRequest(cfg, this.headers(cfg), body, withTimeoutSignal(signal), `${this.label} endpoint`);
    let usage = {};
    let stopReason = 'end_turn';
    // Stream shape (FreeToken / vLLM / llama.cpp all agree on this skeleton):
    //   {delta:{role,content:""}} → 0..n {delta:{reasoning_content}} → 0..n {delta:{content}}
    //   → {delta:{},finish_reason} → (with include_usage) {choices:[],usage} → [DONE]
    // Empty strings never become events; the usage chunk has no choices and
    // must still be read; a mid-stream {"error":{...}} line on HTTP 200 aborts.
    for await (const { data, raw } of sseEvents(res.body)) {
      if (raw === '[DONE]') break;
      if (typeof data !== 'object' || data === null) continue;
      if (data.error) throw new Error(`Provider error: ${data.error.message ?? (typeof data.error === 'string' ? data.error : JSON.stringify(data.error))}`);
      const choice = data.choices?.[0];
      // `reasoning_content` is the OpenAI/DeepSeek/FreeToken spelling; `reasoning`
      // is what llama.cpp and vLLM's newer parsers emit. Never in the same chunk as content.
      const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
      if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', text: reasoning };
      const text = choice?.delta?.content;
      if (typeof text === 'string' && text) yield { type: 'delta', text };
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      if (data.usage) {
        usage = { input_tokens: data.usage.prompt_tokens ?? null, output_tokens: data.usage.completion_tokens ?? null };
      }
    }
    yield { type: 'done', usage, stopReason };
  },
};

// `label` names the endpoint in errors: providers that reuse this stream (FreeToken) pass their own.
async function compatibleChatRequest(cfg, headers, initialBody, signal, label = 'OpenAI-compatible endpoint') {
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
      await ensureOk(response, label);
      return response;
    }
    body = adjusted;
  }
  throw new Error(`${label} rejected all supported chat parameter variants`);
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
