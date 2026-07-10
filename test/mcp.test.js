import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, saveConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('MCP enforces tool arguments and never stores missing values as undefined', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = structuredClone(DEFAULT_CONFIG);
  config.providers.ollama.enabled = false;
  config.embeddings.model = '';
  saveConfig(root, config);

  const responses = await runMcp(root, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_memory', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add_memory', arguments: null } },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'add_memory', arguments: { content: 'remembered safely' } },
    },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_memories', arguments: {} } },
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'search_knowledge', arguments: { query: 'anything', limit: 0 } },
    },
    {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'add_knowledge', arguments: { name: 'missing-content.md' } },
    },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ask_sovereign', arguments: {} } },
    {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'ask_sovereign', arguments: { message: 'x', persona: 'Does not exist' } },
    },
    { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'add_memory', arguments: { content: 'm'.repeat(2001) } },
    },
    {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'ask_sovereign', arguments: { message: 'q'.repeat(200001) } },
    },
  ]);

  for (const id of [1, 2, 5, 6, 7, 8, 10, 11]) {
    assert.equal(responses.get(id).result.isError, true, `request ${id} should fail validation`);
  }
  assert.match(responses.get(1).result.content[0].text, /content is required/);
  assert.match(responses.get(2).result.content[0].text, /arguments must be an object/);
  assert.match(responses.get(5).result.content[0].text, /limit must be an integer from 1 to 50/);
  assert.match(responses.get(8).result.content[0].text, /Persona not found/);
  assert.equal(responses.get(3).result.isError, undefined);
  assert.equal(responses.get(4).result.content[0].text, '- remembered safely');
  assert.doesNotMatch(responses.get(4).result.content[0].text, /undefined/);

  const tools = responses.get(9).result.tools;
  const ask = tools.find((tool) => tool.name === 'ask_sovereign');
  const memory = tools.find((tool) => tool.name === 'add_memory');
  assert.match(ask.description, /configured model provider/);
  assert.equal(ask.inputSchema.properties.message.maxLength, 200000);
  assert.equal(memory.inputSchema.properties.content.maxLength, 2000);

  const store = openDb(path.join(root, 'data'));
  assert.deepEqual(store.listMemories().map((row) => row.content), ['remembered safely']);
  assert.equal(store.listDocuments().length, 0);
  store.close();
});

function runMcp(root, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', path.join(repoRoot, 'bin', 'sovereign.js'), 'mcp'], {
      cwd: repoRoot,
      env: { ...process.env, SOVEREIGN_HOME: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`MCP exited ${code}: ${stderr}`));
      const responses = new Map(
        stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .map((response) => [response.id, response])
      );
      resolve(responses);
    });
    child.stdin.end(requests.map((request) => JSON.stringify(request)).join('\n') + '\n');
  });
}
