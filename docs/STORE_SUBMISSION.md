# Store submission guide

Everything in the repository is submission-ready: versioned artifacts come out
of the release workflow, every surface ships the brand icon, and the listing
copy below can be pasted as-is. The only things that cannot live in the repo
are the marketplace accounts themselves and their one-time review flows — this
guide is the checklist for that last mile.

Artifacts come from tagging a release (`git tag v0.3.0 && git push origin
v0.3.0`), which attaches to the GitHub Release:

| Artifact | Store |
|---|---|
| `sovereignai-<version>.vsix` | VS Code Marketplace, Open VSX |
| `sovereignai-browser-<version>.zip` | Chrome Web Store, Firefox Add-ons (AMO), Edge Add-ons |
| `sovereignai-jetbrains-<version>.zip` (from `build/distributions`) | JetBrains Marketplace |
| `sovereign-v<version>-{linux,win,macos}-*` | GitHub Releases (no store account needed) |

## Shared listing copy

**Name:** SovereignAI — Your Own AI

**Short description:** Chat with your self-hosted SovereignAI workspace:
your models, your memory, your knowledge, on your machine.

**Long description:** SovereignAI is a private, fair-source AI command
center you run yourself — local models via Ollama, optional BYO-key providers,
durable memory, and a local document knowledge base. This extension connects
to *your* SovereignAI server (localhost by default) so you can use your
personas, memory, and knowledge without leaving your editor/browser. No
telemetry, no analytics, no third-party services: every request goes only to
the server address you configure, and your configured model provider's data
path applies.

**Privacy disclosure (all stores ask):** The extension collects no data.
All traffic goes exclusively to the user-configured SovereignAI server
(default `http://127.0.0.1:4321`). Remote origins are opt-in and guarded by a
bearer token stored locally in the browser/IDE.

## VS Code Marketplace (`VSCE_PAT`)

1. Create a publisher named `sovereignai` at
   https://marketplace.visualstudio.com/manage (needs a Microsoft account).
2. Generate a Personal Access Token (Azure DevOps → Marketplace → Manage).
3. Add it as the `VSCE_PAT` repository secret — the release workflow then
   publishes automatically on every tag. No further manual steps.

## Open VSX (`OVSX_PAT`) — used by Cursor, Windsurf, VSCodium

1. Sign in at https://open-vsx.org with GitHub, sign the publisher agreement.
2. Create the `sovereignai` namespace (`npx ovsx create-namespace sovereignai`).
3. Add an access token as the `OVSX_PAT` repository secret — publishing then
   runs automatically on every tag.

## Chrome Web Store

1. Register a developer account at
   https://chrome.google.com/webstore/devconsole (one-time 5 USD fee).
2. Upload `sovereignai-browser-<version>.zip`.
3. Listing: category **Productivity › Tools**; icon is embedded in the zip;
   screenshots: popup chat + right-click save-to-knowledge.
4. Data-safety form: "does not collect user data"; justify permissions —
   `contextMenus` (save selection), `storage` (server address + token),
   host permissions (talk to the user's own server; remote origins optional).

## Firefox Add-ons (AMO)

1. Create an account at https://addons.mozilla.org (free); the add-on ID
   `sovereignai@sovereignai.local` is already pinned in the manifest.
2. Submit the same browser zip ("On this site" distribution). Source code
   review: point at this repository — the zip is unminified and dependency-free.

## Edge Add-ons (optional)

The Chrome zip is accepted unchanged at
https://partner.microsoft.com/dashboard/microsoftedge (free account).

## JetBrains Marketplace

1. Create a vendor at https://plugins.jetbrains.com (free); the plugin ID
   `ai.sovereign.plugin` and `pluginIcon.svg` are already in the plugin zip.
2. Upload `sovereignai-jetbrains-<version>.zip` from the release; category
   **Tools integration**.
3. After approval, optional token-based auto-publishing can be added to the
   release workflow with the `intellijPublishToken` Gradle property.

## After the first approvals

Store reviews are the slow step (Chrome ~days, AMO ~days, JetBrains ~1-2
weeks). Once each listing exists, subsequent releases are: tag → CI artifacts →
upload (or automatic for VS Code/Open VSX). Update the README roadmap
checkbox when all four listings are live.
