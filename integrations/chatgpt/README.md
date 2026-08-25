# SovereignAI inside ChatGPT (Custom GPT Actions)

Give ChatGPT access to **your** sovereign AI — its memory, knowledge base, and configured models — via a Custom GPT with Actions.

> **Platform constraint:** OpenAI's servers must reach your SovereignAI instance over HTTPS, so you need a public tunnel. SovereignAI's database stays on your machine, but requests and selected context sent through this Action are processed by ChatGPT/OpenAI and your configured model provider. The tunnel is a doorway you control and can close anytime. This is a headless channel: it does not show the customs declaration (the web UI's preview of exactly what leaves before a remote send), so `askSovereign` sends the persona's context without asking.

## 1. Protect your server

Set a token so only you (and your GPT) can use the tunnel:

```jsonc
// sovereign.config.json
{ "authToken": "a-long-random-string" }
```

Restart the server. **Every** API request now requires `Authorization: Bearer <token>`, including localhost and requests forwarded by a local tunnel. Open the `#token=` Web UI URL printed by `sovereign start`; the fragment is not sent to the tunnel and the browser converts it into an authorization header.

## 2. Open a tunnel

Pick one:

```bash
# Cloudflare (free, no account needed for quick tunnels)
cloudflared tunnel --url http://127.0.0.1:4321

# or ngrok
ngrok http 4321
```

Copy the `https://…` URL it prints.

## 3. Create the Custom GPT

1. ChatGPT → **Explore GPTs → Create**
2. Configure → **Actions → Create new action**
3. Paste the contents of [`openapi.yaml`](./openapi.yaml), replacing `https://YOUR-PUBLIC-TUNNEL-URL` with your tunnel URL
4. **Authentication** → API Key → **Bearer** → paste your `authToken`
5. Suggested GPT instructions:

> You are a bridge to the user's private sovereign AI. For questions about the user's personal or company knowledge, call `searchKnowledge` or `askSovereign`. When the user asks you to remember something, call `addMemory`. Prefer the user's own AI for anything personal — it holds their private context.

## 4. Use it

- *"Ask my sovereign AI what our launch codename is"* → `askSovereign`
- *"Search my knowledge base for the Q3 pricing notes"* → `searchKnowledge`
- *"Remember that I switched to the annual plan"* → `addMemory`

## Gemini

Google's **Gemini CLI** speaks MCP — use the MCP integration instead (see `../mcp/README.md`), no tunnel required. For Gemini web/app there is currently no user-installable action system; the OpenAPI spec above is ready for when Google opens one.
