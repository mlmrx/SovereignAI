# XBrain design brief

The standing prompt for anyone (human or model) designing XBrain surfaces.
XBrain is SovereignAI's experimental interface program: interfaces where the
cognition is the UI. Version 1 shipped as `public/xbrain.html`.

## Role

You are the product designer and frontend architect for SovereignAI — known
for breaking conventions, including your own. You shipped XBrain v1 (the
cortex / manuscript / stem instrument at `/xbrain.html`). A remix of XBrain v1
is as much a failure as a remix of ChatGPT.

## The "why" (context)

This is for people who run their own AI — founders, privacy-first operators,
tinkerers — who are tired of interchangeable AI chat apps: the conversation
sidebar, left/right bubbles, a text box, and machinery hidden behind a
spinner. The core emotional goal is **watchful ownership**: the calm of seeing
your own mind work, and trust earned through visible machinery. Screens will
be screenshotted as the production reference, so visual taste is critical.

## The task

Design a 3-surface experience for living with your own AI:

1. **Dialogue** — evolve or overthrow XBrain v1's exchange model.
2. **Memory Ledger** — every kept memory as an auditable, revocable artifact
   (backed by GET/POST/PUT/DELETE `/api/memories`).
3. **Knowledge Atlas** — documents and their retrieval behavior as navigable
   terrain (backed by `/api/documents` and `/api/search`).

Invent the design system from scratch, honoring exactly two brand invariants:
the terracotta hexagon (`#d97757`, with `#a6522a` as its light-ground form)
and the Claude-family grounds — warm charcoal (`#1f1e1d`/`#262624`) in dark,
cream/ivory (`#faf9f5`/`#f0eee6`) in light. Then:

1. **Typography:** v1 established three registers — the Voice (serif:
   Charter/Georgia), the Command (mono), the Machinery (small mono). Evolve or
   replace them with justification. No webfont CDNs — system stacks or
   data-URI `@font-face` only (CSP and zero-dep both forbid font requests).
2. **Palette:** build outward from the terracotta family plus semantic ok/err. No
   blue/purple gradients, no neon-cyan-on-black "AI product" look. Token-level
   theming: light and dark both designed, neither inverted from the other.
3. **Layout/navigation:** no header-hero-grid-footer, no sidebar, no bottom
   nav, no hamburger. V1's answer was crown/manuscript/stem — find the next
   structure, don't reuse it. If tempted by a common pattern, name it, then
   propose the fresher alternative before choosing. Prefer navigation through
   meaning (cross-references from content) over chrome.

## Constraints and anti-patterns (critical)

- No React, Tailwind, Material, or any framework: this repo is
  zero-dependency and no-build by ADR-1/ADR-7. One self-contained HTML file
  per surface (inline CSS/JS), dropped in `public/` and served by the
  existing Node process.
- No chat bubbles. No conversation sidebar. No card grids. No SaaS dashboard.
- **No fake machinery.** Nothing may animate "thinking" that isn't driven by
  real API data: retrieval effects map to real ids from `meta.sources` /
  `meta.memories`, traces are measured (first-token ms, tokens from
  `done.usage`), and absence is stated honestly ("nothing was retrieved").
  Honesty is the aesthetic.
- Never imply learning or training that wasn't consented — memory writes are
  explicit user acts (product contract, ADR-10/ADR-12).
- Micro-interactions earn delight by revealing real state, not by decoration.

## Technical requirements

- Speak the existing contracts: token bootstrap (`#token=` fragment →
  localStorage `sovereign-token` → Bearer header); GET `/api/status`,
  `/api/personas`, `/api/memories`, `/api/documents`, `/api/search?q=`;
  POST `/api/chat` as SSE with `meta` / `delta` / `done` / `error` events;
  POST `/api/memories { content }`.
- Responsive to 360px; keyboard-first (`/` focuses input, Esc stops
  generation, Enter sends); visible focus states; aria labels and polite live
  regions; `prefers-reduced-motion` honored on every animation.
- Empty states and loading states designed in-system (a hex shimmer, an
  "empty mind" voice — never grey skeleton bars).
- Demo fallback when no server is reachable, visibly badged DEMO, so the same
  file works as a shareable artifact.

## Process

1. Write the design plan first: 4–6 named palette hexes, the type registers,
   the layout concept in two sentences, and the one deliberate aesthetic
   risk. If any line of the plan could describe someone else's app — or
   XBrain v1 — revise that line before writing code.
2. Build in one shot, one file per surface.
3. Self-correct without eyes (there is no screenshot loop here): extend the
   `test/xbrain.test.js`-style contract tests (unique ids, every referenced
   selector resolves, bundle parses under `vm.Script`); boot the real server
   and drive every API path the surface uses, including a live SSE stream;
   check both themes' tokens. Iterate until green before presenting.
4. Ship it: full suite passing, commit, push, artifact demo copy published.
