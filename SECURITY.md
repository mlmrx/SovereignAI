# Security

SovereignAI's whole claim is that your data stays on hardware you control.
A vulnerability that breaks that claim matters more here than in most
software, so reports are read first and answered fast.

## Reporting a vulnerability

**Email `security@mysovereign.ai`.** Do not open a public issue for anything
that could expose a user's data, bypass authentication, or reach the host.

Include what you can: the version (`sovereign --version` or the image tag),
the steps to reproduce, and what an attacker gains. A proof of concept is
welcome; exploitation of anyone else's instance is not.

What you can expect from us:

- **Acknowledgement within 72 hours.**
- **A fix or a mitigation within 14 days** for anything that exposes data or
  the host; longer, with a stated reason, for lower-severity findings.
- **Credit in the release notes** if you want it, and a heads-up before the
  advisory goes out.
- No legal action against good-faith research that stays within your own
  instances and data.

## Scope

In scope: the `sovereign` server and CLI, the providers and connectors it
ships, the export/import format, the MCP server, the editor and browser
integrations, the single-binary and container builds, and the public website
at mysovereign.ai.

Out of scope: the models themselves and the engines that run them (Ollama,
FreeToken, vLLM — report to them), rented-GPU providers, and anything that
requires an attacker to already be root on the user's machine.

## What is already on the record

- The August 2026 audit and every fix it produced:
  [`docs/SECURITY_AUDIT_2026-08.md`](docs/SECURITY_AUDIT_2026-08.md).
- The limits we state rather than hide (the database is not encrypted at
  rest; plain HTTP does not encrypt tokens or prompts; a LAN endpoint is not
  "local"): [`docs/SOVEREIGNTY.md`](docs/SOVEREIGNTY.md).
- Verifying release downloads: [`docs/OPERATIONS.md`](docs/OPERATIONS.md#verifying-release-downloads).

## Supported versions

The latest release and `main`. Older releases receive fixes only when the
fix is trivial to backport.
