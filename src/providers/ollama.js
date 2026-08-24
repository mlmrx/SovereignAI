import { ndjsonLines, ensureOk } from './parsers.js';
import { withTimeoutSignal, safeFetch } from '../util.js';

export const ollama = {
  id: 'ollama',
  label: 'Ollama',

  isConfigured(cfg) {
    return Boolean(cfg.enabled && cfg.baseUrl);
  },

  async health(cfg) {
    const res = await safeFetch(`${cfg.baseUrl}/api/version`, { signal: AbortSignal.timeout(3000) });
    await ensureOk(res, 'Ollama');
    const { version } = await res.json();
    return { ok: true, detail: `Ollama ${version}` };
  },

  async listModels(cfg) {
    const res = await safeFetch(`${cfg.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    await ensureOk(res, 'Ollama');
    const { models = [] } = await res.json();
    return models.map((m) => ({
      id: m.name,
      label: m.name,
      ...(typeof m.digest === 'string' ? { digest: m.digest.toLowerCase().replace(/^sha256:/, '') } : {}),
    }));
  },

  /**
   * Yields { type: 'reasoning', text } (0..n — Ollama >= 0.9 emits message.thinking
   * for thinking models; absent otherwise), { type: 'delta', text } (0..n), then
   * { type: 'done', usage, stopReason }.
   */
  async *chatStream({ cfg, model, system, messages, temperature, maxTokens = 32000, signal }) {
    const body = {
      model,
      stream: true,
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
    };
    body.options = { num_predict: maxTokens };
    if (temperature !== null && temperature !== undefined) body.options.temperature = temperature;
    const res = await safeFetch(`${cfg.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: withTimeoutSignal(signal),
    });
    await ensureOk(res, 'Ollama');
    let usage = {};
    let stopReason = 'end_turn';
    for await (const line of ndjsonLines(res.body)) {
      if (line.error) throw new Error(`Ollama error: ${line.error}`);
      const thinking = line.message?.thinking;
      if (typeof thinking === 'string' && thinking) yield { type: 'reasoning', text: thinking };
      const text = line.message?.content;
      if (typeof text === 'string' && text) yield { type: 'delta', text };
      if (line.done) {
        usage = { input_tokens: line.prompt_eval_count ?? null, output_tokens: line.eval_count ?? null };
        // Ollama says why it stopped in done_reason ('stop' | 'length'); a budget cut is
        // the one case the client diagnoses differently.
        stopReason = line.done_reason === 'length' ? 'length' : 'end_turn';
      }
    }
    yield { type: 'done', usage, stopReason };
  },

  /**
   * Bake a named model from a base model + system prompt on the configured
   * Ollama endpoint (Ollama Modelfile), e.g. `mia:latest`.
   */
  async createModel(cfg, { name, base, system = '', parameters = {}, template = '', license = '', messages = [], quantize = null }) {
    const body = { model: name, from: base, stream: false };
    if (system) body.system = system;
    if (Object.keys(parameters).length) body.parameters = parameters;
    if (template) body.template = template;
    if (license) body.license = license;
    if (messages.length) body.messages = messages;
    if (quantize) body.quantize = quantize;
    const res = await safeFetch(`${cfg.baseUrl}/api/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
    await ensureOk(res, 'Ollama create');
    let result;
    try {
      result = await res.json();
    } catch {
      throw new Error('Ollama create returned an invalid JSON response');
    }
    if (!result || typeof result !== 'object' || result.status !== 'success') {
      const status = typeof result?.status === 'string' ? `: ${result.status.slice(0, 200)}` : '';
      throw new Error(`Ollama create did not report terminal success${status}`);
    }
    return { model: name, status: 'success' };
  },

  /** Batch-embed texts. Returns array of vectors. */
  async embed(cfg, model, texts) {
    const res = await safeFetch(`${cfg.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(120000),
    });
    await ensureOk(res, 'Ollama embeddings');
    const { embeddings } = await res.json();
    return embeddings;
  },
};
