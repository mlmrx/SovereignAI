# Licensing: the covenant and the commercial path

SovereignAI's brand is trust, so its licensing strategy is written down in
plain language, in public, before there is any revenue to defend. This page
is the policy; [`LICENSE`](../LICENSE) is the law (MIT).

## The covenant: the core is MIT, permanently

Everything an individual needs to own all twelve layers — the server, the
web UI, the CLI, memory with provenance, knowledge, chat and life import,
distillation, Model Studio, Fine-Tuning Studio's control plane, the BYOC
rails, export/verify/portfolio, the MCP server, and the editor/browser
integrations in this repository — **is MIT-licensed and will remain
MIT-licensed.** Not "open source for now." Not "until the license change."
The self-hosted product you can download today will never be relicensed,
rate-limited, feature-stripped, or moved behind a paywall.

This is partly principle and partly physics: MIT grants are irrevocable, so
every shipped release is already free forever regardless of what anyone
decides later. We convert that constraint into a promise and put our name
on it.

## The commercial path: by addition, never subtraction

The company makes money by **building things that are not the twelve
layers**, and never by clawing back what is:

1. **The managed edition** — we operate a SovereignAI instance for people
   and teams who want the sovereignty without the ops. The instance they
   get runs this same MIT code; the orchestration, billing, and fleet
   tooling that runs *our side* of that service is proprietary. You keep
   the boundary, the export, and the exit — leaving the managed edition is
   the same `sovereign export` as leaving anything else.
2. **Organization features** — multi-seat access, SSO, team audit views,
   fleet management for many BYOC instances, data-residency contracts.
   These serve organizations, not individuals, and may ship under a
   commercial license in a separate repository (`/ee` never lands here).
3. **Support, deployment, and training** for teams running it themselves.

The test for which side of the line a feature falls on: *does an individual
need it to own their own AI?* If yes, it's MIT, here, free. If it only
matters when someone else runs it for you or when an organization manages
many people, it may be commercial.

## What we deliberately did not choose

- **AGPL / dual licensing** — genuinely open source, but it would break the
  "MIT forever" already printed on our landing page, require a CLA that
  taxes every contributor, and not actually stop a determined host (every
  shipped MIT release remains forkable anyway). Breaking a published
  promise to gain a defense that doesn't defend is a bad trade.
- **BUSL / SSPL / source-available** — not open source, whatever the
  marketing says. A product whose sovereignty ledger tells users to demand
  auditable claims cannot ship a license that fails the definition it
  markets under.
- **The protection we chose instead is the trademark** (see
  [`TRADEMARKS.md`](../TRADEMARKS.md)): the code is anyone's, the *name*
  is not. A hosted fork must call itself something else and earn its own
  trust — and trust is this category's scarcest input.

## Contributions

Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/)
(`Signed-off-by`, see [`CONTRIBUTING.md`](../CONTRIBUTING.md)) and are
licensed MIT like the rest of the core. We deliberately use the DCO rather
than a CLA: a CLA exists to let a company relicense your work later, and we
have promised not to. The inability to relicense contributor code is not a
risk we accepted — it is the mechanism that makes the covenant real.

## Third-party layers

The MIT license covers this codebase, not the layers it touches: base
model weights carry their own licenses (surfaced in Model Studio's
`license` field), and imported data remains governed by wherever it came
from. The [sovereignty ledger](SOVEREIGNTY.md) tracks those boundaries.
