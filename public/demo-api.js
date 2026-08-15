'use strict';
/* The command centre, running in public on a workspace that does not exist.
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
        openai: { enabled: false, baseUrl: 'https://api.openai.com', apiKey: '' },
        anthropic: { enabled: true, baseUrl: 'https://api.anthropic.com', apiKey: '••••••••' },
      },
      defaults: { provider: 'ollama', model: 'llama3.1:latest' },
      embeddings: { provider: 'ollama', model: 'nomic-embed-text' },
      memory: { autoExtract: true, extractLocalOnly: true, extractionModel: 'llama3.1:latest' },
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
      { id: 'ollama', label: 'Ollama', enabled: true, configured: true, ok: true, detail: 'Ollama 0.6.6 · 3 models' },
      { id: 'openai', label: 'OpenAI-compatible', enabled: false, configured: false },
      { id: 'anthropic', label: 'Anthropic (Claude)', enabled: true, configured: true, ok: true, detail: 'key present' },
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
    '/api/search': { results: [
      { documentId: 'd-1', name: 'studio-lease-2026.pdf', score: 0.82, excerpt: '…clause 14: the agreement renews annually each March, with written notice required no later than sixty (60) days prior…' },
      { documentId: 'd-2', name: 'insurance-policy-shield.pdf', score: 0.44, excerpt: '…the policy term runs twelve months from the commencement date stated in the schedule…' },
    ] },
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
      text: 'This is the **real command centre** — the same `app.html` and `app.js` a running SovereignAI serves — but there is no server behind this page, so my voice is scripted and the workspace is invented.\n\nWhat is genuinely real is everything around this message: the navigation, the Mind view and its provenance counts, the memory ledger with its receipts, the knowledge atlas, the settings.\n\nTry asking about **the lease**, **subscriptions**, or **what you remember about me** — or run the real thing with one command and ask it anything at all.',
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
    }, 120]];
    for (const w of words) packets.push(['delta', { text: w }, 16]);
    packets.push(['done', {
      usage: { input_tokens: 1840 + words.length, output_tokens: words.length },
      modelDigest: 'sha256:46e0c10c039e',
      stopReason: 'end_turn',
    }, 60]);
    return new Response(sseStream(packets), { status: 200, headers: { 'content-type': 'text/event-stream' } });
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

  /* ---------------- say what this is, unmissably ---------------- */
  addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;display:flex;gap:14px;align-items:center;justify-content:center;flex-wrap:wrap;padding:9px 16px;background:#12110f;border-top:1px solid #d97757;color:#f0eee6;font:12.5px/1.5 ui-monospace,Consolas,monospace';
    const label = document.createElement('span');
    label.innerHTML = '<b style="color:#d97757">demo</b> — the real interface, an invented workspace. No server behind this page.';
    const run = document.createElement('a');
    run.href = '/#install';
    run.textContent = 'Run the real one →';
    run.style.cssText = 'color:#d97757;font-weight:700;text-decoration:none';
    const back = document.createElement('a');
    back.href = '/playground';
    back.textContent = '⬡ playground';
    back.style.cssText = 'color:#a49a90;text-decoration:none';
    bar.append(label, run, back);
    document.body.appendChild(bar);
    document.body.style.paddingBottom = '46px';
  });
})();
