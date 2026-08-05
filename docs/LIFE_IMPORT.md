# Life Import

You are [the most fragmented database on earth](WHY.md). Life Import is the
reassembly machinery: rails that eat the data exports services legally owe
you, extract the durable facts, and store them — with evidence — where only
you can read them.

**Rail #1 is email**, because the inbox is the backdoor to half your life:
receipts, subscriptions, renewals, bookings, statements all land there. One
file covers domains that would otherwise need a dozen bespoke parsers.

## Using it

1. **Get your archive.** Google Takeout → select Mail → export → you get an
   `.mbox` file. Any standard mbox (Thunderbird, Apple Mail export) or a
   single `.eml` works too.
2. **Scan it:**

```bash
sovereign import-email All-mail.mbox --dry-run   # preview what would be found
sovereign import-email All-mail.mbox             # store the records
sovereign import-email All-mail.mbox --limit 500 # trial run on a slice
```

3. **See the joins.** The Mind view's **Life signals** panel shows the two
   flagship showcases:
   - **Subscription audit** — recurring merchants inferred from ≥2 sightings
     with a plausible cadence, with an estimated monthly total.
   - **Renewals radar** — everything with a detected renewal/expiry date in
     the next 90 days (and a count of renewal notices whose date couldn't be
     read).

Re-running the same file — or a newer Takeout covering the same history —
skips what's already recorded (idempotent per email Message-ID and record
kind), exactly like chat import.

## What it extracts, and how honestly

Pattern matching, not model calls: subjects, senders, amounts, dates. Four
kinds of record — `receipt`, `subscription`, `renewal`, `booking` — each
carrying:

- **Confidence** — `high` needs corroborating signals (e.g. receipt wording
  *plus* an amount; renewal wording *plus* a parseable date); `medium` is a
  hint. Heuristics are wrong sometimes; the field says so.
- **Evidence** — the subject and the matched lines (≤400 chars) the record
  was built from, so every entry can answer "says who?"
- **Provenance** — sender, message date, Message-ID.

Known limits, stated rather than smoothed over: `MM/DD/YYYY` dates are read
as US-style; amounts recognize `$ € £ USD EUR GBP CAD AUD`; the largest
amount in a message is taken as the total; HTML-only mail is stripped to
text on a best-effort basis. A record you disagree with can be deleted —
and nothing acts on these records automatically.

## What it deliberately does not do

- **No email archive.** Bodies are read, matched, and discarded. Only the
  evidence excerpt is stored. If you want full-text mail search, that is a
  different feature with different stakes, and it should be chosen
  explicitly, not smuggled in.
- **No credentials, no connectors.** No IMAP logins, no OAuth to your mail
  provider, no background sync. You fetch the export; the file never leaves
  your machine. This is the [trust architecture](SOVEREIGNTY.md), not a
  missing feature.
- **No model calls.** Rail #1 is pure heuristics. Model-assisted extraction
  (like chat distillation) may come later as an explicit opt-in with the
  same "cognition stays home" guarantees.

## Portability

`life_records` is the twelfth table in the [export format](EXPORT_FORMAT.md):
checksummed, optionally encrypted, restored byte-for-byte by `sovereign
import` like everything else you own.
