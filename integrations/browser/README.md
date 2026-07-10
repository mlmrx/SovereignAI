# SovereignAI browser extension

Chat with your self-hosted sovereign AI from any tab, and feed it what you read:

- **Popup chat** — streaming conversation with your own AI (toolbar button)
- **Right-click → Save selection to SovereignAI knowledge** — clips text (with source URL) into your private knowledge base
- **Right-click → Remember with SovereignAI** — adds a long-term memory note

The extension talks only to the SovereignAI server URL you configure (default `http://127.0.0.1:4321`) and has no telemetry. Any model-provider traffic follows your server configuration. Localhost access is included; a LAN, tailnet, or HTTPS server gets access only after you save it and approve the browser prompt for that scheme and host. Browser host permissions apply across ports, while requests still go only to the configured URL.

## Install (Chrome / Edge / Brave)

1. Run your server: `node bin/sovereign.js start`
2. Open `chrome://extensions` (or `edge://extensions`)
3. Enable **Developer mode**
4. **Load unpacked** → select this `integrations/browser/` folder

Open the extension's **server** panel and save:

- **Server URL** — keep `http://127.0.0.1:4321` for the local default
- **Bearer token** — paste the token from the authenticated URL printed by SovereignAI when a token is configured

The server URL may sync with your browser profile. Tokens do **not** sync: each is stored in extension-local storage and scoped to one exact server origin, entered through a password field, and never displayed again. Switching origins never reuses the previous token. Use **Forget token** to remove the token for the current server.

## LAN / tailnet server

Start SovereignAI in protected LAN mode:

```bash
sovereign start --lan
```

From one of the printed URLs, enter only the origin before `/#token=` in **Server URL** (for example, `http://100.64.0.5:4321`) and paste the fragment's token into **Bearer token**. Saving a non-local server triggers a browser permission prompt for that scheme and host (all ports, as required by browser match-pattern rules). Changing scheme or host removes the previous optional permission; port changes share the browser permission but still use separately scoped tokens. Context-menu saves and popup chat both send the current origin's bearer token.

Plain HTTP exposes the bearer token and chat/context traffic to network observers. Use it only on a trusted LAN or encrypted tailnet; use an HTTPS endpoint elsewhere.

## Install (Firefox 121+)

Firefox MV3 uses event pages instead of service workers. Change the `background` block in `manifest.json` to:

```json
"background": { "scripts": ["background.js"] }
```

Then load via `about:debugging` → **This Firefox** → **Load Temporary Add-on** → pick `manifest.json`.

## Notes

- The popup uses your default persona; manage personas in the web UI.
- **Web UI** passes the saved token in a `#token=` URL fragment, which browsers do not send in HTTP request URLs or access logs. The page stores it for authorization and immediately removes it from the address bar.
- The manifest declares HTTP/HTTPS host patterns only as *optional* permissions. They are not granted automatically or wholesale; the extension requests one configured scheme + host at a time. Localhost is the only required host access.
- An icon set (`icon128.png` etc.) is intentionally omitted for now — browsers fall back to a default icon for unpacked extensions. Add icons before store submission.
