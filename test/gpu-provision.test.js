import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { provisionContainer, provisionVm, ensureGpuKeypair, gpuKeyPaths, GpuProvisionError } from '../src/byoc/gpu-provision.js';
import { gpuProviders } from '../src/byoc/providers/index.js';

// These tests exercise the orchestration logic (polling, timeouts, error
// propagation, handoff shape) against a FAKE provider — never the real
// runpod/vastai/lambda clients — so they're fast and deterministic
// regardless of what those unverified live APIs actually do. The real
// clients' request/response mapping is covered separately in
// gpu-providers.test.js.
//
// provisionVm's SSH-readiness wait (waitForSsh) is NOT exercised here beyond
// the point where a fake provider fails before reaching it: it calls the
// real platform `ssh` binary against a real reachable host, which this test
// suite has no way to provide. ssh.js/connector.js's existing tests already
// cover createSshRunner's argument handling and connector.deploy's use of a
// runner; this file covers only what's new — the provisioning/polling glue
// in front of that pipeline.

function makeTemp(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sovereign-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function instantSleep() {
  return Promise.resolve();
}

function fakeContainerProvider({ getInstanceSequence, provisionResult = { instanceId: 'fake-1' }, provisionError = null }) {
  let call = 0;
  return {
    id: 'fake',
    label: 'Fake Cloud',
    computeStyle: 'container',
    async provision() {
      if (provisionError) throw provisionError;
      return provisionResult;
    },
    async getInstance() {
      const next = getInstanceSequence[Math.min(call, getInstanceSequence.length - 1)];
      call++;
      return next;
    },
  };
}

function withFakeGpuProvider(id, provider, fn) {
  const original = gpuProviders[id];
  gpuProviders[id] = provider;
  return fn().finally(() => {
    gpuProviders[id] = original;
  });
}

// ---------------------------------------------------------------------------
// provisionContainer
// ---------------------------------------------------------------------------

test('provisionContainer refuses a non-container-style provider and a missing image', async () => {
  await withFakeGpuProvider('fake', fakeContainerProvider({ getInstanceSequence: [] }), async () => {
    await assert.rejects(
      () => provisionContainer({ providerId: 'fake', apiKey: 'k', gpuTypeId: 'g', name: 'main' }),
      (err) => err instanceof GpuProvisionError && /pullable image/.test(err.message)
    );
  });

  const vmProvider = { id: 'fake', label: 'Fake VM Cloud', computeStyle: 'vm' };
  await withFakeGpuProvider('fake', vmProvider, async () => {
    await assert.rejects(
      () => provisionContainer({ providerId: 'fake', apiKey: 'k', gpuTypeId: 'g', name: 'main', image: 'x' }),
      (err) => err instanceof GpuProvisionError && /not a container-style provider/.test(err.message)
    );
  });
});

test('provisionContainer polls until running, then polls HTTP health, then returns a registrable result', async () => {
  const provider = fakeContainerProvider({
    getInstanceSequence: [
      { status: 'pending' },
      { status: 'pending' },
      { status: 'running', host: '198.51.100.7', port: 41234 },
    ],
  });
  let healthCalls = 0;
  const fetchImpl = async (url, options) => {
    healthCalls++;
    assert.equal(url, 'http://198.51.100.7:41234/api/status');
    assert.match(options.headers.authorization, /^Bearer [0-9a-f]{64}$/);
    if (healthCalls < 2) return new Response('', { status: 503 });
    return new Response(JSON.stringify({ version: '9.9.9', setupComplete: false, uptimeSeconds: 1 }), { status: 200 });
  };

  const logs = [];
  await withFakeGpuProvider('fake', provider, async () => {
    const result = await provisionContainer({
      providerId: 'fake', apiKey: 'k', gpuTypeId: 'g', name: 'main', image: 'ghcr.io/x/sovereignai:v1',
      log: (m) => logs.push(m), sleep: instantSleep, fetchImpl,
    });
    assert.equal(result.computeStyle, 'container');
    assert.equal(result.host, '198.51.100.7');
    assert.equal(result.port, 41234);
    assert.equal(result.provider.instanceId, 'fake-1');
    assert.equal(result.provider.gpuTypeId, 'g');
    assert.match(result.token, /^[0-9a-f]{64}$/);
    assert.equal(result.tokenSha256.length, 64);
    assert.equal(result.status.version, '9.9.9');
  });
  assert.equal(healthCalls, 2);
  assert.ok(logs.some((l) => l.includes('Requesting a GPU instance')));
});

test('provisionContainer fails loudly, without silently retrying forever, when the provider reports error/terminated', async () => {
  const provider = fakeContainerProvider({ getInstanceSequence: [{ status: 'error' }] });
  await withFakeGpuProvider('fake', provider, async () => {
    await assert.rejects(
      () => provisionContainer({ providerId: 'fake', apiKey: 'k', gpuTypeId: 'g', name: 'main', image: 'x', sleep: instantSleep }),
      (err) => err instanceof GpuProvisionError && /reports the instance as "error"/.test(err.message)
    );
  });
});

test('provisionContainer times out rather than polling forever when the instance never becomes reachable', async () => {
  const provider = fakeContainerProvider({ getInstanceSequence: [{ status: 'pending' }] });
  await withFakeGpuProvider('fake', provider, async () => {
    await assert.rejects(
      () => provisionContainer({
        providerId: 'fake', apiKey: 'k', gpuTypeId: 'g', name: 'main', image: 'x',
        sleep: instantSleep, provisionTimeoutMs: 5,
      }),
      (err) => err instanceof GpuProvisionError && /did not become reachable/.test(err.message)
    );
  });
});

test('provisionContainer fails if the provider reports running but no address', async () => {
  const provider = fakeContainerProvider({ getInstanceSequence: [{ status: 'running', host: null, port: null }] });
  await withFakeGpuProvider('fake', provider, async () => {
    await assert.rejects(
      () => provisionContainer({ providerId: 'fake', apiKey: 'k', gpuTypeId: 'g', name: 'main', image: 'x', sleep: instantSleep }),
      (err) => err instanceof GpuProvisionError && /did not report a reachable address/.test(err.message)
    );
  });
});

test('provisionContainer times out if SovereignAI never answers on the mapped port', async () => {
  const provider = fakeContainerProvider({ getInstanceSequence: [{ status: 'running', host: 'h', port: 1 }] });
  const fetchImpl = async () => { throw new Error('connection refused'); };
  await withFakeGpuProvider('fake', provider, async () => {
    await assert.rejects(
      () => provisionContainer({
        providerId: 'fake', apiKey: 'k', gpuTypeId: 'g', name: 'main', image: 'x',
        sleep: instantSleep, readyTimeoutMs: 5, fetchImpl,
      }),
      (err) => err instanceof GpuProvisionError && /SovereignAI never answered/.test(err.message)
    );
  });
});

// ---------------------------------------------------------------------------
// ensureGpuKeypair — real ssh-keygen, no network involved
// ---------------------------------------------------------------------------

test('ensureGpuKeypair generates a dedicated ed25519 key and reuses it on a second call', { timeout: 20_000 }, async (t) => {
  const home = makeTemp(t, 'gpu-keypair');
  const { privateKeyPath, publicKey } = await ensureGpuKeypair(home, 'lambda-default');
  assert.equal(privateKeyPath, gpuKeyPaths(home, 'lambda-default').privateKeyPath);
  assert.ok(fs.existsSync(privateKeyPath));
  assert.match(publicKey, /^ssh-ed25519 /);

  const second = await ensureGpuKeypair(home, 'lambda-default');
  assert.equal(second.publicKey, publicKey, 'a second call reuses the same key rather than regenerating it');
});

// ---------------------------------------------------------------------------
// provisionVm — the pre-SSH glue only (see file header for why)
// ---------------------------------------------------------------------------

test('provisionVm refuses a non-vm-style provider and one without ensureSshKey', async () => {
  const containerProvider = { id: 'fake', label: 'Fake Cloud', computeStyle: 'container' };
  await withFakeGpuProvider('fake', containerProvider, async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-gpu-vm-'));
    try {
      await assert.rejects(
        () => provisionVm({ rootDir: home, providerId: 'fake', apiKey: 'k', gpuTypeId: 'g', name: 'main' }),
        (err) => err instanceof GpuProvisionError && /not a VM-style provider/.test(err.message)
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  const noKeySupport = { id: 'fake', label: 'Fake Cloud', computeStyle: 'vm' };
  await withFakeGpuProvider('fake', noKeySupport, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-gpu-vm-'));
    try {
      await assert.rejects(
        () => provisionVm({ rootDir: home, providerId: 'fake', apiKey: 'k', gpuTypeId: 'g', name: 'main' }),
        (err) => err instanceof GpuProvisionError && /does not support SSH key registration/.test(err.message)
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

test('provisionVm registers the SSH key, requests the instance, and fails loudly on a provider error before ever touching real SSH', { timeout: 20_000 }, async (t) => {
  const home = makeTemp(t, 'gpu-vm-error');
  let ensureSshKeyCalled = false;
  const provider = {
    id: 'fake',
    label: 'Fake VM Cloud',
    computeStyle: 'vm',
    async ensureSshKey({ publicKey }) {
      ensureSshKeyCalled = true;
      assert.match(publicKey, /^ssh-ed25519 /);
      return { ref: 'fake-key-ref' };
    },
    async provision({ sshKeyRef }) {
      assert.equal(sshKeyRef, 'fake-key-ref');
      return { instanceId: 'vm-1' };
    },
    async getInstance() {
      return { status: 'error' };
    },
  };
  await withFakeGpuProvider('fake', provider, async () => {
    await assert.rejects(
      () => provisionVm({ rootDir: home, providerId: 'fake', apiKey: 'k', gpuTypeId: 'g', name: 'main', sleep: instantSleep }),
      (err) => err instanceof GpuProvisionError && /reports the instance as "error"/.test(err.message)
    );
  });
  assert.equal(ensureSshKeyCalled, true);
});
