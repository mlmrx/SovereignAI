# SovereignAI for VS Code

Use your SovereignAI workspace without leaving the editor. The extension works in VS Code, Cursor, Windsurf, and VSCodium, and follows the provider, model, memory, and knowledge settings on your SovereignAI server.

## Requirements

Start SovereignAI on your machine or network:

```bash
sovereign start
```

Then run **SovereignAI: Test Connection** from the command palette.

## Features

- **Open Chat** — stream a conversation beside your code, stop generation safely, and start a clean thread.
- **Ask About Selection** — send selected code or text with an optional question.
- **Save Selection to Knowledge** — index selected content in the server's knowledge base.
- **Remember This** — add a long-term memory note.
- **Test Connection** — verify the URL, authentication, server version, and configured default model.

## Authentication

If `authToken` / `SOVEREIGN_TOKEN` is configured on the server, a bearer token is required for every request, including requests to localhost.

Run **SovereignAI: Set Bearer Token**. The token is saved in VS Code SecretStorage rather than in user or workspace settings, and it is scoped to the configured server origin. Changing the server URL does not send the old server's token to the new server. Use **SovereignAI: Forget Bearer Token** to remove it.

Version 0.3 migrates a legacy user-level `sovereignai.authToken` setting into SecretStorage and clears plaintext values. Legacy workspace/folder token values are removed without being trusted or migrated.

## Settings

| Setting | Default | Description |
|---|---|---|
| `sovereignai.serverUrl` | `http://127.0.0.1:4321` | Server origin, with no path, query, credentials, or fragment |
| `sovereignai.persona` | `Engineer` | Exact persona name; blank uses the server default |

For a server on another machine, prefer HTTPS or an encrypted private network. A bearer token sent over ordinary remote HTTP can be observed by anyone able to inspect that traffic.

The server URL is machine-scoped: workspace or folder settings cannot redirect selected code, chat, or knowledge writes to another origin.

## Data path and privacy

The extension sends only the content you explicitly submit to the configured SovereignAI server and has no telemetry. Model-provider traffic is determined by that server's configuration: Ollama can stay local, while OpenAI-compatible or Anthropic providers send prompts to their configured endpoints. Saved selections, memories, and conversations are stored by the server.

## Development

The extension has no runtime dependencies. Run its focused tests with:

```bash
cd integrations/vscode
npm test
```

The repository does not check in generated VSIX binaries. The release workflow builds a fresh, explicitly versioned artifact from this source package.
