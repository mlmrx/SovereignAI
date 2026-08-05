# Licensing: the covenant and the commercial path

SovereignAI's brand is trust, so its licensing strategy is written down in
plain language, in public, before there is any revenue to defend. This page
is the policy; [`LICENSE`](../LICENSE) is the law — the **Functional Source
License, FSL-1.1-MIT** (fair source).

## The license in one paragraph

You may use, read, modify, fork, redistribute, and self-host everything in
this repository, free, for any purpose **except one**: offering a competing
commercial SovereignAI product or service on a release younger than two
years. On the second anniversary of each release, that release automatically
becomes plain **MIT** — the future grant is irrevocable and part of the
license text itself, not a promise anyone could later withdraw.

## The covenant: your exit is licensed, not promised

What an individual gets did not change when the license did:

- **Self-hosting is unrestricted.** Run it on your laptop, homelab, VPS, or
  rented GPU, for yourself, your family, or inside your company. "Internal
  use and access" is an explicitly Permitted Purpose.
- **Forking and modifying are unrestricted.** Read every line, patch it,
  maintain your own fork. The zero-dependency audit story is unchanged.
- **Lock-in is impossible by construction.** If Unify Dynamics disappears,
  raises prices, or loses your trust, every release you have is already
  carrying its own MIT conversion date. The worst case is not "trapped";
  it is "wait until the release you run turns two."
- **Nothing an individual needs to own all twelve layers will be paywalled,
  rate-limited, or feature-stripped.** The commercial path is by addition,
  never subtraction.

## What the license forbids, and why

Exactly one actor is restricted: a company selling SovereignAI itself —
hosted or repackaged — in competition with us, on releases newer than two
years. That restriction is what funds the development of everything above
it. A sovereignty product that cannot pay its maintainers ends the same way
every abandoned privacy project ends: unmaintained, then unsafe, then gone.
The license trades a freedom almost none of our users ever needed (reselling
our current code as a service) for the revenue that keeps the freedoms they
do need maintained.

## The commercial path: by addition, never subtraction

The company makes money by **building things that are not the twelve
layers**, and never by clawing back what is:

1. **The managed edition** — we operate a SovereignAI instance for people
   and teams who want the sovereignty without the ops. The instance they
   get runs this same public code; the orchestration, billing, and fleet
   tooling that runs *our side* of that service is proprietary. You keep
   the boundary, the export, and the exit — leaving the managed edition is
   the same `sovereign export` as leaving anything else.
2. **Organization features** — multi-seat access, SSO, team audit views,
   fleet management for many BYOC instances, data-residency contracts.
   These serve organizations, not individuals, and may ship under a
   commercial license in a separate repository (`/ee` never lands here).
3. **Commercial license grants** — an organization whose use would
   otherwise be a Competing Use (for example, bundling SovereignAI into a
   hosted offering) can license that right from us directly.
4. **Support, deployment, and training** for teams running it themselves.

The test for which side of the line a feature falls on is unchanged: *does
an individual need it to own their own AI?* If yes, it's here, free, under
the FSL. If it only matters when someone else runs it for you or when an
organization manages many people, it may be commercial.

## Why not the others

- **AGPL / dual licensing** — genuinely open source, and we respect teams
  that choose it, but it does not actually defend the revenue: AGPL obliges
  a hosted competitor to publish *their modifications*, not to stop selling
  a service on our unmodified code. It also carries an enterprise-adoption
  tax we would pay while gaining little.
- **BUSL** — the same shape as the FSL with more parameters, a slower
  (up-to-four-year) conversion, and heavier text. The FSL is the same idea
  with the honesty dialed up and the wait dialed down.
- **SSPL / Elastic License** — never convert to open source. A product
  whose sovereignty ledger tells users to demand auditable exits should not
  ship a license whose own exit clause is "trust us."
- **Plain MIT / permissive** — hands a hyperscaler the right to sell the
  finished product as a hosted service without funding a line of its
  development. A trademark forces such a fork to rename itself, but a
  renamed clone with a marketing budget is still a clone. The FSL closes
  that gap for the two years each release is commercially alive — and then
  hands the code to the commons anyway.

## Contributions

Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/)
(`Signed-off-by`, see [`CONTRIBUTING.md`](../CONTRIBUTING.md)). Inbound
contributions are licensed to the project under the **MIT license**; the
combined work is distributed under the FSL. There is no CLA to sign and you
keep your copyright. The trade is symmetrical and dated: your contribution
spends at most two years inside the fair-source window, then ships to
everyone — including you — as MIT, via the license's own future grant.

## The integrations stay MIT

The editor and browser integrations (`integrations/vscode`,
`integrations/jetbrains`, `integrations/browser`, the trainer sidecar
docs) are thin clients that talk to *your* server. They remain plain MIT:
maximum distribution, no commercial surface, and store review processes
prefer it.

## Third-party layers

The FSL covers this codebase, not the layers it touches: base model
weights carry their own licenses (surfaced in Model Studio's `license`
field and the starter shelf), and imported data remains governed by
wherever it came from. The [sovereignty ledger](SOVEREIGNTY.md) tracks
those boundaries.
