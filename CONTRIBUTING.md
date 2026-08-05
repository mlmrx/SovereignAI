# Contributing

Thanks for wanting to make sovereign AI better. Ground rules, kept short:

## The one legal requirement: DCO sign-off

Every commit must be signed off
([Developer Certificate of Origin](https://developercertificate.org/)):

```bash
git commit -s -m "Your change"
```

The `Signed-off-by:` line certifies you have the right to contribute the
code and agree it ships under the project's MIT license. We use the DCO
instead of a CLA on purpose: a CLA would let us relicense your work later,
and [we have promised not to](docs/LICENSING.md). Your contribution stays
MIT because ours does.

## Ground rules that get PRs merged

- **Zero runtime dependencies is load-bearing** (ADR-1). A PR that adds a
  runtime npm dependency will be declined regardless of how good it is;
  hand-rolled-and-tested beats imported here.
- **Honesty over polish** (the theme of most ADRs): unknown provenance says
  unknown, failures fail loudly, and nothing claims a guarantee the code
  doesn't enforce. Copy and code are reviewed to the same standard.
- **Tests run with `npm test`** — `node:test`, nothing to install. New
  surfaces need tests; UI pages are verified against the served page (CSP
  enforced), not just parsed — see `docs/ARCHITECTURE.md` for the pattern.
- **Read the ADRs first** ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)) —
  most "why is it built this way" questions are answered there, and PRs
  that fight a recorded decision need to argue with the decision record,
  not just ship the alternative.

## Scope guidance

Bug fixes and honest-gap closures: just send them. New features: open an
issue first — the roadmap is deliberate, and the answer to "should this
exist" (see [docs/LICENSING.md](docs/LICENSING.md) for the individual/
organization boundary) is settled before code review, not during it.
