import crypto from 'node:crypto';
import { iterateMboxMessages, parseEmail } from '../ingest/mbox.js';

/**
 * Life Import rail #1: heuristic extraction of life records from email.
 *
 * Deliberately NOT a model pipeline: pattern matching over subjects, senders,
 * amounts, and dates. Heuristics are wrong sometimes, so every record carries
 * a confidence ('high' needs corroborating signals, 'medium' is a hint), the
 * evidence excerpt it was built from, and its Message-ID for idempotent
 * re-import. And deliberately NOT an email archive: bodies are read, matched,
 * and discarded — only the excerpt that justifies the record is stored.
 */

const SIGNALS = {
  receipt:
    /\b(receipt|invoice|payment (?:confirmation|received|successful)|order (?:confirmation|receipt)|your (?:order|purchase)|thank(?:s| you) for your (?:order|purchase|payment))\b/i,
  subscription:
    /\b(subscription|membership|auto.?renew\w*|recurring (?:payment|charge|billing)|your plan|billing (?:period|cycle))\b/i,
  renewal: /\b(renew(?:s|al|ing)?|expires?|expiring|expiration|valid (?:until|through)|due (?:on|by))\b/i,
  booking:
    /\b(booking confirmation|reservation (?:confirmed|confirmation)|itinerary|e-?ticket|check-?in (?:date|time)|flight confirmation)\b/i,
};

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const DATE_PATTERNS = [
  new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, 'i'), // March 5, 2027
  new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS})[a-z]*\\.?,?\\s+(\\d{4})`, 'i'), // 5 March 2027
  /\b(\d{4})-(\d{2})-(\d{2})\b/, // 2027-03-05
  /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/, // 03/05/2027 (read as MM/DD/YYYY — documented)
];

const NOREPLY = /^(no-?reply|noreply|donotreply|notifications?|mailer|updates?)$/i;
const MAIL_SUBDOMAINS = /^(mail|email|e|mailer|marketing|news|newsletter|notify|notifications?|no-?reply|billing|receipts?|info|hello|support|alerts?|updates?)\./i;

/** Scan one parsed email; returns zero or more life-record candidates. */
export function scanEmail(message) {
  const subject = message.subject ?? '';
  const text = (message.text ?? '').slice(0, 4000);
  const haystack = `${subject}\n${text}`;
  const records = [];

  const money = findAmount(haystack);
  const merchant = merchantFrom(message.from);
  const base = {
    merchant,
    occurredAt: message.date,
    sourcePlatform: 'email',
    externalId: message.messageId ?? fallbackId(message),
    subject: subject.slice(0, 300),
    sender: message.from?.address ?? '',
  };

  if (SIGNALS.receipt.test(haystack)) {
    if (money) {
      records.push({ ...base, kind: 'receipt', amount: money.amount, currency: money.currency, confidence: 'high', excerpt: evidence(subject, text, [SIGNALS.receipt, money.pattern]) });
    } else if (SIGNALS.receipt.test(subject)) {
      records.push({ ...base, kind: 'receipt', amount: null, currency: null, confidence: 'medium', excerpt: evidence(subject, text, [SIGNALS.receipt]) });
    }
  }

  if (SIGNALS.subscription.test(haystack)) {
    const corroborated = money || SIGNALS.renewal.test(haystack);
    if (corroborated || SIGNALS.subscription.test(subject)) {
      records.push({
        ...base,
        kind: 'subscription',
        amount: money?.amount ?? null,
        currency: money?.currency ?? null,
        confidence: corroborated ? 'high' : 'medium',
        excerpt: evidence(subject, text, [SIGNALS.subscription, money?.pattern].filter(Boolean)),
      });
    }
  }

  if (SIGNALS.renewal.test(haystack)) {
    const renewsAt = findDateNear(haystack, SIGNALS.renewal);
    if (renewsAt) {
      records.push({ ...base, kind: 'renewal', amount: money?.amount ?? null, currency: money?.currency ?? null, renewsAt, confidence: 'high', excerpt: evidence(subject, text, [SIGNALS.renewal]) });
    } else if (SIGNALS.renewal.test(subject)) {
      records.push({ ...base, kind: 'renewal', amount: null, currency: null, confidence: 'medium', excerpt: evidence(subject, text, [SIGNALS.renewal]) });
    }
  }

  if (SIGNALS.booking.test(haystack)) {
    const travelDate = findDateNear(haystack, SIGNALS.booking) ?? findAnyDate(text);
    records.push({
      ...base,
      kind: 'booking',
      amount: money?.amount ?? null,
      currency: money?.currency ?? null,
      occurredAt: travelDate ?? message.date,
      confidence: travelDate ? 'high' : 'medium',
      excerpt: evidence(subject, text, [SIGNALS.booking]),
    });
  }

  return records;
}

/**
 * Stream an mbox source into the store. Returns totals; never stores bodies.
 * Idempotent per (message, kind) via Message-ID, so re-running an updated
 * Takeout over the same history skips what's already recorded.
 */
export async function importEmailExport(store, source, { limit, dryRun = false, onProgress } = {}) {
  const totals = { scanned: 0, matched: 0, added: 0, skipped: 0, byKind: {} };
  for await (const { raw } of iterateMboxMessages(source)) {
    if (limit && totals.scanned >= limit) break;
    totals.scanned++;
    let candidates;
    try {
      candidates = scanEmail(parseEmail(raw));
    } catch {
      continue; // a malformed message is skipped, never fatal to the run
    }
    if (candidates.length) totals.matched++;
    for (const candidate of candidates) {
      if (store.findLifeRecordByExternal(candidate.sourcePlatform, candidate.externalId, candidate.kind)) {
        totals.skipped++;
        continue;
      }
      if (!dryRun) store.addLifeRecord(candidate);
      totals.added++;
      totals.byKind[candidate.kind] = (totals.byKind[candidate.kind] ?? 0) + 1;
    }
    if (onProgress && totals.scanned % 500 === 0) onProgress(totals);
  }
  return totals;
}

function findAmount(text) {
  const candidates = [];
  for (const match of text.matchAll(/([$€£])\s?(\d[\d,]*(?:\.\d{2})?)/g)) {
    candidates.push({ amount: parseAmount(match[2]), currency: { $: 'USD', '€': 'EUR', '£': 'GBP' }[match[1]], pattern: /([$€£])\s?\d[\d,]*(?:\.\d{2})?/ });
  }
  for (const match of text.matchAll(/\b(USD|EUR|GBP|CAD|AUD)\s?(\d[\d,]*(?:\.\d{2})?)/gi)) {
    candidates.push({ amount: parseAmount(match[2]), currency: match[1].toUpperCase(), pattern: /\b(USD|EUR|GBP|CAD|AUD)\b/i });
  }
  for (const match of text.matchAll(/(\d[\d,]*(?:\.\d{2})?)\s?(USD|EUR|GBP|CAD|AUD)\b/gi)) {
    candidates.push({ amount: parseAmount(match[1]), currency: match[2].toUpperCase(), pattern: /\b(USD|EUR|GBP|CAD|AUD)\b/i });
  }
  const valid = candidates.filter((c) => Number.isFinite(c.amount) && c.amount > 0 && c.amount < 1_000_000);
  if (!valid.length) return null;
  return valid.sort((a, b) => b.amount - a.amount)[0]; // receipts list items + total; the total is the largest
}

function parseAmount(value) {
  return Number.parseFloat(value.replace(/,/g, ''));
}

/** A date within 60 characters after a signal keyword. */
function findDateNear(text, signal) {
  const match = text.match(signal);
  if (!match) return null;
  return findAnyDate(text.slice(match.index, match.index + match[0].length + 60));
}

function findAnyDate(window) {
  for (const [index, pattern] of DATE_PATTERNS.entries()) {
    const match = window.match(pattern);
    if (!match) continue;
    let year, month, day;
    if (index === 0) [year, month, day] = [match[3], monthNumber(match[1]), match[2]];
    else if (index === 1) [year, month, day] = [match[3], monthNumber(match[2]), match[1]];
    else if (index === 2) [year, month, day] = [match[1], match[2], match[3]];
    else [year, month, day] = [match[3], match[1], match[2]];
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const date = new Date(`${iso}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime()) && date.getUTCFullYear() > 1990 && date.getUTCFullYear() < 2100) {
      return `${iso}T00:00:00.000Z`;
    }
  }
  return null;
}

function monthNumber(name) {
  return MONTHS.split('|').indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

function merchantFrom(from) {
  const name = (from?.name ?? '').trim();
  if (name && !NOREPLY.test(name) && !name.includes('@')) return name.slice(0, 120);
  const domain = (from?.address ?? '').split('@')[1] ?? '';
  if (!domain) return name.slice(0, 120) || 'Unknown sender';
  let host = domain.toLowerCase();
  while (MAIL_SUBDOMAINS.test(host)) host = host.replace(MAIL_SUBDOMAINS, '');
  const labels = host.split('.');
  const base = labels.length > 1 ? labels[labels.length - 2] : labels[0];
  return base ? base[0].toUpperCase() + base.slice(1) : 'Unknown sender';
}

/** Subject plus the body lines that actually triggered the match — the receipt for the record. */
function evidence(subject, text, patterns) {
  const lines = [subject];
  for (const pattern of patterns) {
    const line = text.split(/\r?\n/).find((candidate) => pattern.test(candidate));
    if (line && !lines.includes(line.trim())) lines.push(line.trim());
    if (lines.length >= 3) break;
  }
  return lines.join(' | ').slice(0, 400);
}

function fallbackId(message) {
  const hash = crypto
    .createHash('sha256')
    .update(`${message.from?.address ?? ''}\0${message.date ?? ''}\0${message.subject ?? ''}`)
    .digest('hex');
  return `sha256:${hash}`;
}
