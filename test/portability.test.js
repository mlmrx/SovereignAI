import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImportValidationError, openDb } from '../src/db.js';
import {
  buildExport,
  buildManifest,
  decryptExport,
  encryptExport,
  isEncryptedExport,
  PortabilityError,
  verifyExportManifest,
} from '../src/portability.js';
import { buildPortfolio } from '../src/portfolio.js';
import { distillConversationMemories } from '../src/memory-extract.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'bin', 'sovereign.js');

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-portability-'));
  const store = openDb(dir);
  t.after(() => {
    try {
      store.close();
    } catch {
      /* already closed by the test */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

function runCli(args, { home, env = {} } = {}) {
  return spawnSync(process.execPath, ['--no-warnings', cli, ...args], {
    cwd: repo,
    env: { ...process.env, SOVEREIGN_HOME: home, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

// ---- memory provenance ----

test('memories record origin, source conversation, and edit time', (t) => {
  const store = tempStore(t);
  const manual = store.addMemory('Prefers concise answers');
  assert.equal(manual.origin, 'manual');
  assert.equal(manual.source_conversation_id, null);
  assert.equal(manual.updated_at, null);

  const convo = store.createConversation({ title: 'About the user' });
  const extracted = store.addMemory('Works on SovereignAI', { origin: 'extracted', sourceConversationId: convo.id });
  assert.equal(extracted.origin, 'extracted');
  assert.equal(extracted.source_conversation_id, convo.id);

  const edited = store.updateMemory(manual.id, 'Prefers very concise answers');
  assert.ok(edited.updated_at, 'editing must stamp updated_at');
  assert.equal(store.listMemories().find((m) => m.id === extracted.id).updated_at, null);

  assert.throws(() => store.addMemory('x'.repeat(20), { origin: 'divined' }), /Unknown memory origin/);
});

test('pre-provenance rows keep NULL origin instead of a fabricated one', (t) => {
  const store = tempStore(t);
  // Simulate a v0.4 row: written before the provenance columns existed.
  store.db
    .prepare("INSERT INTO memories (id, content, created_at) VALUES ('legacy', 'Old fact', '2026-01-01T00:00:00.000Z')")
    .run();
  const legacy = store.listMemories().find((m) => m.id === 'legacy');
  assert.equal(legacy.origin, null);
  assert.equal(legacy.updated_at, null);
});

test('provenance round-trips through export/import; v0.4-shaped rows still validate', (t) => {
  const source = tempStore(t);
  const convo = source.createConversation({ title: 'Origin chat' });
  source.addMemory('Distilled fact from history', {
    origin: 'distilled',
    sourceConversationId: convo.id,
    authorProvider: 'ollama',
    authorModel: 'llama3.1',
  });
  const exported = source.exportAll();

  const target = tempStore(t);
  target.importAll(exported);
  const memory = target.listMemories().find((m) => m.content === 'Distilled fact from history');
  assert.equal(memory.origin, 'distilled');
  assert.equal(memory.source_conversation_id, convo.id);
  assert.equal(memory.author_provider, 'ollama');
  assert.equal(memory.author_model, 'llama3.1');

  // A v0.4 export knows nothing about the new fields — it must import cleanly.
  const counts = target.importAll({
    memories: [{ id: 'old-export-row', content: 'From an old backup', created_at: '2025-12-01T00:00:00.000Z' }],
  });
  assert.equal(counts.memories, 1);
  assert.equal(target.listMemories().find((m) => m.id === 'old-export-row').origin, null);

  assert.throws(
    () =>
      target.importAll({
        memories: [{ id: 'bad', content: 'Nice long content here', created_at: '2025-12-01T00:00:00.000Z', origin: 'divined' }],
      }),
    ImportValidationError
  );
});

// ---- manifest ----

test('export manifest verifies intact data and names the tampered table', (t) => {
  const store = tempStore(t);
  store.addMemory('A durable fact worth keeping');
  const exported = buildExport(store, '0.5.0');
  assert.equal(exported.format, 'sovereignai-export/1');
  assert.equal(verifyExportManifest(exported).status, 'verified');

  const tampered = JSON.parse(JSON.stringify(exported));
  tampered.data.memories[0].content = 'A quietly rewritten fact';
  const result = verifyExportManifest(tampered);
  assert.equal(result.status, 'mismatch');
  assert.ok(result.mismatches.some((m) => m.table === 'memories'), JSON.stringify(result.mismatches));

  const missingTable = JSON.parse(JSON.stringify(exported));
  delete missingTable.data.personas;
  assert.ok(verifyExportManifest(missingTable).mismatches.some((m) => m.table === 'personas'));

  assert.equal(verifyExportManifest({ data: exported.data }).status, 'absent');
});

test('manifest archive digest is order-independent and stable', (t) => {
  const store = tempStore(t);
  store.addMemory('Digest stability check fact');
  const data = store.exportAll();
  const a = buildManifest(data);
  const b = buildManifest(JSON.parse(JSON.stringify(data)));
  assert.equal(a.sha256, b.sha256);
});

// ---- encrypted archives ----

test('encrypted export round-trips and rejects a wrong passphrase', () => {
  const plaintext = JSON.stringify({ data: { memories: [] } });
  const envelope = encryptExport(plaintext, 'correct horse battery');
  assert.equal(isEncryptedExport(envelope), true);
  assert.ok(!JSON.stringify(envelope).includes('memories'), 'plaintext must not leak into the envelope');
  assert.equal(decryptExport(envelope, 'correct horse battery'), plaintext);
  assert.throws(() => decryptExport(envelope, 'wrong passphrase!'), PortabilityError);
  assert.throws(() => encryptExport(plaintext, 'short'), /at least 12 characters/);
});

test('decryption refuses out-of-bounds kdf parameters from untrusted files', () => {
  const envelope = encryptExport('{}', 'a fine passphrase');
  const hostile = { ...envelope, kdf: { ...envelope.kdf, N: 1 << 26 } };
  assert.throws(() => decryptExport(hostile, 'a fine passphrase'), /out-of-bounds/);
  const notPowerOfTwo = { ...envelope, kdf: { ...envelope.kdf, N: 12345 } };
  assert.throws(() => decryptExport(notPowerOfTwo, 'a fine passphrase'), /out-of-bounds/);
});

// ---- portfolio ----

test('portfolio groups memories by origin and inventories without leaking contents', (t) => {
  const store = tempStore(t);
  const convo = store.createConversation({ title: 'Project kickoff' });
  store.addMemory('Owner-recorded preference');
  store.addMemory('Extracted working style', { origin: 'extracted', sourceConversationId: convo.id });
  store.db.prepare("INSERT INTO memories (id, content, created_at) VALUES ('legacy', 'Pre-tracking fact', '2026-01-01T00:00:00.000Z')").run();
  store.createPersona({ name: 'Atlas', system_prompt: 'Careful with ``` fences', description: 'The main persona' });
  store.addDocument({ name: 'secrets.md', size: 128, chunks: [{ content: 'TOP SECRET BODY', embedding: null }], embedded: false });

  const { markdown, counts } = buildPortfolio(store, { name: 'Mia' }, '0.5.0');
  assert.match(markdown, /# Personal Context Portfolio — Mia/);
  assert.match(markdown, /### Recorded by the owner/);
  assert.match(markdown, /### Auto-extracted from live chats/);
  assert.match(markdown, /### Recorded before provenance tracking/);
  assert.match(markdown, /from "Project kickoff"/);
  assert.match(markdown, /secrets\.md \(128 B/);
  assert.ok(!markdown.includes('TOP SECRET BODY'), 'document contents must stay out of the portfolio');
  assert.ok(markdown.includes('````'), 'system prompts containing ``` need a longer fence');
  assert.deepEqual(counts, { memories: 3, personas: 1, documents: 1 });
});

// ---- distillation ----

test('distillConversationMemories stores provenance-tagged facts and dedupes known ones', async (t) => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"- Uses Windows 11 for development\\n- Prefers concise answers\\n- NONE of this is small talk"},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n'
      );
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => provider.close(resolve)));

  const store = tempStore(t);
  store.addMemory('Prefers concise answers'); // already known — must not duplicate
  const conversation = store.importConversation({
    title: 'Imported setup chat',
    external_id: 'ext-1',
    source_platform: 'chatgpt',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  store.importMessage({ conversation_id: conversation.id, role: 'user', content: 'I develop on Windows 11 and like short answers.' });

  const config = {
    defaults: { provider: 'openai', model: 'mock-model' },
    providers: { openai: { enabled: true, baseUrl: `http://127.0.0.1:${provider.address().port}` } },
  };
  const added = await distillConversationMemories({ store, config, conversation, messages: store.listMessages(conversation.id) });
  assert.deepEqual(added, ['Uses Windows 11 for development']);
  const memory = store.listMemories().find((m) => m.content === 'Uses Windows 11 for development');
  assert.equal(memory.origin, 'distilled');
  assert.equal(memory.source_conversation_id, conversation.id);
  assert.equal(store.listMemories().filter((m) => m.content === 'Prefers concise answers').length, 1);
});

test('distillation bookkeeping: only unswept imported conversations are listed', (t) => {
  const store = tempStore(t);
  store.createConversation({ title: 'Native chat — never distillable' });
  const imported = store.importConversation({
    title: 'Imported',
    external_id: 'ext-2',
    source_platform: 'claude',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(store.listDistillableConversations().map((c) => c.id), [imported.id]);
  store.markConversationDistilled(imported.id);
  assert.deepEqual(store.listDistillableConversations(), []);
  assert.deepEqual(store.listDistillableConversations({ redo: true }).map((c) => c.id), [imported.id]);
});

test('distillConversationMemories fails loudly when the provider is unconfigured', async (t) => {
  const store = tempStore(t);
  const conversation = store.createConversation({ title: 'x' });
  await assert.rejects(
    distillConversationMemories({
      store,
      config: { defaults: { provider: 'openai', model: 'm' }, providers: { openai: { enabled: false } } },
      conversation,
      messages: [{ role: 'user', content: 'hello there friend' }],
    }),
    /not configured/
  );
});

// ---- CLI flows ----

test('CLI: export → verify → tamper → verify fails → import refuses; manifest removal is the escape hatch', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-cli-verify-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'backup.json');

  const exported = runCli(['export', file], { home });
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(exported.stdout, /Archive digest sha256:/);

  const verified = runCli(['verify', file], { home });
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Result: verified/);

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  parsed.data.personas[0].system_prompt = 'quietly changed';
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2));

  const failed = runCli(['verify', file], { home });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /FAILED verification/);
  assert.match(failed.stdout, /personas/);

  const refused = runCli(['import', file], { home });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /checksum verification/);

  delete parsed.manifest;
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
  const accepted = runCli(['import', file], { home });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /No manifest/);
});

test('CLI: encrypted export round-trips via SOVEREIGN_EXPORT_PASSPHRASE and rejects the wrong one', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-cli-crypt-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'backup-encrypted.json');
  const env = { SOVEREIGN_EXPORT_PASSPHRASE: 'a strong passphrase' };

  const exported = runCli(['export', '--encrypt', file], { home, env });
  assert.equal(exported.status, 0, exported.stderr);
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(envelope.format, 'sovereignai-export-encrypted/1');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('"personas"'), 'ciphertext must not contain plaintext tables');

  const imported = runCli(['import', file], { home, env });
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stdout, /Decrypted archive/);
  assert.match(imported.stdout, /Checksums verified/);

  const wrong = runCli(['import', file], { home, env: { SOVEREIGN_EXPORT_PASSPHRASE: 'not the passphrase' } });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /wrong passphrase|Decryption failed/);
});

test('CLI: portfolio writes a markdown seed crystal; distill reports when there is nothing to do', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-cli-portfolio-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'portfolio.md');

  const portfolio = runCli(['portfolio', file], { home });
  assert.equal(portfolio.status, 0, portfolio.stderr);
  assert.match(fs.readFileSync(file, 'utf8'), /# Personal Context Portfolio/);

  const distill = runCli(['distill'], { home });
  assert.equal(distill.status, 0, distill.stderr);
  assert.match(distill.stdout, /Nothing to distill|No imported conversations/);
});
