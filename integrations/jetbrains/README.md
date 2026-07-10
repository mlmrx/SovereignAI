# SovereignAI for JetBrains IDEs

Chat with your self-hosted sovereign AI inside IntelliJ IDEA, PyCharm, WebStorm, GoLand, and every other JetBrains IDE.

- **SovereignAI tool window** (right sidebar) — streaming chat with your own AI
- **Right-click → SovereignAI → Ask About Selection** — ask anything about the selected code
- **Right-click → SovereignAI → Save Selection to Knowledge** — index code into your AI's private knowledge base

Requires a running SovereignAI server: `sovereign start`. The default is `http://127.0.0.1:4321`; set `SOVEREIGN_URL` in the IDE process environment for another server. For a token-protected or LAN/tailnet instance, also set `SOVEREIGN_TOKEN` to the token printed by SovereignAI. The token is sent only when the active server exactly matches that `SOVEREIGN_URL` (or the default localhost URL when it is unset). No telemetry.

Use plain HTTP only on localhost, a trusted LAN, or an encrypted tailnet. For other networks, use HTTPS so bearer tokens, prompts, and selected context are not exposed in transit.

## Build

Requires JDK 17+ and a local Gradle 8.5+ installation. This repository does not currently include a Gradle wrapper; CI pins Gradle 8.10 for release builds.

```bash
cd integrations/jetbrains
gradle buildPlugin        # produces build/distributions/sovereignai-jetbrains-0.3.0.zip
```

The CI release workflow (`.github/workflows/release.yml`) builds this automatically and attaches the zip to each GitHub release.

## Install

**Settings → Plugins → ⚙ → Install Plugin from Disk…** → pick the zip.

## Run in a sandbox IDE (development)

```bash
gradle runIde
```
