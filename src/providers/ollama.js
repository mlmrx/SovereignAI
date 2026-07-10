import { ndjsonLines, ensureOk } from './parsers.js';

export const ollama = {
  id: 'ollama',
  label: 'Ollama (local)',

  isConfigured(cfg) {
    return Boolean(cfg.enabled && cfg.baseUrl);
  },

  async health(cfg) {
    const res = await fetch(`${cfg.baseUrl}/api/version`, { signal: AbortSignal.timeout(3000) });
    await ensureOk(res, 'Ollama');
    const { version } = await res.json();
    return { ok: true, detail: `Ollama ${version}` };
  },

  async listModels(cfg) {
    const res = await fetch(`${cfg.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    await ensureOk(res, 'Ollama');
    const { models = [] } = await res.json();
    return models.map((m) => ({ id: m.name, label: m.name }));
  },

  /** Yields { type: 'delta', text } then { type: 'done', usage, stopReason }. */
  async *chatStream({ cfg, model, system, messages, temperature, signal }) {
    const body = {
      model,
      stream: true,
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
    };
    if (temperature !== null && temperature !== undefined) {
      body.options = { temperature };
    }
    const res = await fetch(`${cfg.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    await ensureOk(res, 'Ollama');
    let usage = {};
    for await (const line of ndjsonLines(res.body)) {
      if (line.error) throw new Error(`Ollama error: ${line.error}`);
      const text = line.message?.content;
      if (text) yield { type: 'delta', text };
      if (line.done) {
        usage = { input_tokens: line.prompt_eval_count ?? null, output_tokens: line.eval_count ?? null };
      }
    }
    yield { type: 'done', usage, stopReason: 'end_turn' };
  },

  /**
   * Bake a named local model from a base model + system prompt (Ollama Modelfile).
   * The user ends up with their OWN model artifact, e.g. `mia:latest`.
   */
  async createModel(cfg, { name, base, system }) {
    const res = await fetch(`${cfg.baseUrl}/api/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name, from: base, system, stream: false }),
      signal: AbortSignal.timeout(300000),
    });
    await ensureOk(res, 'Ollama create');
    return { model: name };
  },

  /** Batch-embed texts. Returns array of vectors. */
  async embed(cfg, model, texts) {
    const res = await fetch(`${cfg.baseUrl}/api/embed`, {
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
