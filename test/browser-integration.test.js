import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserDir = path.join(repo, 'integrations', 'browser');
const read = (file) => fs.readFileSync(path.join(browserDir, file), 'utf8');

test('manifest keeps localhost access and makes remote origins opt-in', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'http://localhost/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.equal(manifest.host_permissions.includes('<all_urls>'), false);
  assert.equal(manifest.optional_host_permissions.includes('<all_urls>'), false);
});

test('popup saves a remote origin permission and keeps its token local and masked', async () => {
  const harness = popupHarness({ serverUrl: 'http://100.64.0.4:4321' });
  harness.elements.get('server-url').value = 'http://100.64.0.5:4321/';
  harness.elements.get('auth-token').value = 'tailnet-secret-token';

  await harness.elements.get('save-settings').listeners.click();

  assert.deepEqual(harness.requestedOrigins, ['http://100.64.0.5/*']);
  assert.deepEqual(harness.removedOrigins, ['http://100.64.0.4/*']);
  assert.equal(harness.storage.sync.serverUrl, 'http://100.64.0.5:4321');
  assert.equal(harness.storage.local.authTokens['http://100.64.0.5:4321'], 'tailnet-secret-token');
  assert.equal('authToken' in harness.storage.sync, false, 'token must never enter synced storage');
  assert.equal(harness.elements.get('auth-token').value, '', 'saved token must not be rendered back into the popup');
  assert.match(harness.elements.get('auth-token').placeholder, /Saved locally/);
  assert.match(harness.elements.get('settings-status').textContent, /only this configured URL/);

  const html = read('popup.html');
  assert.match(html, /id="auth-token" type="password"/);
  assert.doesNotMatch(html, /id="auth-token"[^>]*\svalue=/);
  assert.doesNotMatch(html, /Private\. Local\. Yours\./);
});

test('changing only a remote server port keeps the shared browser host permission', async () => {
  const harness = popupHarness({ serverUrl: 'http://100.64.0.5:4321' });
  harness.elements.get('server-url').value = 'http://100.64.0.5:8080';

  await harness.elements.get('save-settings').listeners.click();

  assert.deepEqual(harness.requestedOrigins, ['http://100.64.0.5/*']);
  assert.deepEqual(harness.removedOrigins, [], 'browser match patterns share one permission across ports');
  assert.equal(harness.storage.sync.serverUrl, 'http://100.64.0.5:8080');
});

test('switching server origins never sends the previous origin token', async () => {
  const harness = popupHarness({ serverUrl: 'http://100.64.0.5:4321', authToken: 'origin-a-secret' });
  harness.elements.get('server-url').value = 'http://100.64.0.6:4321';
  await harness.elements.get('save-settings').listeners.click();

  harness.elements.get('in').value = 'hello new server';
  await harness.context.send();
  assert.equal(harness.fetches[0].url, 'http://100.64.0.6:4321/api/chat');
  assert.equal('authorization' in harness.fetches[0].options.headers, false);

  await harness.elements.get('open-ui').listeners.click({ preventDefault() {} });
  assert.equal(harness.openedTabs[0], 'http://100.64.0.6:4321/');
});

test('an in-flight popup request keeps the token bound to its resolved origin', async () => {
  const originA = 'http://100.64.0.5:4321';
  const originB = 'http://100.64.0.6:4321';
  const harness = popupHarness({ serverUrl: originA, authToken: 'origin-a-secret', permissionSwitchTo: originB });
  harness.storage.local.authTokens[originB] = 'origin-b-secret';
  harness.elements.get('in').value = 'race-safe request';

  await harness.context.send();

  assert.equal(harness.fetches[0].url, `${originA}/api/chat`);
  assert.equal(harness.fetches[0].options.headers.authorization, 'Bearer origin-a-secret');
  assert.equal(harness.storage.sync.serverUrl, originB, 'the test must exercise a concurrent settings change');
});

test('popup chat and web UI use the saved bearer token', async () => {
  const harness = popupHarness({
    serverUrl: 'http://100.64.0.8:4321',
    authToken: 'token-with+/characters',
  });
  harness.elements.get('in').value = 'hello from the popup';

  await harness.context.send();

  assert.equal(harness.fetches.length, 1);
  assert.equal(harness.fetches[0].url, 'http://100.64.0.8:4321/api/chat');
  assert.equal(harness.fetches[0].options.headers.authorization, 'Bearer token-with+/characters');
  assert.equal(JSON.parse(harness.fetches[0].options.body).message, 'hello from the popup');
  assert.equal(harness.elements.get('log').children.at(-1).textContent, 'hello back');

  await harness.elements.get('open-ui').listeners.click({ preventDefault() {} });
  assert.equal(harness.openedTabs[0], 'http://100.64.0.8:4321/#token=token-with%2B%2Fcharacters');
  assert.doesNotMatch(harness.openedTabs[0], /\?token=/, 'token must stay out of server-visible query parameters');
});

test('background context writes send bearer auth and require the saved remote permission', async () => {
  const allowed = backgroundHarness({ permissionGranted: true });
  await allowed.context.post('http://my-tailnet-node:4321/api/memories', { content: 'remember this' });
  assert.deepEqual(allowed.checkedOrigins, ['http://my-tailnet-node/*']);
  assert.equal(allowed.fetches[0].options.headers.authorization, 'Bearer background-secret');
  assert.deepEqual(JSON.parse(allowed.fetches[0].options.body), { content: 'remember this' });

  const denied = backgroundHarness({ permissionGranted: false });
  await assert.rejects(
    denied.context.post('http://my-tailnet-node:4321/api/documents', { name: 'x', content: 'y' }),
    /settings.*grant browser access/i
  );
  assert.equal(denied.fetches.length, 0, 'no request should leave the extension without origin permission');
});

function popupHarness({ serverUrl = 'http://127.0.0.1:4321', authToken = '', permissionSwitchTo = '' } = {}) {
  const elements = new Map();
  for (const id of [
    'log',
    'in',
    'send',
    'settings',
    'server-url',
    'auth-token',
    'settings-status',
    'clear-token',
    'save-settings',
    'open-ui',
    'toggle-settings',
    'empty',
  ]) {
    elements.set(id, fakeElement(id));
  }

  const storage = {
    sync: { serverUrl },
    local: authToken ? { authTokens: { [new URL(serverUrl).origin]: authToken } } : {},
  };
  const requestedOrigins = [];
  const checkedOrigins = [];
  const removedOrigins = [];
  const openedTabs = [];
  const fetches = [];
  const chrome = {
    storage: {
      sync: storageArea(storage.sync),
      local: {
        ...storageArea(storage.local),
        async setAccessLevel() {},
      },
    },
    permissions: {
      async request({ origins }) {
        requestedOrigins.push(...origins);
        return true;
      },
      async contains({ origins }) {
        checkedOrigins.push(...origins);
        if (permissionSwitchTo) storage.sync.serverUrl = permissionSwitchTo;
        return true;
      },
      async remove({ origins }) {
        removedOrigins.push(...origins);
        return true;
      },
    },
    tabs: {
      create({ url }) {
        openedTabs.push(url);
      },
    },
  };
  const document = {
    getElementById(id) {
      return elements.get(id) ?? null;
    },
    createElement() {
      return fakeElement('created');
    },
  };
  const encoder = new TextEncoder();
  const fetch = async (url, options) => {
    fetches.push({ url, options });
    const chunks = [
      encoder.encode(
        'event: meta\ndata: {"conversationId":"conversation-1"}\n\n' +
          'event: delta\ndata: {"text":"hello back"}\n\n' +
          'event: done\ndata: {}\n\n'
      ),
    ];
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              return chunks.length ? { done: false, value: chunks.shift() } : { done: true };
            },
          };
        },
      },
      async json() {
        return {};
      },
    };
  };

  const context = vm.createContext({
    chrome,
    document,
    fetch,
    URL,
    TextDecoder,
    encodeURIComponent,
    console,
  });
  vm.runInContext(read('popup.js'), context, { filename: 'popup.js' });
  return { context, elements, storage, requestedOrigins, checkedOrigins, removedOrigins, openedTabs, fetches };
}

function backgroundHarness({ permissionGranted }) {
  const fetches = [];
  const checkedOrigins = [];
  const clicked = { listener: null };
  const chrome = {
    storage: {
      sync: storageArea({ serverUrl: 'http://my-tailnet-node:4321' }),
      local: {
        ...storageArea({ authTokens: { 'http://my-tailnet-node:4321': 'background-secret' } }),
        async setAccessLevel() {},
      },
    },
    permissions: {
      async contains({ origins }) {
        checkedOrigins.push(...origins);
        return permissionGranted;
      },
    },
    runtime: { onInstalled: { addListener() {} } },
    contextMenus: {
      create() {},
      onClicked: {
        addListener(listener) {
          clicked.listener = listener;
        },
      },
    },
    action: {
      setBadgeBackgroundColor() {},
      setBadgeText() {},
      setTitle() {},
    },
  };
  const fetch = async (url, options) => {
    fetches.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true };
      },
    };
  };
  const context = vm.createContext({ chrome, fetch, URL, setTimeout() {}, console });
  vm.runInContext(read('background.js'), context, { filename: 'background.js' });
  return { context, fetches, checkedOrigins, clicked };
}

function storageArea(state) {
  return {
    async get(defaults = {}) {
      return { ...defaults, ...state };
    },
    async set(values) {
      Object.assign(state, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
  };
}

function fakeElement(id) {
  return {
    id,
    value: '',
    textContent: '',
    className: '',
    placeholder: '',
    disabled: false,
    style: { display: '' },
    children: [],
    listeners: {},
    scrollTop: 0,
    scrollHeight: 0,
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    appendChild(child) {
      this.children.push(child);
    },
    remove() {},
  };
}
