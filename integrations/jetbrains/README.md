# SovereignAI for JetBrains IDEs

Chat with your self-hosted sovereign AI inside IntelliJ IDEA, PyCharm, WebStorm, GoLand, and every other JetBrains IDE.

- **SovereignAI tool window** (right sidebar) — streaming chat with your own AI
- **Right-click → SovereignAI → Ask About Selection** — ask anything about the selected code
- **Right-click → SovereignAI → Save Selection to Knowledge** — index code into your AI's private knowledge base

Requires a running SovereignAI server: `sovereign start`. Server URL persists via IDE properties (default `http://127.0.0.1:4321`). No telemetry.

## Build

Requires JDK 17+ (no Gradle install needed if you use the wrapper task of any local Gradle 8.5+):

```bash
cd integrations/jetbrains
gradle buildPlugin        # → build/distributions/sovereignai-jetbrains-0.1.0.zip
```

The CI release workflow (`.github/workflows/release.yml`) builds this automatically and attaches the zip to each GitHub release.

## Install

**Settings → Plugins → ⚙ → Install Plugin from Disk…** → pick the zip.

## Run in a sandbox IDE (development)

```bash
gradle runIde
```
