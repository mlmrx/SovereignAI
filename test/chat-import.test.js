import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as chatgpt from '../src/chat-import/chatgpt.js';
import * as claude from '../src/chat-import/claude.js';
import * as gemini from '../src/chat-import/gemini.js';
import * as generic from '../src/chat-import/generic.js';
import { parseChatExport, supportedPlatforms, ChatImportError } from '../src/chat-import/index.js';

// ---------------------------------------------------------------------------
// A minimal, zero-dep "stored" (uncompressed) ZIP writer for tests only.
// readZipEntries (src/ingest/zip.js) doesn't validate CRC-32, so this uses 0
// for every entry's checksum rather than implementing CRC-32 just for tests.
// ---------------------------------------------------------------------------
function buildStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(0, 14); // crc32 (unchecked by our reader)
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16); // crc32
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const localSection = Buffer.concat(localParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localSection.length, 16); // central dir starts right after local section
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, centralDir, eocd]);
}

// ---------------------------------------------------------------------------
// ChatGPT
// ---------------------------------------------------------------------------

function chatgptFixture() {
  return {
    title: 'Trip planning',
    create_time: 1700000000,
    update_time: 1700000100,
    conversation_id: 'convo-abc',
    current_node: 'n4',
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['n1'] },
      n1: {
        id: 'n1',
        message: { author: { role: 'system' }, content: { content_type: 'text', parts: [''] }, create_time: 1700000000 },
        parent: 'root',
        children: ['n2'],
      },
      n2: {
        id: 'n2',
        message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Where should I go in Japan?'] }, create_time: 1700000010 },
        parent: 'n1',
        children: ['n2b', 'n3'],
      },
      n2b: {
        // an abandoned regeneration branch — must NOT appear in the import
        id: 'n2b',
        message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['(discarded first attempt)'] }, create_time: 1700000015 },
        parent: 'n2',
        children: [],
      },
      n3: {
        id: 'n3',
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['Try Kyoto', 'and Osaka.'] },
          create_time: 1700000020,
        },
        parent: 'n2',
        children: ['n3b', 'n4'],
      },
      n3b: {
        id: 'n3b',
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['hidden tool note'] },
          create_time: 1700000021,
          metadata: { is_visually_hidden_from_conversation: true },
        },
        parent: 'n3',
        children: [],
      },
      n4: {
        id: 'n4',
        message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Thanks!'] }, create_time: 1700000030 },
        parent: 'n3',
        children: [],
      },
    },
  };
}

test('chatgpt.detect recognizes a mapping-shaped export and rejects other shapes', () => {
  assert.equal(chatgpt.detect([chatgptFixture()]), true);
  assert.equal(chatgpt.detect([{ chat_messages: [] }]), false);
  assert.equal(chatgpt.detect({}), false);
});

test('chatgpt.parse walks only the active branch, skips hidden/system-empty/tool nodes, joins multi-part content, and converts Unix timestamps', () => {
  const { conversations, warnings } = chatgpt.parse([chatgptFixture()]);
  assert.deepEqual(warnings, []);
  assert.equal(conversations.length, 1);
  const convo = conversations[0];
  assert.equal(convo.externalId, 'convo-abc');
  assert.equal(convo.title, 'Trip planning');
  assert.equal(convo.createdAt, new Date(1700000000 * 1000).toISOString());
  assert.equal(convo.updatedAt, new Date(1700000100 * 1000).toISOString());
  assert.deepEqual(
    convo.messages.map((m) => [m.role, m.content]),
    [
      ['user', 'Where should I go in Japan?'],
      ['assistant', 'Try Kyoto\n\nand Osaka.'],
      ['user', 'Thanks!'],
    ]
  );
  assert.equal(convo.messages[0].createdAt, new Date(1700000010 * 1000).toISOString());
});

test('chatgpt.parse falls back to a childless leaf when current_node is missing or dangling', () => {
  const fixture = chatgptFixture();
  delete fixture.current_node;
  const { conversations } = chatgpt.parse([fixture]);
  // Both n3b (hidden) and n4 are leaves; n4 is the one that should win since n3b is filtered as hidden.
  assert.ok(conversations[0].messages.some((m) => m.content === 'Thanks!'));
});

test('chatgpt.parse skips a conversation with no mapping and one with no importable messages, with clear warnings', () => {
  const noMapping = { title: 'broken' };
  const emptyMapping = { title: 'empty', mapping: { root: { id: 'root', message: null, parent: null, children: [] } }, current_node: 'root' };
  const { conversations, warnings } = chatgpt.parse([noMapping, emptyMapping]);
  assert.equal(conversations.length, 0);
  assert.match(warnings[0], /missing a message tree/);
  assert.match(warnings[1], /no importable user\/assistant messages/);
});

test('chatgpt.parse rejects non-array input', () => {
  assert.throws(() => chatgpt.parse({ mapping: {} }), ChatImportError);
});

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

test('claude.detect recognizes chat_messages and rejects other shapes', () => {
  assert.equal(claude.detect([{ chat_messages: [] }]), true);
  assert.equal(claude.detect([chatgptFixture()]), false);
});

test('claude.parse handles both the flat "text" field and the "content" block array, and maps human/assistant senders', () => {
  const fixture = [
    {
      uuid: 'convo-1',
      name: 'Recipe ideas',
      created_at: '2024-03-01T10:00:00.000000Z',
      updated_at: '2024-03-01T10:05:00.000000Z',
      chat_messages: [
        { uuid: 'm1', sender: 'human', text: 'What can I cook with eggplant?', created_at: '2024-03-01T10:00:00.000000Z' },
        {
          uuid: 'm2',
          sender: 'assistant',
          content: [{ type: 'text', text: 'Try baba ganoush' }, { type: 'tool_use', name: 'search' }],
          created_at: '2024-03-01T10:01:00.000000Z',
        },
      ],
    },
  ];
  const { conversations, warnings } = claude.parse(fixture);
  assert.deepEqual(warnings, []);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].externalId, 'convo-1');
  assert.equal(conversations[0].title, 'Recipe ideas');
  assert.equal(conversations[0].createdAt, '2024-03-01T10:00:00.000Z');
  assert.deepEqual(
    conversations[0].messages.map((m) => [m.role, m.content]),
    [
      ['user', 'What can I cook with eggplant?'],
      ['assistant', 'Try baba ganoush'],
    ]
  );
});

test('claude.parse skips a conversation with no chat_messages array and one where every message is empty', () => {
  const { conversations, warnings } = claude.parse([
    { name: 'broken' },
    { name: 'empty', chat_messages: [{ sender: 'human', text: '' }] },
  ]);
  assert.equal(conversations.length, 0);
  assert.match(warnings[0], /missing "chat_messages"/);
  assert.match(warnings[1], /no importable messages/);
});

test('claude.parse rejects non-array input', () => {
  assert.throws(() => claude.parse({ chat_messages: [] }), ChatImportError);
});

// ---------------------------------------------------------------------------
// Gemini (experimental)
// ---------------------------------------------------------------------------

test('gemini.detect requires Gemini/Bard attribution, not just title/time', () => {
  assert.equal(gemini.detect([{ header: 'Gemini Apps', title: 'Asked Gemini: hi', time: '2024-01-01T00:00:00Z' }]), true);
  assert.equal(gemini.detect([{ header: 'Search', title: 'searched for cats', time: '2024-01-01T00:00:00Z' }]), false);
});

test('gemini.parse strips known prompt prefixes, imports as single-message conversations, and always warns that it is experimental/prompt-only', () => {
  const fixture = [
    { header: 'Gemini Apps', products: ['Gemini Apps'], title: 'Asked Gemini: What is the tallest mountain?', time: '2024-01-01T00:00:00.000Z' },
    { header: 'Search', title: 'searched for cats', time: '2024-01-01T00:00:01.000Z' },
  ];
  const { conversations, warnings } = gemini.parse(fixture);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].messages.length, 1);
  assert.equal(conversations[0].messages[0].role, 'user');
  assert.equal(conversations[0].messages[0].content, 'What is the tallest mountain?');
  assert.ok(warnings.some((w) => /experimental/i.test(w)));
  assert.ok(warnings.some((w) => /Ignored 1 activity entry/.test(w)));
});

test('gemini.parse rejects non-array input', () => {
  assert.throws(() => gemini.parse({}), ChatImportError);
});

// ---------------------------------------------------------------------------
// Generic fallback
// ---------------------------------------------------------------------------

test('generic.detect accepts a bare array or a {conversations:[...]} wrapper, both with a messages array', () => {
  assert.equal(generic.detect([{ messages: [{ role: 'user', content: 'hi' }] }]), true);
  assert.equal(generic.detect({ conversations: [{ messages: [{ role: 'user', content: 'hi' }] }] }), true);
  assert.equal(generic.detect([{ title: 'no messages field' }]), false);
});

test('generic.parse accepts either shape, validates roles, and preserves an explicit externalId for idempotent re-import', () => {
  const bareArray = [{ externalId: 'ext-1', title: 'From Grok', messages: [{ role: 'user', content: 'hello' }, { role: 'bogus', content: 'dropped' }] }];
  const { conversations: fromArray } = generic.parse(bareArray);
  assert.equal(fromArray[0].externalId, 'ext-1');
  assert.equal(fromArray[0].messages.length, 1);

  const wrapped = { conversations: [{ title: 'From Kimi', messages: [{ role: 'assistant', content: 'hi there' }] }] };
  const { conversations: fromWrapped } = generic.parse(wrapped);
  assert.equal(fromWrapped.length, 1);
  assert.equal(fromWrapped[0].messages[0].role, 'assistant');
});

test('generic.parse rejects a shape with no recognizable conversation list', () => {
  assert.throws(() => generic.parse({ nope: true }), ChatImportError);
});

// ---------------------------------------------------------------------------
// Dispatcher: auto-detection, explicit platform override, and ZIP handling
// ---------------------------------------------------------------------------

test('supportedPlatforms lists all four parsers', () => {
  assert.deepEqual(supportedPlatforms().sort(), ['chatgpt', 'claude', 'generic', 'gemini'].sort());
});

test('parseChatExport auto-detects ChatGPT, Claude, and generic shapes from a raw JSON buffer', () => {
  const gpt = parseChatExport(Buffer.from(JSON.stringify([chatgptFixture()])));
  assert.equal(gpt.platform, 'chatgpt');
  assert.equal(gpt.conversations.length, 1);

  const cl = parseChatExport(Buffer.from(JSON.stringify([{ uuid: 'c1', name: 'x', chat_messages: [{ sender: 'human', text: 'hi' }] }])));
  assert.equal(cl.platform, 'claude');

  const gen = parseChatExport(Buffer.from(JSON.stringify([{ title: 'x', messages: [{ role: 'user', content: 'hi' }] }])));
  assert.equal(gen.platform, 'generic');
});

test('parseChatExport respects an explicit platform override even if auto-detection would have picked differently', () => {
  const body = [{ title: 'x', messages: [{ role: 'user', content: 'hi' }] }];
  const result = parseChatExport(Buffer.from(JSON.stringify(body)), { platform: 'generic' });
  assert.equal(result.platform, 'generic');
});

test('parseChatExport rejects an unknown platform override', () => {
  assert.throws(
    () => parseChatExport(Buffer.from('[]'), { platform: 'nope' }),
    (err) => err instanceof ChatImportError && /Unknown platform "nope"/.test(err.message)
  );
});

test('parseChatExport throws a clear error for unrecognizable JSON with no override', () => {
  assert.throws(
    () => parseChatExport(Buffer.from(JSON.stringify({ some: 'unrelated shape' }))),
    (err) => err instanceof ChatImportError && /Could not recognize/.test(err.message)
  );
});

test('parseChatExport throws a clear error for malformed JSON', () => {
  assert.throws(
    () => parseChatExport(Buffer.from('{not json')),
    (err) => err instanceof ChatImportError && /Could not parse/.test(err.message)
  );
});

test('parseChatExport extracts conversations.json from a real ZIP archive, matching what ChatGPT/Claude actually email', () => {
  const payload = JSON.stringify([chatgptFixture()]);
  const zip = buildStoredZip({ 'conversations.json': payload, 'message_feedback.json': '[]' });
  const result = parseChatExport(zip);
  assert.equal(result.platform, 'chatgpt');
  assert.equal(result.conversations.length, 1);
});

test('parseChatExport gives a clear error when a ZIP has no conversations.json', () => {
  const zip = buildStoredZip({ 'readme.txt': 'not the right file' });
  assert.throws(
    () => parseChatExport(zip),
    (err) => err instanceof ChatImportError && /does not contain a conversations\.json/.test(err.message)
  );
});
