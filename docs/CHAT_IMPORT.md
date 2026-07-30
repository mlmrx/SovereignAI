# Chat history import

Bring your conversation history from another AI platform into this
workspace — `sovereign import-chat <file>` (CLI) or Settings → Data &
privacy → "Import chat history from another platform" (web UI). Parsing
happens entirely on your machine; nothing is uploaded anywhere else, and
re-running the same file twice is safe — already-imported conversations are
skipped, not duplicated.

This is a different thing from `sovereign export`/`sovereign import`, which
back up and restore SovereignAI's own workspace. Chat import brings in
*someone else's* export format and converts it into ordinary SovereignAI
conversations.

## What's supported, and how confident this is

Not every platform gets the same treatment, on purpose — three tiers,
depending on how well-documented and stable each source actually is:

| Platform | Status | Source format |
|---|---|---|
| **ChatGPT** (OpenAI) | Built with real confidence | Official export (Settings → Data controls → Export data), the `conversations.json` inside the emailed ZIP — a well-documented, stable, tree-structured format |
| **Claude** (Anthropic) | Built with real confidence | Official export (Settings → Privacy → Export data), the `conversations.json` inside the emailed ZIP — a simpler, linear format |
| **Gemini** (Google) | Experimental, lower confidence | Google Takeout's "My Activity" JSON export. This is an activity log, not a conversation export — see the caveat below |
| **Grok, Kimi, GLM, DeepSeek, Qwen, or anything else** | Universal fallback | No dedicated parser exists (either no mature self-serve bulk export is known, or its schema wasn't something this could be verified against) — use the **generic JSON** format below instead |

ChatGPT's and Claude's parsers were built from public, stable, well-documented
export schemas — this is closer to the confidence level of, say, the
Hugging Face catalog browser than to the BYOC GPU marketplace clients (which
had to guess at API shapes with no test account available). Every parser is
still defensive: an unrecognized field is skipped with a warning, not a
crash, and nothing is ever silently misattributed.

**Gemini caveat:** Google Takeout's Gemini/Bard activity records were not
verified against a live account while this was built (unlike ChatGPT/Claude,
whose formats are widely documented public knowledge). What's imported is
each activity entry's prompt text as a single-message note — Takeout's
activity log does not reliably capture the model's response in a structured
field the way ChatGPT's/Claude's actual conversation exports do. Treat the
result as a starting point to check, not a faithful transcript. The import
warnings will say this too.

## Getting each platform's export

- **ChatGPT:** Settings → Data controls → Export data. You'll get an email
  with a download link to a ZIP file; use that ZIP directly, no need to
  unpack it.
- **Claude:** Settings → Privacy → Export data. Same pattern — a ZIP arrives
  by email.
- **Gemini:** [Google Takeout](https://takeout.google.com/) → select "My
  Activity" → choose JSON format → include the Gemini Apps/Bard product.

## The generic JSON format (for everything else)

For any platform without a dedicated parser, export or hand-convert your
history into this shape and pass `--from generic` (or let it auto-detect —
this is the fallback when nothing more specific matches):

```json
[
  {
    "title": "Optional conversation title",
    "externalId": "optional-stable-id-for-safe-re-import",
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:05:00Z",
    "messages": [
      { "role": "user", "content": "What's the capital of France?", "createdAt": "2024-01-01T00:00:00Z" },
      { "role": "assistant", "content": "Paris.", "createdAt": "2024-01-01T00:00:05Z" }
    ]
  }
]
```

A `{"conversations": [...]}` wrapper is also accepted. Only `messages` (with
a `role` of `user`/`assistant`/`system` and non-empty `content`) is required
— everything else is optional. `externalId` is what makes re-importing the
same file safe; omit it and re-running will still work, it just won't be
able to tell a re-import apart from new data with the same content-free
positional index, so give it a stable id whenever you can (a hash of the
platform's own conversation id is fine).

If you have an export from one of the platforms above and want a dedicated
parser instead of the generic format, converting it with a script (or asking
an LLM to reshape a sample into the shape above) is the fastest path today —
adding a first-class parser is straightforward (see below) but needs a real
sample of that platform's export to build against responsibly, the same
standard ChatGPT/Claude's parsers were held to.

## What is and isn't imported

- Imported: user/assistant (and, for ChatGPT, non-hidden system) message
  text, with the original timestamps where the source provides them.
- ChatGPT only imports the **active branch** — the conversation as it reads
  today, following `current_node` back to the root — not every abandoned
  regeneration of a response. That's a deliberate scope decision.
- Not imported (from any platform): attachments/images, code-interpreter or
  tool-call payloads, custom instructions or memory features, and (for
  Gemini) the model's responses — see the caveat above.

## Idempotency and identity

Each imported conversation is tagged with `source_platform` and
`external_id` in the database, with a unique index on the pair. Re-running
`import-chat` on the same file — or an updated export that overlaps
previously-imported history — skips what's already there instead of
duplicating it. These two fields round-trip through `sovereign export`/
`sovereign import` (the native backup format) like everything else in the
workspace.

## Adding a new platform parser

Each file in `src/chat-import/` (`chatgpt.js`, `claude.js`, `gemini.js`,
`generic.js`) exports two functions:

```js
export function detect(parsedJson) { /* return true if this looks like your shape */ }
export function parse(parsedJson)  { /* return { conversations, warnings } */ }
```

`conversations` is an array of `{ externalId, title, createdAt, updatedAt,
messages }`, built via `finalizeConversation()` from `shared.js` — see any
existing parser for the pattern, and `src/chat-import/index.js` for where to
register it (`PARSERS` and `DETECT_ORDER`). Do this only once you have a
real sample of that platform's export to verify against; guessing at an
unverifiable schema is exactly what this feature deliberately avoided for
Grok/Kimi/GLM/DeepSeek/Qwen in favor of the generic format instead.
