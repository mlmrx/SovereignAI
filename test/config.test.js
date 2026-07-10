import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConfigValidationError,
  DEFAULT_CONFIG,
  configPath,
  loadConfig,
  mergeConfigUpdate,
  saveConfig,
} from '../src/config.js';

test('config updates are normalized and reject unknown or malformed fields', () => {
  const current = structuredClone(DEFAULT_CONFIG);
  const updated = mergeConfigUpdate(current, {
    name: '  Private Copilot  ',
    providers: { openai: { baseUrl: 'http://localhost:8000/' } },
    limits: { maxTokens: 4096 },
  });
  assert.equal(updated.name, 'Private Copilot');
  assert.equal(updated.providers.openai.baseUrl, 'http://localhost:8000');
  assert.equal(updated.limits.maxTokens, 4096);
  assert.throws(() => mergeConfigUpdate(current, { providers: null }), ConfigValidationError);
  assert.throws(() => mergeConfigUpdate(current, { unexpected: true }), /unknown field/);
  assert.throws(() => mergeConfigUpdate(current, { limits: { maxTokens: -1 } }), /integer from/);
  assert.throws(
    () => mergeConfigUpdate(current, { providers: { openai: { baseUrl: 'https://user:secret@example.com' } } }),
    /must not contain credentials/
  );
  assert.throws(
    () => mergeConfigUpdate(current, { providers: { openai: { baseUrl: 'https://example.com?api_key=secret' } } }),
    /query string or fragment/
  );
  assert.throws(
    () => mergeConfigUpdate(current, JSON.parse('{"defaults":{"__proto__":{"provider":"anthropic"}}}')),
    ConfigValidationError
  );
});

test('config writes are atomic, reloadable, and private on POSIX', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-config-'));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.name = 'Atomic AI';
    saveConfig(root, config);
    assert.equal(loadConfig(root).name, 'Atomic AI');
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.endsWith('.tmp')),
      []
    );
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(configPath(root)).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
