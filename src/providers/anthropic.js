import { sseEvents, ensureOk } from './parsers.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';
const API_VERSION = '2023-06-01';

/**
 * Native Anthropic Messages API provider (BYO key).
 *
 * Notes on current models (Claude 4.7+ / Fable 5): sampling params like `temperature`
 * are rejected, so we never send them; thinking runs adaptively by default. We stream
 * and surface `stop_reason` (including `refusal`) to the caller.
 */
export const anthropic = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',

  isConfigured(cfg) {
    return Boolean(cfg.enabled && cfg.apiKey);
  },

  headers(cfg) {
    return {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': API_VERSION,
    };
  },

  async health(cfg) {
    const res = await fetch(`${cfg.baseUrl}/v1/models?limit=1`, { headers: this.headers(cfg), signal: AbortSignal.timeout(8000) });
    await ensureOk(res, 'Anthropic');
    return { ok: true, detail: 'API key valid' };
  },

  async listModels(cfg) {
    const res = await fetch(`${cfg.baseUrl}/v1/models`, { headers: this.headers(cfg), signal: AbortSignal.timeout(10000) });
    await ensureOk(res, 'Anthropic');
    const { data = [] } = await res.json();
    return data.map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
  },

  async *chatStream({ cfg, model, system, messages, maxTokens = 32000, signal }) {
    const body = {
      model: model || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      stream: true,
      messages,
    };
    if (system) body.system = system;
    const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(cfg),
      body: JSON.stringify(body),
      signal,
    });
    await ensureOk(res, 'Anthropic');
    const usage = {};
    let stopReason = 'end_turn';
    for await (const { event, data } of sseEvents(res.body)) {
      if (event === 'error') {
        throw new Error(`Anthropic error: ${data?.error?.message ?? JSON.stringify(data)}`);
      }
      if (typeof data !== 'object' || data === null) continue;
      switch (data.type) {
        case 'message_start':
          usage.input_tokens = data.message?.usage?.input_tokens ?? null;
          break;
        case 'content_block_delta':
          if (data.delta?.type === 'text_delta' && data.delta.text) {
            yield { type: 'delta', text: data.delta.text };
          }
          break;
        case 'message_delta':
          if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
          if (data.usage?.output_tokens != null) usage.output_tokens = data.usage.output_tokens;
          break;
        default:
          break; // ping, content_block_start/stop, message_stop
      }
    }
    yield { type: 'done', usage, stopReason };
  },
};
