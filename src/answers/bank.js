/**
 * The answer bank: real questions people ask AI assistants about private,
 * local, and sovereign AI — each with a factual, sourced answer we are willing
 * to stand behind.
 *
 * This is the honest engine for "be found by LLMs". Answer engines (Perplexity,
 * ChatGPT search, Google's AI overviews, Claude with search) cite pages that
 * answer a question directly, cleanly, and verifiably. You earn those citations
 * by BEING the best answer on your own site — not by querying those platforms,
 * which changes nothing about what they tell the next person and would be
 * dishonest besides. So the questions become pages here, where they get
 * crawled.
 *
 * Two rules, and they are the whole reason this can be automated safely:
 *
 *   1. Every answer is WRITTEN and REVIEWED by a person before it can publish.
 *      Nothing here is machine-generated prose. The automation schedules and
 *      wires reviewed answers; it never authors them. A site whose entire brand
 *      is accuracy cannot let a model hallucinate a claim onto it unread.
 *   2. Every factual claim is either checkable on our own pages (linked) or
 *      carries a primary source. Where the honest answer is unflattering — a
 *      limit, a "not yet", a competitor that does something well — it says so.
 *      That is what makes the answer worth citing instead of the marketing.
 *
 * `reviewed: true` is the gate. The publish script only ever ships reviewed
 * answers, in list order (first = highest priority). When it runs out, it
 * stops and asks for more rather than padding a schedule.
 */

export const BANK_CURATED_AT = '2026-09';

export const ANSWERS = [
  {
    slug: 'is-running-ai-locally-actually-private',
    question: 'Is running AI locally actually private?',
    written: '2026-09-01',
    reviewed: true,
    summary:
      'Running a model locally keeps inference off someone else’s servers, but "local" and "private" are not the same claim — the app around the model decides whether anything leaves. Here is how to tell the difference.',
    lead: 'Local inference is necessary for privacy but not sufficient: the model runs on your machine, but the application around it decides whether your prompts, memory, or documents ever leave — so "runs locally" and "is private" are two separate claims you have to check separately.',
    body: [
      'A local model means the tokens are generated on your hardware. That rules out the biggest leak, but it says nothing about the rest of the app: telemetry, update checks, cloud "sync", crash reporters, or a settings screen that quietly falls back to a hosted model. A product can run a model locally and still phone home constantly.',
      'The test that actually separates the two is disclosure **at the moment it happens**. Ask: when this app sends something off my machine, does it tell me then — on screen, at the point of use — or only in a policy PDF? A product that shows you the exact bytes before a remote call is proving the claim; one that asks you to trust a toggle labelled "improve the product" is not. This is the third of the [three questions](/three-questions) worth asking any private-AI product.',
      'It is also why **local is not the finish line**. The honest version of the claim is: local by default, remote only when you choose, and shown to you the instant anything crosses your boundary. SovereignAI does this with a [customs declaration](/blog/the-customs-declaration) — before any message goes to a remote provider, the precise outgoing context is shown for approval, and every remote answer carries a receipt of what left. Local endpoints never ask, because nothing leaves.',
      'The parts that are **not** private, we name in the [Sovereignty Ledger](/sovereignty): the database is not encrypted at rest today (the honest mitigation is full-disk encryption), and even open-weight models are a third party’s artifact. "Private" here means custody and disclosure, not a magic word.',
    ],
    related: [
      ['/three-questions', 'The three-question test for private AI'],
      ['/blog/the-customs-declaration', 'The customs declaration, in depth'],
      ['/sovereignty', 'The Sovereignty Ledger'],
    ],
    keywords: 'is local AI private, local vs private AI, does local AI send data, private AI, on-device AI privacy',
  },
  {
    slug: 'give-a-local-llm-long-term-memory',
    question: 'How do I give a local LLM long-term memory?',
    written: '2026-09-01',
    reviewed: true,
    summary:
      'Local model runners like Ollama only serve models; they keep no durable memory. Giving a local LLM memory means adding a layer that stores facts, retrieves them, and — if you want to trust it — records where each fact came from.',
    lead: 'A local model runner serves tokens and forgets everything between sessions, so long-term memory has to come from a layer around it: something that stores durable facts, retrieves the relevant ones into each prompt, and — if the memory is going to be trusted — records how each fact was learned.',
    body: [
      'Most "memory" tutorials tell you to paste facts into a `MEMORY.md` file and prepend it to every prompt. That works until the file is large, contradictory, or you want to know why the model believes something. Real memory needs three things a text file does not have: **extraction** (turning conversations into durable facts), **retrieval** (pulling only the relevant facts into context, so you are not paying for the whole file every turn), and **provenance** (which conversation a fact came from, and which model wrote it).',
      'Provenance is the part almost nothing does, and it is the part that makes memory safe to rely on. If your assistant "remembers" that you are allergic to a medication, you want to know whether that came from a document you imported or a model’s guess — and to strike it, permanently, if it is wrong.',
      'SovereignAI is built as exactly this layer: durable memory where every fact records its origin (typed, extracted, or distilled), the source conversation, and the authoring model; retrieval that puts the best passage first; and deletion that zeroes the bytes on disk rather than hiding a row. It sits in front of whatever generates the tokens — [Ollama](/blog/freetoken-in-sovereignai), a frontier API, or a local sparse model — so the memory is yours even when the brain is rented. One honest caveat: extraction quality still depends on the model doing the extracting; a small local model writes rougher memory than a large one.',
    ],
    related: [
      ['/what-is-sovereign-ai', 'What is sovereign AI?'],
      ['/command-center', 'The command center'],
      ['/blog/introducing-sovereignai', 'Introducing SovereignAI'],
    ],
    keywords: 'local LLM memory, give AI long term memory, Ollama memory, persistent memory local AI, AI memory provenance',
  },
  {
    slug: 'move-chatgpt-history-to-a-local-ai',
    question: 'How do I move my ChatGPT or Claude history to a local AI?',
    written: '2026-09-01',
    reviewed: true,
    summary:
      'Both ChatGPT and Claude let you export your full history as a file. A local AI that accepts those exports can parse them on your machine and distil them into memory — no account connection, no credentials, nothing leaving your computer.',
    lead: 'Export your history from ChatGPT or Claude as the official archive they both provide, then import that file into a local AI that parses it on your machine — the good ones never ask for your account login, because a downloaded export needs no connection to read.',
    body: [
      'The safe pattern has a hard rule: **no credential custody**. You should never hand a "connect your ChatGPT account" button your login — that is a standing key to your whole history in someone else’s hands. Instead you request the export yourself (ChatGPT: Settings → Data controls → Export; Claude: Settings → Export data), download the file, and hand the file to the local tool. The tool reads it offline.',
      'SovereignAI imports ChatGPT and Claude official exports directly, with a documented generic JSON format for any other assistant and Gemini Takeout supported experimentally. The archive is parsed locally, and an optional distillation pass turns those old conversations into durable memory — each fact tagged with the conversation it came from. So your new local assistant starts already knowing what the old one knew, without you re-typing anything and without a connector holding your keys.',
      'Do the reverse on day one too: take an export **out** of the local tool before you have put anything important in, so you know the exit works before you depend on it. A tool that makes it easy to leave is telling you something about how it plans to treat you if you stay.',
    ],
    related: [
      ['/command-center', 'Try the command center'],
      ['/blog/introducing-sovereignai', 'Introducing SovereignAI'],
      ['/three-questions', 'The three-question test'],
    ],
    keywords: 'move ChatGPT history to local AI, import ChatGPT export, Claude export to local, migrate AI history, ChatGPT export local model',
  },
  {
    slug: 'run-a-120b-model-on-a-gaming-gpu',
    question: 'Can I run a 120B model on a gaming GPU?',
    written: '2026-09-01',
    reviewed: true,
    summary:
      'Yes, for sparse mixture-of-experts models — engines like FreeToken keep the experts in system RAM and stream only the few active per token to the GPU, so a consumer NVIDIA card plus enough RAM runs 20B–120B-total models. The catch: it is NVIDIA and Linux only today.',
    lead: 'Yes — if the model is a sparse mixture-of-experts (MoE) model, an engine like FreeToken keeps all the expert weights in system RAM and streams only the three-to-five billion parameters active per token to the GPU, so a single gaming NVIDIA card plus enough host RAM can run a 120B-total model. The real limit is not the GPU; it is that you need the RAM for the full weight set and, today, Linux with an NVIDIA card.',
    body: [
      'A dense model wants all its weights in GPU memory, which is why a 120B dense model needs a datacentre card. A sparse MoE model is different: it has 120B parameters total but only activates a small subset per token. [FreeToken](/blog/freetoken-in-sovereignai) exploits that — the experts live in system RAM, the hot ones are cached on the GPU, and the rest stream over PCIe as tokens generate. The GPU only ever holds the active set, which is a few gigabytes.',
      'So the sizing flips. **Host RAM** has to hold the total weights: roughly 0.6 GB per billion parameters at 4-bit, so about 70 GB for gpt-oss-120b, meaning 128 GB of RAM. **GPU memory** only has to hold the active set — a 4 GB card is enough for many of these. On the starter shelf, gpt-oss-20b and 120b, Qwen3.6-35B-A3B and Gemma 4 26B-A4B all run this way.',
      'The honest limits: FreeToken is **Linux x86_64 with an NVIDIA driver only** today — not Apple Silicon, not the ARM-based DGX Spark, not AMD or Intel GPUs. On a MacBook you are on unified-memory dense models instead. And "runs" is not "runs fast": streaming experts over PCIe is slower than everything resident on the GPU. It is the difference between a class of model being impossible on your hardware and being usable on it.',
    ],
    related: [
      ['/blog/freetoken-in-sovereignai', 'FreeToken in SovereignAI'],
      ['/blog/sovereignai-on-nvidia-dgx-spark-rtx-workstation', 'SovereignAI on NVIDIA hardware'],
    ],
    sources: [['https://github.com/FlashML-org/FreeToken', 'FreeToken (the engine)']],
    keywords: 'run 120B model gaming GPU, sparse MoE local, gpt-oss-120b consumer GPU, FreeToken, large model small GPU RAM',
  },
  {
    slug: 'how-much-ram-to-run-a-local-llm',
    question: 'How much RAM do I need to run a local LLM?',
    written: '2026-09-01',
    reviewed: true,
    summary:
      'A useful rule of thumb: at 4-bit quantisation a model needs about 0.6 GB per billion parameters, against roughly 60% of your RAM as usable — so a model fits comfortably when its parameter count in billions is under your RAM in gigabytes.',
    lead: 'A dependable rule of thumb: at 4-bit quantisation a model needs roughly 0.6 GB of memory per billion parameters, and you can count on about 60% of your system RAM being usable for it — which nets out to a simple test, a model fits comfortably when its size in billions of parameters is below your RAM in gigabytes.',
    body: [
      'Worked examples at 4-bit (Q4): an 8B model needs about 5 GB and is comfortable on 16 GB; a 27B model needs about 16 GB and is tight on 32 GB but comfortable from 48; a 70B-total model needs about 42 GB and wants 96–128 GB. Add headroom for the context window — a long context can cost several more gigabytes.',
      'Two refinements. First, **quantisation is the dial**: the same model at 8-bit needs roughly double, at 2-bit roughly half (with more quality loss). Q4 is the usual sweet spot. Second, **sparse MoE models are sized on total parameters for RAM** even though only a fraction is active per token, because the whole weight set still has to live in memory — see [running a 120B model on a gaming GPU](/answers/run-a-120b-model-on-a-gaming-gpu).',
      'You do not have to do this arithmetic by hand. SovereignAI’s starter shelf sizes every model against the machine it is running on before anything downloads, and `sovereign doctor` will tell you whether your configured default model actually fits — "~16 GB at Q4 against ~19 GB of usable RAM: tight; comfortable from 48 GB" — so you find out before the download, not after.',
    ],
    related: [
      ['/command-center', 'The starter shelf, sized to your machine'],
      ['/answers/run-a-120b-model-on-a-gaming-gpu', 'Can I run a 120B model on a gaming GPU?'],
    ],
    keywords: 'how much RAM local LLM, RAM for running LLM, model size RAM calculator, quantization RAM, local model memory requirements',
  },
  {
    slug: 'local-vs-private-vs-sovereign-ai',
    question: 'What is the difference between local, private, and sovereign AI?',
    written: '2026-09-01',
    reviewed: true,
    summary:
      'Local means the computation runs on your hardware. Private means your data is not exposed to others. Sovereign means you own and can exit the whole stack. They are often conflated, but a product can be any one without the others.',
    lead: 'Local is about where the computation runs, private is about who can see your data, and sovereign is about who owns and controls the whole stack — three different claims that get sold as one, when in fact a product can be local without being private, private without being sovereign, and sovereign while still honestly admitting parts it does not own.',
    body: [
      '**Local** means inference happens on hardware you control. It is a location claim. It rules out the model reading your data on someone else’s servers, but a local app can still leak through telemetry or a cloud fallback — see [is running AI locally actually private](/answers/is-running-ai-locally-actually-private).',
      '**Private** means your data is not exposed to parties you did not choose. A product can be private without being local (a well-run hosted service with a real policy) — but then privacy rests on a promise about a system you cannot inspect or leave. Private on a black box is a weaker thing than it sounds.',
      '**Sovereign** is the strongest and the one most abused. It means you own the layers you can and can exit with everything — the machine, the models, the memory, the data, and a verified way out — with every borrowed layer disclosed. Full sovereignty does not exist for anyone in 2026 (even open weights are someone else’s artifact trained on a corpus nobody outside can audit), so the honest version is maximum control at every layer with the compromises named. That is why SovereignAI publishes a [layer-by-layer ledger](/sovereignty) instead of a checkmark, and defines both the national and personal meanings of the term on [what is sovereign AI](/what-is-sovereign-ai).',
    ],
    related: [
      ['/what-is-sovereign-ai', 'What is sovereign AI?'],
      ['/sovereignty', 'The Sovereignty Ledger'],
      ['/answers/is-running-ai-locally-actually-private', 'Is running AI locally actually private?'],
    ],
    keywords: 'local vs private vs sovereign AI, difference local private AI, what is sovereign AI, private AI meaning, AI data sovereignty',
  },
  {
    slug: 'does-ollama-store-my-conversations',
    question: 'Does Ollama store my conversations and memory?',
    written: '2026-09-01',
    reviewed: true,
    summary:
      'Ollama serves models; it does not keep durable conversation history or memory of its own. Whatever remembers your conversations is the application in front of Ollama — so where that data lives, and whether it leaves, is that app’s question, not Ollama’s.',
    lead: 'No — Ollama is a model server, not a memory system: it runs the model and returns tokens, and any lasting record of your conversations or facts about you lives in whatever application is calling Ollama, so the question "is my history stored, and does it leave?" is really a question about that front-end, not about Ollama.',
    body: [
      'This trips people up because "I run Ollama locally" feels like a complete private-AI setup. It is only the engine. Ollama holds the model weights and a short working context for a running request; it does not maintain your chat history, extract durable memory, index your documents, or export anything. If your front-end keeps history, that front-end decides where it is stored and whether it syncs anywhere.',
      'So the privacy of an Ollama-based stack is the privacy of the layer on top. A browser extension talking to Ollama might still send your prompts through a cloud analytics service; a desktop app might store history in a cloud account. Ollama being local does not make them local.',
      'SovereignAI is designed to be that top layer done right: your conversations, memory, and documents live in a local SQLite database in a folder you can copy, deletion zeroes the bytes, nothing reports to a control plane, and the whole workspace exports to one checksummed file you can verify. It talks to Ollama (or a frontier API, disclosed when used) for the tokens, and owns everything Ollama deliberately does not.',
    ],
    related: [
      ['/answers/give-a-local-llm-long-term-memory', 'How do I give a local LLM long-term memory?'],
      ['/command-center', 'The command center'],
      ['/sovereignty', 'The Sovereignty Ledger'],
    ],
    keywords: 'does Ollama store conversations, Ollama memory, Ollama history privacy, Ollama save chats, is Ollama private',
  },
  {
    slug: 'know-what-data-an-ai-app-sends-to-the-cloud',
    question: 'How do I know what data an AI app sends to the cloud?',
    written: '2026-09-01',
    reviewed: true,
    summary:
      'Most apps only tell you in a policy. The stronger answer is a product that shows the exact outgoing payload at the moment of a remote call — and short of that, you can watch the traffic yourself. Here is how to check.',
    lead: 'The honest way to know is for the app to show you the exact outgoing payload at the moment it makes a remote call; short of that, you are left inferring from a privacy policy or capturing the network traffic yourself — and which of those a product offers tells you most of what you need to know about it.',
    body: [
      'A privacy policy describes intent, not the bytes. To see the bytes without the product’s help, you can point it at a proxy (mitmproxy, or your browser’s network tab for a web app) and read what actually leaves — tedious, but definitive. If an app resists inspection or pins its certificates so you cannot see, treat that as an answer.',
      'The better design puts the disclosure in the product. SovereignAI shows a [customs declaration](/blog/the-customs-declaration) before any message goes to a remote provider: the exact system prompt, the memories and document excerpts it pulled, the prior messages, the new message, the byte and token counts, and the destination host — assembled by the same code that builds the real request, so the preview cannot lie. You approve it, or you do not, and every remote answer carries a receipt of how much left. Local endpoints never ask, because nothing leaves; no classifier decides what counts as sensitive, because that is your call, so you see everything.',
      'This is the third of the [three questions](/three-questions) — does the product tell you at the moment, not in a document — and it is the one to ask first, because a product willing to show you an uncomfortable truth exactly when it is relevant tends to be straight with you everywhere else.',
    ],
    related: [
      ['/blog/the-customs-declaration', 'The customs declaration, in depth'],
      ['/three-questions', 'The three-question test'],
      ['/answers/is-running-ai-locally-actually-private', 'Is running AI locally actually private?'],
    ],
    keywords: 'what data does AI app send, see AI app network traffic, does AI app phone home, AI data disclosure, monitor AI app cloud',
  },
  {
    slug: 'best-small-local-model-for-your-machine',
    question: 'What is the best small local model to run on my own machine?',
    written: '2026-09-01',
    reviewed: true,
    summary:
      'There is no single best — it depends on your RAM and the job (chat, reasoning, coding, embeddings). A dated, honest shortlist beats a leaderboard, because this landscape changes monthly and the right pick is the one that fits your hardware.',
    lead: 'There is no single best small local model — the right one depends on how much RAM you have and what you are doing (general chat, reasoning, coding, or embeddings) — so the useful answer is a dated, opinionated shortlist by job, checked against your machine, rather than a leaderboard that is stale the week you read it.',
    body: [
      'As a starting point in late 2026, by job: for **everyday chat**, Gemma 3 4B or Qwen3 8B if you have the RAM; for **reasoning**, Qwen3.8-27B is the strongest open dense model a 32 GB machine can run (tight there, comfortable from 48); for **coding**, Qwen2.5-Coder 7B; for **embeddings** (semantic search over your documents), nomic-embed-text. All run under Ollama on modest hardware. Treat any such list as a snapshot — verify the current version and its licence on Hugging Face before relying on it.',
      'The pick that matters most is the one that **fits**: a model that needs more RAM than you have will swap to disk and crawl, or fail to load. Match the model to your memory first (see [how much RAM do I need](/answers/how-much-ram-to-run-a-local-llm)), then choose within what fits. A model that fits and is a little weaker beats a stronger one that thrashes.',
      'SovereignAI keeps a curated starter shelf organised by job, each entry dated and carrying its licence, and sizes every one against the machine it is running on before you download anything — so "best" becomes "best that actually runs here", which is the only version of the question worth answering.',
    ],
    related: [
      ['/command-center', 'The starter shelf'],
      ['/answers/how-much-ram-to-run-a-local-llm', 'How much RAM do I need to run a local LLM?'],
    ],
    keywords: 'best small local model, best local LLM for my machine, small model Ollama, local model by RAM, best model to run locally',
  },
];
