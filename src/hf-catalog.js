/**
 * Read-only browse of Hugging Face's public model catalog for Model Studio's
 * "base model" field. This lets an operator find an open-weight GGUF repo and
 * fill in a `hf.co/<owner>/<repo>[:<quant>]` base without leaving the app.
 *
 * Ollama already accepts `hf.co/...` as a `base` value directly (see
 * providers/ollama.js#createModel, which passes `base` through unchanged as
 * `from`), and model-recipes.js already accepts any single-line string there.
 * Nothing here changes what a recipe can build — it only helps fill in that
 * field. No weights are downloaded or proxied through SovereignAI; a build
 * still pulls straight from Hugging Face to the configured Ollama endpoint.
 *
 * The outbound host is a fixed constant (never derived from a request), so
 * this intentionally does not need the provider-URL SSRF allow/deny logic in
 * config.js — that guard exists for *user-supplied* endpoints. `safeFetch`
 * still refuses to follow redirects, matching every other outbound call in
 * this codebase.
 */

import { safeFetch } from './util.js';

const HF_API = 'https://huggingface.co/api';
const SEARCH_LIMIT = 20;
const MAX_QUERY_LENGTH = 200;
const REQUEST_TIMEOUT_MS = 8000;
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export class HfCatalogError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'HfCatalogError';
    this.status = status;
  }
}

/** Search Hugging Face for public GGUF-format model repos. */
export async function searchGgufModels(query) {
  const q = String(query ?? '').trim();
  if (!q) throw new HfCatalogError('Search query is required', 400);
  if (q.length > MAX_QUERY_LENGTH) throw new HfCatalogError('Search query is too long', 400);

  const url = new URL(`${HF_API}/models`);
  url.searchParams.set('search', q);
  url.searchParams.set('filter', 'gguf');
  url.searchParams.set('sort', 'downloads');
  url.searchParams.set('direction', '-1');
  url.searchParams.set('limit', String(SEARCH_LIMIT));

  const data = await fetchJson(url);
  if (!Array.isArray(data)) throw new HfCatalogError('Hugging Face returned an unexpected response shape', 502);
  return data.map(summarizeModel).filter((model) => model.id);
}

/**
 * List GGUF files (quantization variants) published in one Hugging Face repo,
 * plus the repo's declared weight license. "Open weights" is not "open
 * license" (community licenses, research-only releases) — surfacing the
 * declared license at selection time is disclosure-at-the-point-of-use,
 * same rule as every other boundary in this product. `null` means the repo
 * declares none: reported as unlisted, never guessed.
 */
export async function listGgufFiles(repo) {
  const id = validateRepoId(repo);
  const data = await fetchJson(new URL(`${HF_API}/models/${id}`));
  const siblings = Array.isArray(data?.siblings) ? data.siblings : [];
  const filenames = siblings
    .map((sibling) => String(sibling?.rfilename ?? ''))
    .filter((name) => name.toLowerCase().endsWith('.gguf'))
    .sort();

  const tags = Array.isArray(data?.tags) ? data.tags : [];
  const licenseTag = tags.find((tag) => typeof tag === 'string' && tag.startsWith('license:'));
  const cardLicense = typeof data?.cardData?.license === 'string' ? data.cardData.license : null;

  return {
    license: licenseTag ? licenseTag.slice('license:'.length) : cardLicense,
    files: filenames.map((filename) => {
      const quantization = guessQuantization(filename);
      return {
        filename,
        quantization,
        base: quantization ? `hf.co/${id}:${quantization}` : `hf.co/${id}`,
      };
    }),
  };
}

function validateRepoId(repo) {
  const id = String(repo ?? '').trim();
  if (!id) throw new HfCatalogError('A Hugging Face repo id is required', 400);
  if (id.length > MAX_QUERY_LENGTH) throw new HfCatalogError('Repo id is too long', 400);
  if (!REPO_PATTERN.test(id)) throw new HfCatalogError('Repo id must look like owner/name', 400);
  return id;
}

function summarizeModel(item) {
  const id = typeof item?.id === 'string' ? item.id.trim() : '';
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  const licenseTag = tags.find((tag) => typeof tag === 'string' && tag.startsWith('license:'));
  return {
    id,
    url: id ? `https://huggingface.co/${id}` : null,
    downloads: Number.isFinite(item?.downloads) ? item.downloads : null,
    likes: Number.isFinite(item?.likes) ? item.likes : null,
    license: licenseTag ? licenseTag.slice('license:'.length) : null,
    updatedAt: typeof item?.lastModified === 'string' ? item.lastModified : null,
  };
}

// GGUF filenames encode the quantization right before ".gguf", separated by
// ".", "-", or "_" — older conversions use a dot ("llama-2-7b.Q4_K_M.gguf"),
// but common conversions (e.g. bartowski's) use a hyphen
// ("Llama-3.2-1B-Instruct-Q4_K_M.gguf", "...-Q4_0_4_4.gguf", "...-f16.gguf").
// Matching only a dot-separated suffix (an earlier version of this function
// did) silently misses that hyphenated majority, so this matches a known
// llama.cpp quant-label shape instead of "whatever token comes last". The
// label is what Ollama matches against a `hf.co/...:TAG` reference. Single-
// file repos without a recognizable label have no quantization to select.
const QUANT_PATTERN = /(?:^|[._-])((?:I?Q[1-8](?:_[A-Z0-9]+)*|TQ[12]_[A-Z0-9]+|BF16|F(?:P)?16|F32))\.gguf$/i;
function guessQuantization(filename) {
  const match = QUANT_PATTERN.exec(filename);
  return match ? match[1].toUpperCase() : null;
}

async function fetchJson(url) {
  let res;
  try {
    res = await safeFetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    throw new HfCatalogError(`Could not reach huggingface.co: ${err.message}`, 502);
  }
  if (!res.ok) {
    throw new HfCatalogError(`Hugging Face API returned HTTP ${res.status}`, res.status === 429 ? 429 : 502);
  }
  try {
    return await res.json();
  } catch {
    throw new HfCatalogError('Hugging Face returned an invalid response', 502);
  }
}
