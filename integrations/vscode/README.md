# SovereignAI for VS Code

Chat with **your own sovereign AI** — local models, private memory, private knowledge — without leaving your editor. Also works in Cursor, Windsurf, and VSCodium.

## Requirements

A running SovereignAI server on your machine (or network):

```bash
node bin/sovereign.js start   # from the SovereignAI repo
```

## Features

- **SovereignAI: Open Chat** — streaming chat panel beside your code
- **SovereignAI: Ask About Selection** — right-click selected code, ask anything about it
- **SovereignAI: Save Selection to Knowledge** — index code/text into your AI's private knowledge base
- **SovereignAI: Remember This** — add a long-term memory note

## Settings

| Setting | Default | Description |
|---|---|---|
| `sovereignai.serverUrl` | `http://127.0.0.1:4321` | Your SovereignAI server |
| `sovereignai.persona` | `Engineer` | Persona to chat with |
| `sovereignai.authToken` | — | Bearer token for remote servers |

## Privacy

This extension talks only to the server URL you configure — by default, your own machine. No telemetry, no third-party calls.
