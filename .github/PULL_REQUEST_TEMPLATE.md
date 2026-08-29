<!-- Thanks. Four checks, in the order reviewers look at them. -->

## What this changes, and why

<!-- One paragraph. If it closes an issue: "Closes #123". Features need an issue first (see CONTRIBUTING.md). -->

## Checks

- [ ] **Signed off.** Every commit carries `Signed-off-by:` (`git commit -s`). That is the DCO — no CLA.
- [ ] **No runtime dependency added.** `package.json` still has none; `node:*` built-ins only (ADR-1).
- [ ] **`npm test` is green** locally, and new surfaces have tests (UI pages are verified against the served page, CSP enforced).
- [ ] **The honesty rule holds.** Nothing new claims a guarantee the code does not enforce; unknowns say unknown; if this touches `docs/SOVEREIGNTY.md`, the public ledger page mirrors it.

## Anything the reviewer should know

<!-- Trade-offs, what you tried first, what you deliberately left out. -->
