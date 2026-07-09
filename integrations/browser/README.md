# SovereignAI browser extension

Chat with your self-hosted sovereign AI from any tab, and feed it what you read:

- **Popup chat** — streaming conversation with your own AI (toolbar button)
- **Right-click → Save selection to SovereignAI knowledge** — clips text (with source URL) into your private knowledge base
- **Right-click → Remember with SovereignAI** — adds a long-term memory note

Talks only to the server URL you configure (default `http://127.0.0.1:4321`). No third-party calls, no telemetry.

## Install (Chrome / Edge / Brave)

1. Run your server: `node bin/sovereign.js start`
2. Open `chrome://extensions` (or `edge://extensions`)
3. Enable **Developer mode**
4. **Load unpacked** → select this `integrations/browser/` folder

## Install (Firefox 121+)

Firefox MV3 uses event pages instead of service workers. Change the `background` block in `manifest.json` to:

```json
"background": { "scripts": ["background.js"] }
```

Then load via `about:debugging` → **This Firefox** → **Load Temporary Add-on** → pick `manifest.json`.

## Notes

- The popup uses your default persona; manage personas in the web UI.
- An icon set (`icon128.png` etc.) is intentionally omitted for now — browsers fall back to a default icon for unpacked extensions. Add icons before store submission.
