'use strict';
/* The command center, running in public on a workspace that does not exist.
 *
 * This file ships with the app but is INERT anywhere except the public demo
 * host: on your own machine it returns immediately and the real server answers
 * every call, byte for byte as before. On mysovereign.ai there is no server at
 * all, so it answers the app's own fetches from a fixture — which means the
 * page a visitor clicks through is the product's real app.html and app.js,
 * not a mock-up of them. Only the data is invented, and the banner says so.
 *
 * The fixture's resident is Atlas, the same scripted persona the other demo
 * surfaces use, so the whole playground tells one consistent fiction.
 */
(() => {
  if (!/(^|\.)mysovereign\.ai$|\.vercel\.app$/.test(location.hostname)) return;

  const now = Date.now();
  const ago = (days, hours = 0) => new Date(now - days * 864e5 - hours * 36e5).toISOString();
  const clone = (value) => JSON.parse(JSON.stringify(value));

  /* ---------------- the workspace ---------------- */
  const personas = [
    { id: 'p-atlas', name: 'Atlas', description: 'The everyday mind — direct, warm, cites its receipts.', system_prompt: 'You are the user\'s sovereign AI.', provider: null, model: null, temperature: null, use_memory: 1, use_knowledge: 1, created_at: ago(96), updated_at: ago(11) },
    { id: 'p-scribe', name: 'Scribe', description: 'Long-form drafting with the citations left in.', system_prompt: 'You draft carefully.', provider: null, model: null, temperature: 0.4, use_memory: 1, use_knowledge: 1, created_at: ago(90), updated_at: ago(30) },
    { id: 'p-ledger', name: 'Ledger', description: 'Money, renewals, and contracts. Nothing leaves the house.', system_prompt: 'You are precise about numbers.', provider: 'ollama', model: 'llama3.1:latest', temperature: 0.2, use_memory: 1, use_knowledge: 1, created_at: ago(74), updated_at: ago(6) },
  ];

  let memories = [
    { id: 'm-1', content: 'Prefers Friday demos with the whole team present.', created_at: ago(37), origin: 'manual', source_conversation_id: null, updated_at: null, author_provider: null, author_model: null },
    { id: 'm-2', content: 'Ships on Windows 11, tests against WSL Ubuntu before every release.', created_at: ago(31), origin: 'extracted', source_conversation_id: 'c-2', updated_at: null, author_provider: 'ollama', author_model: 'llama3.1:latest' },
    { id: 'm-3', content: 'Decided in March to keep the mortgage variable — revisit if base rate passes 5%.', created_at: ago(29), origin: 'distilled', source_conversation_id: 'c-3', updated_at: null, author_provider: 'ollama', author_model: 'llama3.1:latest' },
    { id: 'm-4', content: 'The studio lease renews every March; the notice window is 60 days.', created_at: ago(22), origin: 'distilled', source_conversation_id: 'c-4', updated_at: null, author_provider: 'ollama', author_model: 'llama3.1:latest' },
    { id: 'm-5', content: 'Wants answers short, with the reasoning shown underneath.', created_at: ago(18), origin: 'extracted', source_conversation_id: 'c-1', updated_at: ago(4), author_provider: 'ollama', author_model: 'llama3.1:latest' },
    { id: 'm-6', content: 'Allergic to penicillin — noted from the pharmacy import, not from chat.', created_at: ago(15), origin: 'distilled', source_conversation_id: null, updated_at: null, author_provider: 'ollama', author_model: 'llama3.1:latest' },
    { id: 'm-7', content: 'Drinks too much espresso.', created_at: ago(240), origin: null, source_conversation_id: null, updated_at: null, author_provider: null, author_model: null },
    { id: 'm-8', content: 'Nephew\'s birthday is 12 October; he is into model trains this year.', created_at: ago(9), origin: 'manual', source_conversation_id: null, updated_at: null, author_provider: null, author_model: null },
  ];

  let documents = [
    { id: 'd-1', name: 'studio-lease-2026.pdf', size: 384_221, chunk_count: 42, embedded: 42, created_at: ago(46) },
    { id: 'd-2', name: 'insurance-policy-shield.pdf', size: 221_004, chunk_count: 28, embedded: 28, created_at: ago(40) },
    { id: 'd-3', name: 'board-minutes-q2.docx', size: 96_400, chunk_count: 17, embedded: 17, created_at: ago(24) },
    { id: 'd-4', name: 'mortgage-offer.pdf', size: 512_880, chunk_count: 55, embedded: 0, created_at: ago(12) },
    { id: 'd-5', name: 'warranty-espresso-machine.pdf', size: 48_120, chunk_count: 6, embedded: 6, created_at: ago(5) },
  ];

  const conversations = [
    { id: 'c-1', persona_id: 'p-atlas', title: 'How I want answers written', created_at: ago(40), updated_at: ago(18), distilled_at: ago(17) },
    { id: 'c-2', persona_id: 'p-atlas', title: 'Release checklist for 0.5', created_at: ago(33), updated_at: ago(31), distilled_at: ago(30) },
    { id: 'c-3', persona_id: 'p-ledger', title: 'Fixed or variable, one more time', created_at: ago(30), updated_at: ago(29), distilled_at: ago(28) },
    { id: 'c-4', persona_id: 'p-ledger', title: 'What the studio lease actually says', created_at: ago(23), updated_at: ago(22), distilled_at: ago(21) },
    { id: 'c-5', persona_id: 'p-scribe', title: 'Draft: letter to the insurer', created_at: ago(6), updated_at: ago(6), distilled_at: null },
  ];

  const messages = {
    'c-4': [
      { id: 'x-1', conversation_id: 'c-4', role: 'user', content: 'When does the studio lease renew, and how long is the notice window?', provider: null, model: null, model_digest: null, tokens_in: null, tokens_out: null, created_at: ago(23) },
      { id: 'x-2', conversation_id: 'c-4', role: 'assistant', content: 'It renews every March, and the notice window is 60 days — so the last useful date to give notice is the end of December.\n\nThat comes from clause 14 of studio-lease-2026.pdf, which I have indexed; the renewal date also matches a reminder that arrived in your inbox import.', provider: 'ollama', model: 'llama3.1:latest', model_digest: 'sha256:46e0c10c039e', tokens_in: 2210, tokens_out: 96, created_at: ago(23) },
    ],
  };

  const lifeRecords = {
    counts: { total: 514 },
    // Field names follow what the Mind view actually reads (occurrences /
    // daysSinceLastSeen on the audit, merchant / daysAway / subject on the
    // radar) — a fixture that invents its own keys renders "undefined".
    audit: {
      estimatedMonthly: 268.4,
      recurring: [
        { merchant: 'IronWorks Gym', amount: 49, currency: 'USD', cadence: 'monthly', occurrences: 14, daysSinceLastSeen: 8, confidence: 'high' },
        { merchant: 'Shield Insurance', amount: 103.33, currency: 'USD', cadence: 'monthly', occurrences: 11, daysSinceLastSeen: 12, confidence: 'high' },
        { merchant: 'Adobe Creative Cloud', amount: 59.99, currency: 'USD', cadence: 'monthly', occurrences: 22, daysSinceLastSeen: 3, confidence: 'high' },
        { merchant: 'Cloud storage (2TB)', amount: 9.99, currency: 'USD', cadence: 'monthly', occurrences: 19, daysSinceLastSeen: 6, confidence: 'medium' },
        { merchant: 'Streaming bundle', amount: 46.09, currency: 'USD', cadence: 'monthly', occurrences: 9, daysSinceLastSeen: 2, confidence: 'medium' },
      ],
    },
    renewals: {
      undated: 3,
      upcoming: [
        { merchant: 'IronWorks Gym', daysAway: 29, amount: 588, currency: 'USD', subject: 'Your membership renews automatically — cancellation window closes in 1 day', confidence: 'high' },
        { merchant: 'Shield Insurance', daysAway: 12, amount: 1240, currency: 'USD', subject: 'Annual premium due — policy SH-40192', confidence: 'high' },
        { merchant: 'Passport (Home Office)', daysAway: 96, amount: null, currency: null, subject: 'Travel document expiry noted from a booking confirmation', confidence: 'medium' },
      ],
    },
  };

  const byOrigin = () => {
    const c = { manual: 0, extracted: 0, distilled: 0, untracked: 0 };
    for (const m of memories) c[m.origin && c[m.origin] !== undefined ? m.origin : 'untracked']++;
    return c;
  };

  const FIXTURES = () => ({
    '/api/status': {
      name: 'Atlas', version: '0.5.0', uptimeSeconds: 82_400,
      counts: { personas: personas.length, conversations: conversations.length, documents: documents.length, memories: memories.length, training_projects: 1 },
      defaults: { provider: 'ollama', model: 'llama3.1:latest' },
      setupComplete: true,
    },
    '/api/config': {
      name: 'Atlas', host: '127.0.0.1', port: 4321, authToken: '••••••••',
      providers: {
        ollama: { enabled: true, baseUrl: 'http://localhost:11434' },
        freetoken: { enabled: true, baseUrl: 'http://127.0.0.1:1919' },
        openai: { enabled: false, baseUrl: 'https://api.openai.com', apiKey: '' },
        anthropic: { enabled: true, baseUrl: 'https://api.anthropic.com', apiKey: '••••••••' },
      },
      defaults: { provider: 'ollama', model: 'llama3.1:latest' },
      embeddings: { provider: 'ollama', model: 'nomic-embed-text' },
      memory: { autoExtract: true, extractLocalOnly: true, extractionModel: 'llama3.1:latest' },
      privacy: { outgoingPreview: 'ask', outgoingPreviewTrusted: [] },
      training: { enabled: false, baseUrl: 'http://127.0.0.1:7331', authToken: '', allowRemote: false, allowInsecurePrivateNetwork: false },
      limits: { historyChars: 24_000, ragChunks: 6, maxTokens: 32_000 },
      trustedExtensionOrigins: [], setupComplete: true,
    },
    '/api/mind': {
      name: 'Atlas',
      memories: { ...byOrigin(), total: memories.length, recent: memories.slice(0, 5).map(clone) },
      imports: { platforms: [{ platform: 'chatgpt', conversations: 212 }, { platform: 'claude', conversations: 64 }], conversations: 276, undistilled: 0 },
      documents: { count: documents.length, embedded: documents.filter((d) => d.embedded > 0).length },
    },
    '/api/personas': personas,
    '/api/conversations': conversations,
    '/api/memories': memories,
    '/api/documents': documents,
    '/api/life': lifeRecords,
    '/api/providers': [
      { id: 'ollama', label: 'Ollama', enabled: true, configured: true, local: true, ok: true, detail: 'Ollama 0.6.6 · 3 models' },
      { id: 'freetoken', label: 'FreeToken', enabled: true, configured: true, local: true, ok: true, detail: 'FreeToken 0.1.2 · serving gemma-4-26B-A4B-it' },
      { id: 'openai', label: 'OpenAI-compatible', enabled: false, configured: false, local: false },
      { id: 'anthropic', label: 'Anthropic (Claude)', enabled: true, configured: true, local: false, ok: true, detail: 'key present' },
    ],
    '/api/models': [{ provider: 'ollama', models: [
      { id: 'llama3.1:latest', label: 'llama3.1:latest', digest: '46e0c10c039e019119339687c3c1757cc81b9da49709a3b3924863ba87ca666e' },
      { id: 'deepseek-r1:8b', label: 'deepseek-r1:8b', digest: '28f8fd6cdc677661426adab9338ce3c013d7e69a5bea9e704b36418a2f4ef7cf' },
      { id: 'nomic-embed-text:latest', label: 'nomic-embed-text:latest', digest: '0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947ec8f4d0d0c0e' },
    ] }],
    '/api/model-recipes': [
      { id: 'r-1', name: 'atlas-terse', base: 'llama3.1:latest', status: 'built', created_at: ago(20) },
    ],
    '/api/portfolio': { markdown: '# Atlas — portfolio\n\n_A seed crystal of this workspace: memories with provenance, personas, and a knowledge inventory. Paste it into any AI you will ever use._\n\n## Memories (8)\n' + memories.map((m) => `- ${m.content} _(${m.origin || 'origin unknown'})_`).join('\n') },
    '/api/search': [
      { id: 'k-1', documentId: 'd-1', document: 'studio-lease-2026.pdf', content: 'STUDIO LEASE AGREEMENT — 2026. Clause 3. Term. The initial term runs twelve months from 1 March 2026. Clause 14. Renewal. This agreement renews automatically for successive one-year terms each March unless either party gives written notice of non-renewal no later than sixty (60) days before the renewal date. Rent for any renewal term increases by the lesser of 3% or the published CPI figure. Clause 15. Deposit. The security deposit of two months’ rent is held in a separate account and returned within 30 days of move-out, less documented damages.', score: 0.48, method: 'keyword', rank: 1.63, coverage: 1, terms: ['lease', 'renew'], focus: 'Clause 14. Renewal. This agreement renews automatically for successive one-year terms each March unless either party gives written notice of non-renewal no later than sixty (60) days before the renewal date.' },
      { id: 'k-2', documentId: 'd-5', document: 'ops-meeting-2026-08-12.md', content: 'Ops meeting, 12 August 2026. Lease: renewal window opens in January; decide by 1 January whether to give notice (60 days before 1 March). Ask landlord about the CPI clause. Insurance: renewal quote due in October; get two comparison quotes. Subscriptions audit: cancel the two design tools nobody used since May.', score: 0.55, method: 'keyword', rank: 1.55, coverage: 1, terms: ['lease', 'renew'], focus: 'Lease: renewal window opens in January; decide by 1 January whether to give notice (60 days before 1 March). Ask landlord about the CPI clause.' },
      { id: 'k-3', documentId: 'd-2', document: 'insurance-policy-shield.pdf', content: 'SHIELD CONTENTS INSURANCE — POLICY SCHEDULE. The policy term runs twelve months from the commencement date stated in the schedule and renews on written confirmation. Studio equipment is covered up to $40,000 per event; the excess is $500. Claims must be lodged within 14 days.', score: 1, method: 'keyword', rank: 1.5, coverage: 0.5, terms: ['renew'], focus: 'The policy term runs twelve months from the commencement date stated in the schedule and renews on written confirmation. Studio equipment is covered up to $40,000 per event; the excess is $500.' },
    ],
    // The starter shelf and the sizing hint as a 32 GB / RTX 4060 (8 GB) box
    // sees them — generated from the real sizing rules, not hand-tuned. Before
    // these existed the demo answered {} and the shelf threw a TypeError.
    '/api/model-shelf': {
      curatedAt: '2026-08',
      note: 'A dated, opinionated starter shelf — not a leaderboard. The landscape churns monthly: verify current versions and licenses on Hugging Face before relying on an entry. Weight licenses belong to their publishers.',
      sizedAgainst: 'this machine',
      gpu: { vramGB: 8, name: 'NVIDIA GeForce RTX 4060', unifiedMemory: false, source: 'nvidia-smi' },
      roles: [
        { role: 'everyday-chat', label: 'Everyday chat', job: 'The default local brain: general questions, drafting, summarizing.', models: [
          { base: 'gemma3:4b', hf: 'google/gemma-3-4b-it', paramsB: 4, license: 'Gemma Terms of Use (Google — use restrictions apply)', why: 'Best small all-rounder of its generation; strong multilingual.', architecture: 'dense', engine: 'ollama', approxGBAtQ4: 2.4, fit: 'fits', engineEnabled: null },
          { base: 'qwen3:8b', hf: 'Qwen/Qwen3-8B', paramsB: 8, license: 'Apache-2.0', why: 'Stronger reasoning headroom when you have the RAM; permissive license.', architecture: 'dense', engine: 'ollama', approxGBAtQ4: 4.8, fit: 'fits', engineEnabled: null },
          { base: 'llama3.2:3b', hf: 'meta-llama/Llama-3.2-3B-Instruct', paramsB: 3, license: 'Llama Community License (Meta)', why: 'Reliable, widely fine-tuned baseline with a huge ecosystem.', architecture: 'dense', engine: 'ollama', approxGBAtQ4: 1.8, fit: 'fits', engineEnabled: null },
        ] },
        { role: 'memory-cognition', label: 'Memory & cognition', job: 'The model that WRITES your memory: auto-extraction and distillation. Small, fast, and local — pair it with \'cognition stays home\'.', models: [
          { base: 'qwen3:4b', hf: 'Qwen/Qwen3-4B', paramsB: 4, license: 'Apache-2.0', why: 'Follows the extraction format reliably; cheap enough to run per exchange.', architecture: 'dense', engine: 'ollama', approxGBAtQ4: 2.4, fit: 'fits', engineEnabled: null },
          { base: 'llama3.2:1b', hf: 'meta-llama/Llama-3.2-1B-Instruct', paramsB: 1, license: 'Llama Community License (Meta)', why: 'Runs on anything; good enough for fact extraction on modest machines.', architecture: 'dense', engine: 'ollama', approxGBAtQ4: 0.6, fit: 'fits', engineEnabled: null },
          { base: 'hf.co/LiquidAI/LFM2.5-2.6B-GGUF', hf: 'LiquidAI/LFM2.5-2.6B-GGUF', paramsB: 2.6, license: 'LFM Open License v1.0 (custom — commercial use only under US$10M annual revenue; read it)', why: 'Liquid AI’s hybrid on-device architecture with a 131K context; its card cites ~113 tokens/s on a Ryzen CPU in about 2.5 GB.', architecture: 'dense', engine: 'ollama', approxGBAtQ4: 1.6, fit: 'fits', engineEnabled: null },
        ] },
        { role: 'reasoning', label: 'Reasoning & analysis', job: 'Multi-step thinking on your own hardware: plans, math, tricky questions.', models: [
          { base: 'qwen3.8:27b', hf: 'Qwen/Qwen3.8-27B', paramsB: 27, license: 'Apache-2.0', why: 'The strongest open dense model a 32 GB machine can run at Q4 (tight there, comfortable from 48): thinking mode, image and video input, 262K native context. The model Perplexity’s Portable Computer runs locally at launch.', architecture: 'dense', engine: 'ollama', approxGBAtQ4: 16.2, fit: 'tight', engineEnabled: null },
          { base: 'deepseek-r1:7b', hf: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', paramsB: 7, license: 'MIT', why: 'Frontier reasoning distilled into a laptop-sized model.', architecture: 'dense', engine: 'ollama', approxGBAtQ4: 4.2, fit: 'fits', engineEnabled: null },
          { base: 'phi4-mini', hf: 'microsoft/Phi-4-mini-instruct', paramsB: 3.8, license: 'MIT', why: 'Punches far above its size on structured reasoning; MIT weights.', architecture: 'dense', engine: 'ollama', approxGBAtQ4: 2.3, fit: 'fits', engineEnabled: null },
        ] },
        { role: 'coding', label: 'Coding', job: 'Code completion and questions inside the editor integrations.', models: [
          { base: 'qwen2.5-coder:7b', hf: 'Qwen/Qwen2.5-Coder-7B-Instruct', paramsB: 7, license: 'Apache-2.0', why: 'The strongest small code model of its generation.', architecture: 'dense', engine: 'ollama', approxGBAtQ4: 4.2, fit: 'fits', engineEnabled: null },
          { base: 'qwen2.5-coder:1.5b', hf: 'Qwen/Qwen2.5-Coder-1.5B-Instruct', paramsB: 1.5, license: 'Apache-2.0', why: 'Fast-enough completions on machines without a GPU.', architecture: 'dense', engine: 'ollama', approxGBAtQ4: 0.9, fit: 'fits', engineEnabled: null },
        ] },
        { role: 'embeddings', label: 'Embeddings (semantic search)', job: 'Powers knowledge retrieval. Set it under Settings → Knowledge embeddings; BM25 keyword search always works without it.', models: [
          { base: 'nomic-embed-text', hf: 'nomic-ai/nomic-embed-text-v1.5', paramsB: 0.14, license: 'Apache-2.0', why: 'The default: small, solid, permissive.', architecture: 'dense', engine: 'ollama', approxGBAtQ4: 0.1, fit: 'fits', engineEnabled: null },
          { base: 'bge-m3', hf: 'BAAI/bge-m3', paramsB: 0.57, license: 'MIT', why: 'Stronger multilingual retrieval when your documents aren’t only English.', architecture: 'dense', engine: 'ollama', approxGBAtQ4: 0.3, fit: 'fits', engineEnabled: null },
        ] },
        { role: 'vision', label: 'Vision (experimental)', job: 'Describe or read images locally.', models: [
          { base: 'moondream', hf: 'vikhyatk/moondream2', paramsB: 1.9, license: 'Apache-2.0', why: 'Tiny image understanding that runs anywhere.', architecture: 'dense', engine: 'ollama', approxGBAtQ4: 1.1, fit: 'fits', engineEnabled: null },
          { base: 'gemma3:12b', hf: 'google/gemma-3-12b-it', paramsB: 12, license: 'Gemma Terms of Use (Google — use restrictions apply)', why: 'Multimodal chat with real quality, if you have the RAM.', architecture: 'dense', engine: 'ollama', approxGBAtQ4: 7.2, fit: 'fits', engineEnabled: null },
        ] },
        { role: 'frontier-moe', label: 'Frontier-class, locally (sparse MoE)', engine: 'freetoken', job: 'Big sparse models on one gaming GPU plus host RAM: the experts live in RAM and only the few active per token hit the GPU. Served by FreeToken (one entry ships as GGUF and Ollama pulls it directly) — pick one as your default model rather than as a recipe base.', models: [
          { base: 'Qwen/Qwen3.6-35B-A3B', hf: 'Qwen/Qwen3.6-35B-A3B', paramsB: 35, activeParamsB: 3, architecture: 'moe', license: 'Apache-2.0', why: 'The model FreeToken was built around: 35B of knowledge, about 3B active per token — comfortable from 48 GB of RAM, borderline at 32.', engine: 'freetoken', approxGBAtQ4: 21, fit: 'too-big', engineEnabled: true, approxActiveGBAtQ4: 1.8, gpuFit: 'fits' },
          { base: 'openai/gpt-oss-20b', hf: 'openai/gpt-oss-20b', paramsB: 21, activeParamsB: 3.6, architecture: 'moe', license: 'Apache-2.0', why: 'OpenAI’s open-weight reasoning model in its native MXFP4 — about 13 GB on disk, with real chain-of-thought.', engine: 'freetoken', approxGBAtQ4: 12.6, fit: 'fits', engineEnabled: true, approxActiveGBAtQ4: 2.2, gpuFit: 'fits' },
          { base: 'google/gemma-4-26B-A4B-it', hf: 'google/gemma-4-26B-A4B-it', paramsB: 25.2, activeParamsB: 3.8, architecture: 'moe', license: 'Apache-2.0', why: 'Google’s sparse Gemma 4: strong multilingual chat; multimodal upstream, served text-only here.', engine: 'freetoken', approxGBAtQ4: 15.1, fit: 'tight', engineEnabled: true, approxActiveGBAtQ4: 2.3, gpuFit: 'fits' },
          { base: 'nemotron-3.5-lightning:30b', hf: 'nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16', paramsB: 30, activeParamsB: 3, architecture: 'moe', engine: 'ollama', license: 'OpenMDW-1.1 (commercial use allowed)', why: 'NVIDIA’s sparse hybrid (Mamba-2, attention, and MoE layers): 30B of experts, 3B active per token, a 1M context — the first frontier-tier sparse model Ollama pulls directly. About 18 GB at Q4 by our rule, so 32 GB of RAM is tight and 48 comfortable.', approxGBAtQ4: 18, fit: 'tight', engineEnabled: null, approxActiveGBAtQ4: 1.8, gpuFit: null },
          { base: 'openai/gpt-oss-120b', hf: 'openai/gpt-oss-120b', paramsB: 117, activeParamsB: 5.1, architecture: 'moe', license: 'Apache-2.0', why: 'Near-frontier reasoning on a single desktop GPU — its experts are ~70 GB at Q4, and every one of them must live in host RAM.', engine: 'freetoken', approxGBAtQ4: 70.2, fit: 'too-big', engineEnabled: true, approxActiveGBAtQ4: 3.1, gpuFit: 'fits' },
        ] },
      ],
    },
    '/api/model-recommendation': {
      hardware: { totalMemoryGB: 32 },
      corpus: { documents: 4, totalDocumentChars: 182400, memories: 8 },
      modelFit: { applies: true, totalMemoryGB: 32, budgetGB: 19.2, quant: 'Q4_K_M', approxParamsB: 32, label: '~32B at Q4_K_M', reasoning: 'This device reports 32 GB of memory. Reserving headroom for the OS, this app, and the context window, roughly 19.2 GB is usable for model weights — comfortable for a ~32B model at Q4_K_M. Larger context windows or running other memory-heavy apps at the same time will eat into this.' },
      fineTuning: { suggested: false, exampleCount: 0, reasoning: 'No approved training dataset yet. Retrieval (knowledge base + memory) already covers most personalization — Fine-Tuning Studio is worth it once you have a reviewed, locked set of examples that show the model *how* to respond, not just facts for it to draw on.' },
      gpu: { vramGB: 8, name: 'NVIDIA GeForce RTX 4060', unifiedMemory: false, source: 'nvidia-smi' },
      sparseFit: { applies: true, largest: { base: 'google/gemma-4-26B-A4B-it', paramsB: 25.2, activeParamsB: 3.8 }, reasoning: 'Sparse (MoE) models change the ceiling: with FreeToken, this machine’s 32 GB of RAM can hold the experts of google/gemma-4-26B-A4B-it (25.2B total) while the 8 GB GPU runs the ~3.8B active set. See the frontier tier on the starter shelf.' },
    },
  });

  /* ---------------- scripted answers ---------------- */
  const ANSWERS = [
    {
      match: /lease|renew|notice|studio/i,
      sources: [{ documentId: 'd-1', name: 'studio-lease-2026.pdf', excerpt: 'clause 14 — renews annually each March, sixty (60) days written notice' }],
      memories: [{ id: 'm-4', content: 'The studio lease renews every March; the notice window is 60 days.' }],
      text: 'The studio lease renews each **March**, and the notice window is **60 days** — so the last useful date to give notice is the end of December.\n\nI am reading clause 14 of `studio-lease-2026.pdf`, which is indexed on this machine, and a memory you kept in July says the same thing. Both are cited beside this answer: the document I retrieved, and the memory I recalled.\n\nNothing here was inferred. If I had nothing to retrieve, I would say so instead of guessing.',
    },
    {
      match: /subscription|spend|money|renewal|gym|cost/i,
      sources: [],
      memories: [{ id: 'm-4', content: 'The studio lease renews every March; the notice window is 60 days.' }],
      text: 'Your recurring spend comes to about **$268 a month**, across five subscriptions I found in your own inbox export — no bank connection, no credentials, just the archive you already had a legal right to.\n\nThe one worth acting on: **IronWorks Gym** auto-renews in 29 days at $588, and the cancellation window closes tomorrow. That was mined from a booking confirmation, and the evidence excerpt is attached to the record.',
    },
    {
      match: /memory|remember|receipt|provenance|know about me/i,
      sources: [],
      memories: [
        { id: 'm-2', content: 'Ships on Windows 11, tests against WSL Ubuntu before every release.' },
        { id: 'm-7', content: 'Drinks too much espresso.' },
      ],
      text: 'I hold **8 durable memories** about you, and each one can answer *says who?*\n\nTwo examples, both cited beside this answer. One was extracted from a conversation and names the model that wrote it — `ollama/llama3.1`. The other predates provenance tracking entirely, so it honestly reads **origin unknown**; we refuse to backfill a plausible guess.\n\nOpen **Memory** in the sidebar to see all eight with their receipts, and strike any of them. Striking zeroes the bytes on disk — in a real install, not here.',
    },
    {
      match: /.*/,
      sources: [],
      memories: [],
      text: 'This is the **real command center** — the same `app.html` and `app.js` a running SovereignAI serves — but there is no server behind this page, so my voice is scripted and the workspace is invented.\n\nWhat is genuinely real is everything around this message: the navigation, the Mind view and its provenance counts, the memory ledger with its receipts, the knowledge atlas, the settings.\n\nTry asking about **the lease**, **subscriptions**, or **what you remember about me** — or run the real thing with one command and ask it anything at all.',
    },
  ];

  /* ---------------- the fetch stand-in ---------------- */
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });

  function sseStream(packets) {
    const encoder = new TextEncoder();
    return new ReadableStream({
      async start(controller) {
        for (const [event, data, delay] of packets) {
          await new Promise((r) => setTimeout(r, delay));
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        }
        controller.close();
      },
    });
  }

  function chatResponse(body) {
    const answer = ANSWERS.find((a) => a.match.test(body.message || '')) || ANSWERS[ANSWERS.length - 1];
    const persona = personas.find((p) => p.id === body.personaId) || personas[0];
    const words = answer.text.split(/(?<=\s)/);
    const packets = [['meta', {
      conversationId: body.conversationId || 'c-demo',
      conversationTitle: (body.message || 'New conversation').slice(0, 48),
      persona: persona.name,
      provider: 'ollama',
      model: 'llama3.1:latest',
      sources: answer.sources,
      memories: answer.memories,
      // Local provider: nothing left the machine, so there is no receipt.
      outgoing: null,
    }, 120]];
    for (const w of words) packets.push(['delta', { text: w }, 16]);
    packets.push(['done', {
      usage: { input_tokens: 1840 + words.length, output_tokens: words.length },
      modelDigest: 'sha256:46e0c10c039e',
      stopReason: 'end_turn',
    }, 60]);
    return new Response(sseStream(packets), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  /* The customs declaration, as the demo's local default provider sees it:
     Ollama on localhost, so nothing leaves and the app never has to open the
     dialog — but the manifest is here, shaped exactly like the server's. */
  function previewManifest(body) {
    const answer = ANSWERS.find((a) => a.match.test(body.message || '')) || ANSWERS[ANSWERS.length - 1];
    const persona = personas.find((p) => p.id === body.personaId) || personas[0];
    const message = body.message || '';
    const history = (messages[body.conversationId] || []).map((m) => ({ role: m.role, content: m.content }));
    const notes = answer.memories.length
      ? ['Relevant long-term notes the user asked you to remember:\n' + answer.memories.map((m) => `- ${m.content}`).join('\n')]
      : [];
    const system = [persona.system_prompt, ...notes].join('\n\n---\n\n');
    const context = [{ role: 'system', content: system }, ...history, { role: 'user', content: message }];
    const chars = context.reduce((sum, m) => sum + m.content.length, 0);
    return {
      provider: { id: 'ollama', label: 'Ollama', local: true, host: 'localhost:11434' },
      model: 'llama3.1:latest',
      parts: {
        system,
        memories: answer.memories,
        sources: answer.sources.map((s) => ({ documentId: s.documentId, title: s.name, excerpt: s.excerpt, score: 0.82, method: 'hybrid' })),
        history,
        message,
      },
      totals: { chars, bytes: new TextEncoder().encode(JSON.stringify(context)).length, approxTokens: Math.ceil(chars / 4), messages: context.length },
      extraction: { provider: 'ollama', model: 'llama3.1:latest', local: true },
    };
  }

  const REFUSED = 'Not in the demo — this page has no server behind it. Run the real thing and it works.';
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.startsWith('/api/')) return realFetch(input, init);

    const method = (init.method || 'GET').toUpperCase();
    const path = url.split('?')[0];
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { /* not JSON */ }

    if (path === '/api/chat' && method === 'POST') return chatResponse(body);
    if (path === '/api/chat/preview' && method === 'POST') return json(previewManifest(body));

    if (method === 'GET') {
      const table = FIXTURES();
      if (table[path]) return json(table[path]);
      const conversation = path.match(/^\/api\/conversations\/(.+)$/);
      if (conversation) {
        const found = conversations.find((c) => c.id === conversation[1]) || conversations[0];
        return json({ ...found, messages: messages[found.id] || [] });
      }
      return json({});
    }

    // Writes are simulated locally so the interface behaves honestly: a memory
    // you add appears, a memory you strike is gone. Nothing leaves the browser
    // and a reload restores the fixture.
    if (path === '/api/memories' && method === 'POST') {
      const created = { id: `m-${Date.now()}`, content: body.content || '', created_at: new Date().toISOString(), origin: 'manual', source_conversation_id: null, updated_at: null, author_provider: null, author_model: null };
      memories = [created, ...memories];
      return json(created);
    }
    const memoryId = path.match(/^\/api\/memories\/(.+)$/);
    if (memoryId) {
      if (method === 'DELETE') { memories = memories.filter((m) => m.id !== memoryId[1]); return json({ ok: true }); }
      if (method === 'PUT' || method === 'PATCH') {
        memories = memories.map((m) => (m.id === memoryId[1] ? { ...m, content: body.content ?? m.content, updated_at: new Date().toISOString() } : m));
        return json(memories.find((m) => m.id === memoryId[1]) || {});
      }
    }
    const documentId = path.match(/^\/api\/documents\/(.+)$/);
    if (documentId && method === 'DELETE') { documents = documents.filter((d) => d.id !== documentId[1]); return json({ ok: true }); }

    return json({ error: REFUSED }, 501);
  };

  /* ---------------- put the demo inside the website ----------------
     The app owns the whole viewport by design, which on the public host left
     a visitor with no way back out to the site. The same shared header every
     other page carries is injected above it — real links, not a back button —
     and the app is pushed down to make room. The shell's own stylesheet is
     used rather than a copy, so this frame can never drift from the others.
     shell.js is deliberately NOT loaded: it would stamp a data-theme onto a
     UI that has its own appearance. */
  const NAV = [
    ['/', 'Home'],
    ['/watch', 'Why'],
    ['/playground', 'What'],
    ['/command-center', 'How'],
    ['/sovereignty', 'Ledger'],
    ['/blog', 'Blog'],
  ];

  function siteHeader() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/shell.css';
    document.head.appendChild(link);

    const header = document.createElement('header');
    header.className = 'shell-bar';
    header.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9998';

    const inner = document.createElement('div');
    inner.className = 'shell-in';

    const brand = document.createElement('a');
    brand.className = 'shell-brand';
    brand.href = '/';
    brand.innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true"><path fill="#d97757" d="M50 4 90 27v46L50 96 10 73V27z"/><path fill="#1b1a18" d="M34 29h34v10H45v7h18v10H45v7h23v10H34z"/></svg> SovereignAI';

    const nav = document.createElement('nav');
    nav.className = 'shell-links';
    for (const [href, label] of NAV) {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = label;
      if (href === '/command-center') a.setAttribute('aria-current', 'page');
      nav.appendChild(a);
    }
    const cta = document.createElement('a');
    cta.className = 'shell-cta';
    cta.href = '/#install';
    cta.textContent = 'Run it';
    nav.appendChild(cta);

    inner.append(brand, nav);
    header.appendChild(inner);
    document.body.prepend(header);
  }

  /* ---------------- say what this is, unmissably ---------------- */
  function honestyBar() {
    const bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9998;display:flex;gap:14px;align-items:center;justify-content:center;flex-wrap:wrap;padding:9px 16px;background:var(--shell-mass);border-top:1px solid var(--shell-terra);color:var(--shell-ink);font:12.5px/1.5 ui-monospace,Consolas,monospace';
    const label = document.createElement('span');
    label.innerHTML = '<b style="color:var(--shell-terra)">how it works</b> — the real interface, an invented workspace. No server behind this page.';
    const back = document.createElement('a');
    back.href = '/playground';
    back.textContent = '⬡ more of the playground';
    back.style.cssText = 'color:var(--shell-dim);text-decoration:none';
    bar.append(label, back);
    document.body.appendChild(bar);
  }

  addEventListener('DOMContentLoaded', () => {
    siteHeader();
    honestyBar();
    // The app sizes itself to the viewport, so give the two bars their room
    // out of the body box rather than letting them cover the interface.
    document.body.style.boxSizing = 'border-box';
    document.body.style.paddingTop = '47px';
    document.body.style.paddingBottom = '40px';
  });
})();
