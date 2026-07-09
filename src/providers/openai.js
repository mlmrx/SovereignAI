import { sseEvents, ensureOk } from './parsers.js';

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
    const res = await fetch(`${cfg.baseUrl}/v1/models`, { headers: this.headers(cfg), signal: AbortSignal.timeout(5000) });
    await ensureOk(res, 'OpenAI-compatible endpoint');
    return { ok: true, detail: `Reachable at ${cfg.baseUrl}` };
  },

  async listModels(cfg) {
    const res = await fetch(`${cfg.baseUrl}/v1/models`, { headers: this.headers(cfg), signal: AbortSignal.timeout(10000) });
    await ensureOk(res, 'OpenAI-compatible endpoint');
    const { data = [] } = await res.json();
    return data.map((m) => ({ id: m.id, label: m.id }));
  },

  async *chatStream({ cfg, model, system, messages, temperature, signal }) {
    const body = {
      model,
      stream: true,
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
    };
    if (temperature !== null && temperature !== undefined) body.temperature = temperature;
    const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(cfg),
      body: JSON.stringify(body),
      signal,
    });
    await ensureOk(res, 'OpenAI-compatible endpoint');
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
