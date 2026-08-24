import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iterateMboxMessages, parseEmail, decodeEncodedWords } from '../src/ingest/mbox.js';
import { scanEmail, importEmailExport } from '../src/life/email-scan.js';
import { subscriptionAudit, upcomingRenewals } from '../src/life/insights.js';
import { openDb, ImportValidationError } from '../src/db.js';
import { createApp } from '../src/server.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'bin', 'sovereign.js');

const FIXTURE_MBOX = [
  'From MAILER-DAEMON Tue Aug  5 10:00:00 2025',
  'Message-ID: <receipt-1@mail.acme.com>',
  'Date: Tue, 05 Aug 2025 10:00:00 +0000',
  'From: "ACME Store" <no-reply@mail.acme.com>',
  'Subject: Your order receipt',
  'Content-Type: multipart/alternative; boundary="XYZ"',
  '',
  '--XYZ',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  'Thanks for your purchase!',
  'Item: Widget $9.99',
  'Order total: $24.99',
  '>From our team, thank you.',
  '--XYZ',
  'Content-Type: text/html; charset="utf-8"',
  '',
  '<p>Thanks for your <b>purchase</b>! Total: $24.99</p>',
  '--XYZ--',
  '',
  'From MAILER-DAEMON Tue Aug  5 11:00:00 2025',
  'Message-ID: <sub-1@billing.streamly.io>',
  'Date: Tue, 05 Aug 2025 11:00:00 +0000',
  'From: no-reply@billing.streamly.io',
  'Subject: =?UTF-8?B?WW91ciBzdWJzY3JpcHRpb24gcmVuZXdz?=',
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Your subscription renews on September 1, 2026 for =E2=82=AC12.99.',
  '',
  'From MAILER-DAEMON Wed Aug  6 09:00:00 2025',
  'Message-ID: <policy-1@insurer.example>',
  'Date: Wed, 06 Aug 2025 09:00:00 +0000',
  'From: "Shield Insurance" <notices@insurer.example>',
  'Subject: Your policy expires soon',
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('Your policy expires on 2026-09-15. Renew today to stay covered.', 'utf8').toString('base64'),
  '',
  'From MAILER-DAEMON Wed Aug  6 10:00:00 2025',
  'Message-ID: <noise-1@friend.example>',
  'Date: Wed, 06 Aug 2025 10:00:00 +0000',
  'From: A Friend <friend@friend.example>',
  'Subject: lunch tomorrow?',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  'Want to grab lunch tomorrow at noon?',
  '',
].join('\r\n');

async function parseFixture() {
  const messages = [];
  for await (const { raw } of iterateMboxMessages([Buffer.from(FIXTURE_MBOX, 'utf8')])) {
    messages.push(parseEmail(raw));
  }
  return messages;
}

test('mbox parser: splits messages, walks MIME, decodes base64/QP/encoded-words, unescapes mboxrd', async () => {
  const messages = await parseFixture();
  assert.equal(messages.length, 4);

  const receipt = messages[0];
  assert.equal(receipt.messageId, 'receipt-1@mail.acme.com');
  assert.equal(receipt.from.name, 'ACME Store');
  assert.match(receipt.text, /Order total: \$24\.99/);
  assert.match(receipt.text, /^From our team/m, 'mboxrd >From must be unescaped');
  assert.ok(!receipt.text.includes('<p>'), 'text/plain part must win over html');

  const subscription = messages[1];
  assert.equal(subscription.subject, 'Your subscription renews');
  assert.match(subscription.text, /renews on September 1, 2026 for €12\.99/, 'quoted-printable € must decode');

  const policy = messages[2];
  assert.match(policy.text, /expires on 2026-09-15/, 'base64 body must decode');
  assert.equal(decodeEncodedWords('=?UTF-8?Q?caf=C3=A9?='), 'café');
});

test('mbox parser: a bare .eml without From_ separators is one message', async () => {
  const eml = 'Message-ID: <solo@x>\r\nSubject: Solo\r\nFrom: a@b.c\r\nDate: Tue, 05 Aug 2025 10:00:00 +0000\r\n\r\nBody here.\r\n';
  const messages = [];
  for await (const { raw } of iterateMboxMessages([Buffer.from(eml)])) messages.push(parseEmail(raw));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].subject, 'Solo');
});

test('scanner: classifies receipts, subscriptions, renewals; skips noise; cleans merchant names', async () => {
  const [receiptMsg, subMsg, policyMsg, noiseMsg] = await parseFixture();

  const receipt = scanEmail(receiptMsg);
  assert.equal(receipt.length, 1);
  assert.equal(receipt[0].kind, 'receipt');
  assert.equal(receipt[0].confidence, 'high');
  assert.equal(receipt[0].amount, 24.99, 'the total (largest amount) must win');
  assert.equal(receipt[0].currency, 'USD');
  assert.equal(receipt[0].merchant, 'ACME Store');

  const sub = scanEmail(subMsg);
  const kinds = sub.map((record) => record.kind).sort();
  assert.deepEqual(kinds, ['renewal', 'subscription']);
  const renewal = sub.find((record) => record.kind === 'renewal');
  assert.equal(renewal.renewsAt, '2026-09-01T00:00:00.000Z');
  assert.equal(sub.find((record) => record.kind === 'subscription').confidence, 'high');
  assert.equal(renewal.merchant, 'Streamly', 'noreply/billing domains must reduce to the base name');

  const policy = scanEmail(policyMsg);
  const policyRenewal = policy.find((record) => record.kind === 'renewal');
  assert.equal(policyRenewal.renewsAt, '2026-09-15T00:00:00.000Z');
  assert.equal(policyRenewal.merchant, 'Shield Insurance');

  assert.deepEqual(scanEmail(noiseMsg), [], 'ordinary mail must produce nothing');
});

test('importEmailExport: idempotent, dry-run stores nothing, limit respected', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-life-'));
  const store = openDb(dir);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const source = () => [Buffer.from(FIXTURE_MBOX, 'utf8')];

  const dry = await importEmailExport(store, source(), { dryRun: true });
  assert.ok(dry.added >= 4);
  assert.equal(store.listLifeRecords().length, 0, 'dry run must not write');

  const first = await importEmailExport(store, source());
  assert.equal(first.scanned, 4);
  assert.equal(store.listLifeRecords().length, first.added);
  assert.ok(first.byKind.receipt >= 1 && first.byKind.subscription >= 1 && first.byKind.renewal >= 2);

  const second = await importEmailExport(store, source());
  assert.equal(second.added, 0, 're-import must skip everything');
  assert.equal(second.skipped, first.added);

  const limited = await importEmailExport(store, source(), { limit: 1 });
  assert.equal(limited.scanned, 1);
});

test('insights: subscription audit detects monthly cadence; renewals radar windows correctly', () => {
  const now = new Date('2026-08-05T00:00:00.000Z');
  const monthly = (iso, amount) => ({
    kind: 'receipt', merchant: 'Streamly', sender: 'billing@streamly.io', amount, currency: 'EUR',
    occurred_at: iso, renews_at: null, confidence: 'high', subject: 'Receipt',
  });
  const records = [
    monthly('2026-05-01T00:00:00.000Z', 12.99),
    monthly('2026-06-01T00:00:00.000Z', 12.99),
    monthly('2026-07-01T00:00:00.000Z', 13.99),
    { kind: 'receipt', merchant: 'One-off Shop', sender: 's@x.y', amount: 99, currency: 'USD', occurred_at: '2026-07-04T00:00:00.000Z', renews_at: null, confidence: 'high', subject: 'Order' },
    { kind: 'renewal', merchant: 'Shield Insurance', sender: 'n@i.e', amount: null, currency: null, occurred_at: '2026-08-01T00:00:00.000Z', renews_at: '2026-09-15T00:00:00.000Z', confidence: 'high', subject: 'Policy expires soon' },
    { kind: 'renewal', merchant: 'Far Future', sender: 'f@f.f', amount: null, currency: null, occurred_at: '2026-08-01T00:00:00.000Z', renews_at: '2027-08-01T00:00:00.000Z', confidence: 'high', subject: 'Eventually' },
    { kind: 'renewal', merchant: 'No Date Co', sender: 'n@d.c', amount: null, currency: null, occurred_at: '2026-08-01T00:00:00.000Z', renews_at: null, confidence: 'medium', subject: 'Renewal notice' },
  ];

  const audit = subscriptionAudit(records, { now });
  assert.equal(audit.recurring.length, 1, 'one-off merchants must not appear');
  assert.equal(audit.recurring[0].merchant, 'Streamly');
  assert.equal(audit.recurring[0].cadence, 'monthly');
  assert.equal(audit.recurring[0].monthlyEstimate, 12.99);
  assert.equal(audit.estimatedMonthly, 12.99);

  const radar = upcomingRenewals(records, { now, withinDays: 90 });
  assert.deepEqual(radar.upcoming.map((item) => item.merchant), ['Shield Insurance'], 'a renewal a year out is outside the radar');
  assert.equal(radar.upcoming[0].daysAway, 41);
  assert.equal(radar.undated, 1);
});

test('life records round-trip through export/import and reject unknown kinds', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-life-rt-'));
  const store = openDb(dir);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  store.addLifeRecord({ kind: 'subscription', merchant: 'Streamly', amount: 12.99, currency: 'EUR', occurredAt: '2026-07-01T00:00:00.000Z', externalId: 'sub-1@x', subject: 'Sub', sender: 'b@s.io', excerpt: 'evidence', confidence: 'high' });
  const exported = store.exportAll();
  assert.equal(exported.life_records.length, 1);

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-life-rt2-'));
  const target = openDb(dir2);
  t.after(() => {
    target.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  });
  target.importAll(exported);
  const record = target.listLifeRecords()[0];
  assert.equal(record.merchant, 'Streamly');
  assert.equal(record.amount, 12.99);
  assert.throws(
    () => target.importAll({ life_records: [{ id: 'bad', kind: 'divination', created_at: '2026-01-01T00:00:00.000Z' }] }),
    ImportValidationError
  );
});

test('GET /api/life serves counts, audit, and radar', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-life-api-'));
  fs.writeFileSync(path.join(dir, 'sovereign.config.json'), JSON.stringify({ embeddings: { provider: 'ollama', model: '' }, providers: { ollama: { enabled: false } } }));
  const app = createApp(dir, { env: {}, hardware: { detectGpu: async () => null } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await importEmailExport(app.store, [Buffer.from(FIXTURE_MBOX, 'utf8')]);
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/life`);
  assert.equal(res.status, 200);
  const life = await res.json();
  assert.ok(life.counts.total >= 4);
  assert.ok(Array.isArray(life.audit.recurring));
  assert.ok(Array.isArray(life.renewals.upcoming));
});

test('CLI: import-email scans a fixture mbox end-to-end', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-life-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mboxFile = path.join(home, 'takeout.mbox');
  fs.writeFileSync(mboxFile, FIXTURE_MBOX);

  const dry = spawnSync(process.execPath, ['--no-warnings', cli, 'import-email', mboxFile, '--dry-run'], {
    cwd: repo, env: { ...process.env, SOVEREIGN_HOME: home }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run/i);

  const run = spawnSync(process.execPath, ['--no-warnings', cli, 'import-email', mboxFile], {
    cwd: repo, env: { ...process.env, SOVEREIGN_HOME: home }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Scanned 4 messages/);
  assert.match(run.stdout, /receipt/);
  const db = openDb(path.join(home, 'data'));
  const stored = db.listLifeRecords();
  db.close();
  assert.ok(stored.length >= 4, 'records must be persisted by the real CLI');
  assert.ok(stored.every((record) => record.excerpt.length <= 400), 'excerpts only — never full bodies');
});
