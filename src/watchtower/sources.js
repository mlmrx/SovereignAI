/**
 * The watchtower's sources: where "what changed this week in local AI" is
 * actually published, first-hand.
 *
 * Curated and dated the same way the model shelf is, and for the same reason:
 * this is versioned opinion about who is worth watching, not a scrape of the
 * whole internet. Every entry says why it is here, so a future reader can
 * disagree with the choice rather than guess at it.
 *
 * Two rules decide what may go in this list:
 *
 *   1. It must be a PRIMARY source — the project's own releases, the vendor's
 *      own blog, the model's own card. The digest publishes automatically, so
 *      every fact in it is someone's own announcement of their own work, with
 *      a link back. There is no second-hand reporting here, because there is
 *      no human in the loop to catch a rewrite that drifted.
 *   2. It must be fetchable without a key, a browser, or a login. Anything
 *      that needs Cloudflare-defeating tricks is left out and read by hand —
 *      Perplexity's hub blog and Liquid AI's blog are both in that category
 *      today, which is why their models are watched through Hugging Face
 *      instead, where they publish the same releases in the open.
 *
 * `SOURCES_CURATED_AT` dates the opinion; a stale watchtower should look stale.
 */

export const SOURCES_CURATED_AT = '2026-08';

/** Where a source's items land in the digest, in the order the digest reads. */
export const CATEGORIES = [
  { id: 'engines', label: 'Engines', blurb: 'The local runtimes SovereignAI talks to, and the ones it could.' },
  { id: 'models', label: 'Models', blurb: 'Open weights published in the open, newest first.' },
  { id: 'rivals', label: 'The local-first wave', blurb: 'Everyone else building a private AI you run yourself.' },
  { id: 'platform', label: 'Hardware and platform', blurb: 'The silicon and the runtime everything above depends on.' },
  { id: 'security', label: 'Security', blurb: 'Advisories for what we run and what we recommend.' },
];

export const SOURCES = [
  // ---- engines: what actually serves a model on someone's machine ----
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'atom',
    url: 'https://github.com/ollama/ollama/releases.atom',
    category: 'engines',
    why: 'Our default engine. A release here can change what the starter shelf can honestly recommend.',
  },
  {
    id: 'freetoken',
    label: 'FreeToken',
    kind: 'atom',
    url: 'https://github.com/FlashML-org/FreeToken/releases.atom',
    category: 'engines',
    why: 'The sparse-MoE engine behind the frontier tier (ADR-25). Early enough that every release matters.',
  },
  {
    id: 'llama-cpp',
    label: 'llama.cpp',
    kind: 'atom',
    url: 'https://github.com/ggml-org/llama.cpp/releases.atom',
    category: 'engines',
    // It tags every CI build as a release — ten a day, titled "b10694". Those
    // are build artifacts, not news, and the first run of this watchtower
    // filled six of eight engine slots with them. `skip` drops the bare build
    // tags so the project appears only when it names a release something.
    skip: '^b\\d+$',
    perSource: 1,
    why: 'The layer most local engines are built on; its quantization work sets what fits on small machines. Watched narrowly: its release feed is a build log.',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    kind: 'atom',
    url: 'https://github.com/vllm-project/vllm/releases.atom',
    category: 'engines',
    why: 'What the rented-GPU rail (byoc gpu serve) actually runs.',
  },

  // ---- models: open weights, from the publishers we already size on the shelf ----
  {
    id: 'hf-qwen',
    label: 'Qwen',
    kind: 'huggingface',
    url: 'https://huggingface.co/api/models?author=Qwen&sort=createdAt&direction=-1&limit=12',
    category: 'models',
    why: 'Three shelf entries are theirs, including the reasoning pick and the sparse tier’s anchor.',
  },
  {
    id: 'hf-liquid',
    label: 'Liquid AI',
    kind: 'huggingface',
    url: 'https://huggingface.co/api/models?author=LiquidAI&sort=createdAt&direction=-1&limit=12',
    category: 'models',
    why: 'The cognition-role recommendation (LFM2.5) is theirs, and their blog has no feed — this is where they publish.',
  },
  {
    id: 'hf-openai',
    label: 'OpenAI open weights',
    kind: 'huggingface',
    url: 'https://huggingface.co/api/models?author=openai&sort=createdAt&direction=-1&limit=12',
    category: 'models',
    why: 'gpt-oss-20b and 120b are two of the five sparse entries.',
  },
  {
    id: 'hf-nvidia',
    label: 'NVIDIA models',
    kind: 'huggingface',
    url: 'https://huggingface.co/api/models?author=nvidia&sort=createdAt&direction=-1&limit=12',
    category: 'models',
    why: 'Nemotron is the one sparse entry Ollama pulls directly.',
  },
  {
    id: 'hf-google',
    label: 'Google open weights',
    kind: 'huggingface',
    url: 'https://huggingface.co/api/models?author=google&sort=createdAt&direction=-1&limit=12',
    category: 'models',
    why: 'Gemma is on the shelf twice, and Gemma 4 is the sparse multilingual pick.',
  },
  {
    id: 'hf-trending-gguf',
    label: 'Trending GGUF',
    kind: 'huggingface',
    url: 'https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=12&filter=gguf',
    category: 'models',
    why: 'GGUF is what Ollama pulls, so this is the closest thing to "what are people actually running at home this week".',
  },

  // ---- the local-first wave: everyone else solving the same problem ----
  {
    id: 'jan',
    label: 'Jan',
    kind: 'atom',
    url: 'https://github.com/janhq/jan/releases.atom',
    category: 'rivals',
    // It publishes dated dev checkpoints as releases alongside real ones.
    skip: '^checkpoint/',
    why: 'The closest thing to a direct competitor that is also open about what it does.',
  },
  {
    id: 'gpt4all',
    label: 'GPT4All',
    kind: 'atom',
    url: 'https://github.com/nomic-ai/gpt4all/releases.atom',
    category: 'rivals',
    why: 'The long-running local desktop app; a useful barometer for what "normal person runs a model" means.',
  },
  {
    id: 'exo',
    label: 'Exo',
    kind: 'atom',
    url: 'https://github.com/exo-explore/exo/releases.atom',
    category: 'rivals',
    why: 'Cluster-your-own-devices inference, and the lab behind the local.ai benchmarks we cite.',
  },

  // ---- platform: what everything above runs on ----
  {
    id: 'huggingface-blog',
    label: 'Hugging Face blog',
    kind: 'rss',
    url: 'https://huggingface.co/blog/feed.xml',
    category: 'platform',
    why: 'Where a new quantization format or licensing change is explained first.',
  },
  {
    id: 'nvidia-blog',
    label: 'NVIDIA blog',
    kind: 'rss',
    url: 'https://blogs.nvidia.com/feed/',
    category: 'platform',
    why: 'DGX Spark, RTX, and the driver stack the sparse tier depends on. High volume — filtered hard.',
  },
  {
    id: 'node-releases',
    label: 'Node.js releases',
    kind: 'atom',
    url: 'https://github.com/nodejs/node/releases.atom',
    category: 'platform',
    why: 'The entire runtime. node:sqlite lives here, and our floor is 22.5.',
  },

  // ---- security: routed to an issue, never to a blog post ----
  {
    id: 'node-security',
    label: 'Node.js security',
    kind: 'rss',
    url: 'https://nodejs.org/en/feed/vulnerability.xml',
    category: 'security',
    why: 'We ship single binaries with Node inside them; a Node CVE is our CVE.',
  },
];

/**
 * Words that make an item worth publishing from a high-volume, general-purpose
 * source. NVIDIA's blog posts a dozen items a week about autonomous vehicles
 * and healthcare; two of them a month are about the hardware our readers run.
 * Sources not listed in `NOISY` are published unfiltered, because they are
 * already about exactly one thing.
 */
export const NOISY = new Set(['nvidia-blog', 'huggingface-blog']);

// Terms that mark an item as being about running models, not about the
// company that also makes graphics cards.
//
// This filter has been wrong twice, and both lessons are baked in. "rtx" and
// "geforce" let through two Gamescom stories, so hardware brand names are gone
// entirely. Then "fine-tun" alone let through a DLSS announcement, because a
// single weak substring is not evidence of anything. So terms now come in two
// strengths: one STRONG term is enough on its own, while WEAK terms need to
// arrive in pairs. A keyword filter is a claim about meaning, and it should be
// made carefully when nobody reads the result before it publishes.
export const STRONG = [
  'llm', 'language model', 'open model', 'open weight', 'open-weight', 'quantiz', 'gguf',
  'inference', 'local ai', 'dgx', 'tensorrt', 'nim microservice', 'mixture of experts',
  'nemotron', 'gemma', 'qwen', 'llama', 'mistral', 'deepseek', 'ollama', 'vllm', 'transformers',
];
export const WEAK = ['on-device', 'on device', 'cuda', 'vram', 'fine-tun', 'finetun', 'lora', 'embedding', 'context window', 'tokens per second'];

/**
 * Titles this watchtower will not publish unattended.
 *
 * Not a judgement about the ecosystem — anyone may run whatever weights they
 * like, and a person browsing Hugging Face will meet all of this anyway. It is
 * a judgement about US: a link on a company blog reads as a recommendation,
 * and there is no editor here to decide that this week's trending upload is
 * one we want to be seen recommending. When nobody is reading before it
 * publishes, the safe default is to publish less.
 */
export const NEVER_PUBLISH = [
  'uncensored', 'abliterated', 'unaligned', 'nsfw', 'erotic', 'waifu', 'jailbr',
];

export function isPublishable(item) {
  const title = String(item?.title ?? '').toLowerCase();
  return !NEVER_PUBLISH.some((term) => title.includes(term));
}

/** Whether an item from `sourceId` earns a place in the digest. */
export function isRelevant(sourceId, item) {
  const source = SOURCES.find((entry) => entry.id === sourceId);
  // A source may declare titles that are build artifacts rather than news.
  if (source?.skip && new RegExp(source.skip).test(item?.title ?? '')) return false;
  if (!NOISY.has(sourceId)) return true;
  const hay = `${item?.title ?? ''} ${item?.summary ?? ''}`.toLowerCase();
  if (STRONG.some((term) => hay.includes(term))) return true;
  return WEAK.filter((term) => hay.includes(term)).length >= 2;
}

/**
 * How many items one source may contribute to a single digest. The default is
 * deliberately small: a digest is a read, and one chatty repository must never
 * be able to crowd out fifteen quieter ones. A source that publishes rarely
 * loses nothing; a source that publishes hourly stops dominating.
 */
export const DEFAULT_PER_SOURCE = 2;

export function perSourceLimit(sourceId) {
  return SOURCES.find((entry) => entry.id === sourceId)?.perSource ?? DEFAULT_PER_SOURCE;
}
