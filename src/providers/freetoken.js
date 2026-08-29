import { ensureOk } from './parsers.js';
import { safeFetch } from '../util.js';
import { openai } from './openai.js';

/**
 * FreeToken — a local MoE inference engine (github.com/FlashML-org/FreeToken)
 * that serves one open-weight model per process on http://127.0.0.1:1919 with
 * an OpenAI-compatible chat API and no request auth of any kind.
 *
 * The chat/model-list surface is the OpenAI-compatible one, so those methods
 * are shared with the openai provider (spread below — `this.headers(cfg)`
 * inside them binds to this object when called as freetoken.chatStream()).
 * Only the health check is FreeToken's own: GET /health reports a status that
 * stays "ok" while the engine is rebuilding or stopping, so readiness has to
 * read the `maintenance` field too, and a loading engine says how far along
 * it is — which is worth showing instead of a bare "unreachable".
 */
export const freetoken = {
  ...openai,
  id: 'freetoken',
  label: 'FreeToken',

  async health(cfg) {
    const res = await safeFetch(`${cfg.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    await ensureOk(res, 'FreeToken');
    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return readFreeTokenHealth(body);
  },
};

/**
 * Turn a /health body into the provider's verdict: `{ ok, detail }` when the
 * engine is serving, a throw carrying the reason when it is not. Split out
 * from the fetch so detection (a wizard or the doctor asking whether an engine
 * nobody enabled is nonetheless running) reads the same body with the same
 * wording, from one request — two code paths describing one engine is how a
 * setup screen and a diagnostic come to disagree about the same machine.
 */
export function readFreeTokenHealth(body) {
  if (!isFreeTokenHealth(body)) {
    throw new Error('FreeToken health check returned an unexpected shape — is this a FreeToken server?');
  }
  const model = optionalText(body.model);
  if (body.status === 'ok') {
    // A missing maintenance field predates the field and means "serving".
    const maintenance = optionalText(body.maintenance) ?? 'serving';
    if (maintenance !== 'serving') throw new Error(`FreeToken is not serving right now (${maintenance})`);
    const version = optionalText(body.version);
    return { ok: true, detail: `FreeToken${version ? ` ${version}` : ''}${model ? ` · serving ${model}` : ''}` };
  }
  if (body.status === 'loading') {
    const phase = optionalText(body.phase);
    const done = Number(body.progress?.done_bytes);
    const total = Number(body.progress?.total_bytes);
    const pct = Number.isFinite(total) && total > 0 && Number.isFinite(done) ? Math.round((done / total) * 100) : null;
    throw new Error(
      `FreeToken is still loading ${model ?? 'its model'}` + (phase ? ` (${phase}${pct !== null ? ` ${pct}%` : ''})` : '')
    );
  }
  if (body.status === 'error') {
    throw new Error(`FreeToken engine error: ${optionalText(body.message) ?? 'no message'}`);
  }
  throw new Error(`FreeToken reported an unknown status (${clean(body.status)})`);
}

/** Every /health shape FreeToken emits carries a string status and an instance_id. */
export function isFreeTokenHealth(body) {
  return Boolean(body) && typeof body === 'object' && typeof body.status === 'string' && 'instance_id' in body;
}

// Server-provided strings end up on a terminal line or a status pill:
// single line, no control characters, bounded length.
function clean(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 240);
}

function optionalText(value) {
  if (typeof value !== 'string') return null;
  const text = clean(value);
  return text || null;
}
