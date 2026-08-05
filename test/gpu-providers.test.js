import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runpod } from '../src/byoc/providers/runpod.js';
import { vastai } from '../src/byoc/providers/vastai.js';
import { lambda } from '../src/byoc/providers/lambda.js';
import { GpuProviderError } from '../src/byoc/providers/shared.js';
import { getGpuProvider, gpuProviders } from '../src/byoc/providers/index.js';

function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

test('getGpuProvider resolves known providers and rejects unknown ones', () => {
  assert.equal(getGpuProvider('runpod'), runpod);
  assert.equal(getGpuProvider('vastai'), vastai);
  assert.equal(getGpuProvider('lambda'), lambda);
  assert.throws(() => getGpuProvider('nope'), (err) => err instanceof GpuProviderError && err.status === 400);
});

test('every provider declares a computeStyle and an authHint', () => {
  for (const provider of Object.values(gpuProviders)) {
    assert.ok(['container', 'vm'].includes(provider.computeStyle), provider.id);
    assert.equal(typeof provider.authHint, 'string');
    assert.ok(provider.authHint.length > 0, provider.id);
  }
});

// ---------------------------------------------------------------------------
// RunPod (container-style, GraphQL)
// ---------------------------------------------------------------------------

test('runpod.listGpuTypes sends the api key as an Authorization header, never in the URL, and maps GraphQL fields', async () => {
  let requestedUrl;
  let authHeader;
  await withFetch(
    async (url, options) => {
      requestedUrl = url.toString();
      authHeader = options.headers?.authorization;
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      assert.match(body.query, /gpuTypes/);
      return jsonResponse({ data: { gpuTypes: [
        { id: 'NVIDIA GeForce RTX 4090', displayName: 'RTX 4090', memoryInGb: 24, lowestPrice: { uninterruptablePrice: 0.44 } },
        { id: '', displayName: 'bogus' },
      ] } });
    },
    async () => {
      const offers = await runpod.listGpuTypes({ apiKey: 'rp_test' });
      assert.equal(offers.length, 1);
      assert.deepEqual(offers[0], { id: 'NVIDIA GeForce RTX 4090', label: 'RTX 4090', vramGB: 24, priceHourlyUsd: 0.44, region: null });
    }
  );
  // The key must ride in the header and never appear in the request line (logs).
  assert.equal(requestedUrl, 'https://api.runpod.io/graphql');
  assert.equal(authHeader, 'Bearer rp_test');
  assert.doesNotMatch(requestedUrl, /rp_test/);
});

test('runpod.listGpuTypes requires an API key before making a network call', async () => {
  await withFetch(
    () => { throw new Error('must not call fetch without an api key'); },
    async () => {
      await assert.rejects(() => runpod.listGpuTypes({ apiKey: '' }), (err) => err instanceof GpuProviderError && err.status === 400);
    }
  );
});

test('runpod.provision requires an image and returns the pod id', async () => {
  await assert.rejects(
    () => runpod.provision({ apiKey: 'k', gpuTypeId: 'g', name: 'main' }),
    (err) => err instanceof GpuProviderError && /pullable image/.test(err.message)
  );

  let sentInput;
  await withFetch(
    async (url, options) => {
      const body = JSON.parse(options.body);
      sentInput = body.variables.input;
      return jsonResponse({ data: { podFindAndDeployOnDemand: { id: 'pod-123' } } });
    },
    async () => {
      const result = await runpod.provision({
        apiKey: 'k', gpuTypeId: 'NVIDIA GeForce RTX 4090', name: 'main', image: 'ghcr.io/x/sovereignai:v1',
        env: { SOVEREIGN_TOKEN: 'tok' }, diskGB: 30,
      });
      assert.equal(result.instanceId, 'pod-123');
    }
  );
  assert.equal(sentInput.gpuTypeId, 'NVIDIA GeForce RTX 4090');
  assert.equal(sentInput.imageName, 'ghcr.io/x/sovereignai:v1');
  assert.equal(sentInput.containerDiskInGb, 30);
  assert.deepEqual(sentInput.env, [{ key: 'SOVEREIGN_TOKEN', value: 'tok' }]);
});

test('runpod.getInstance reports running only once desiredStatus and a public http port both agree', async () => {
  await withFetch(
    async () => jsonResponse({ data: { pod: {
      id: 'pod-1', desiredStatus: 'RUNNING',
      runtime: { ports: [{ ip: '1.2.3.4', isIpPublic: true, privatePort: 4321, publicPort: 55123 }] },
    } } }),
    async () => {
      const info = await runpod.getInstance({ apiKey: 'k', instanceId: 'pod-1' });
      assert.deepEqual(info, { instanceId: 'pod-1', status: 'running', host: '1.2.3.4', port: 55123 });
    }
  );

  await withFetch(
    async () => jsonResponse({ data: { pod: { id: 'pod-1', desiredStatus: 'PENDING', runtime: null } } }),
    async () => {
      const info = await runpod.getInstance({ apiKey: 'k', instanceId: 'pod-1' });
      assert.equal(info.status, 'pending');
      assert.equal(info.host, null);
    }
  );

  await withFetch(
    async () => jsonResponse({ data: { pod: null } }),
    async () => {
      const info = await runpod.getInstance({ apiKey: 'k', instanceId: 'gone' });
      assert.equal(info.status, 'terminated');
    }
  );
});

test('runpod surfaces a GraphQL error payload as a provider error', async () => {
  await withFetch(
    async () => jsonResponse({ errors: [{ message: 'invalid api key' }] }),
    async () => {
      await assert.rejects(() => runpod.listGpuTypes({ apiKey: 'bad' }), (err) => err instanceof GpuProviderError && /invalid api key/.test(err.message));
    }
  );
});

test('runpod.terminate posts the terminate mutation', async () => {
  let sentQuery;
  await withFetch(
    async (url, options) => { sentQuery = JSON.parse(options.body).query; return jsonResponse({ data: { podTerminate: null } }); },
    async () => {
      const result = await runpod.terminate({ apiKey: 'k', instanceId: 'pod-1' });
      assert.deepEqual(result, { ok: true });
    }
  );
  assert.match(sentQuery, /podTerminate/);
});

// ---------------------------------------------------------------------------
// Vast.ai (container-style, REST)
// ---------------------------------------------------------------------------

test('vastai.listGpuTypes sends bearer auth and maps offers, dropping incomplete ones', async () => {
  let authHeader;
  await withFetch(
    async (url, options) => {
      authHeader = options.headers.authorization;
      assert.ok(url.toString().startsWith('https://console.vast.ai/api/v0/bundles/?q='));
      return jsonResponse({ offers: [
        { id: 555, gpu_name: 'RTX 4090', num_gpus: 1, gpu_ram: 24576, dph_total: 0.35, geolocation: 'US' },
        { id: 556, dph_total: 0.1 }, // no gpu_name -> filtered out
      ] });
    },
    async () => {
      const offers = await vastai.listGpuTypes({ apiKey: 'va_test' });
      assert.equal(offers.length, 1);
      assert.deepEqual(offers[0], { id: '555', label: '1x RTX 4090', vramGB: 24, priceHourlyUsd: 0.35, region: 'US' });
    }
  );
  assert.equal(authHeader, 'Bearer va_test');
});

test('vastai.provision requires an offer id and an image, and posts the env as a docker -e string', async () => {
  await assert.rejects(() => vastai.provision({ apiKey: 'k', name: 'main', image: 'x' }), (err) => /offer id/.test(err.message));
  await assert.rejects(() => vastai.provision({ apiKey: 'k', gpuTypeId: '555', name: 'main' }), (err) => /pullable image/.test(err.message));

  let sentBody;
  let sentPath;
  await withFetch(
    async (url, options) => {
      sentPath = url.toString();
      sentBody = JSON.parse(options.body);
      return jsonResponse({ new_contract: 998877 });
    },
    async () => {
      const result = await vastai.provision({ apiKey: 'k', gpuTypeId: '555', name: 'main', image: 'ghcr.io/x/sovereignai:v1', env: { SOVEREIGN_TOKEN: 'tok' } });
      assert.equal(result.instanceId, '998877');
    }
  );
  assert.ok(sentPath.endsWith('/asks/555/'));
  assert.equal(sentBody.image, 'ghcr.io/x/sovereignai:v1');
  assert.match(sentBody.env, /SOVEREIGN_TOKEN=/);
});

test('vastai.getInstance reads the docker-style port map for the mapped app port', async () => {
  await withFetch(
    async () => jsonResponse({ id: 1, actual_status: 'running', ports: { '4321/tcp': [{ HostIp: '5.6.7.8', HostPort: '61234' }] } }),
    async () => {
      const info = await vastai.getInstance({ apiKey: 'k', instanceId: '1' });
      assert.deepEqual(info, { instanceId: '1', status: 'running', host: '5.6.7.8', port: 61234 });
    }
  );
  await withFetch(
    async () => jsonResponse({ id: 1, actual_status: 'loading', ports: {} }),
    async () => {
      const info = await vastai.getInstance({ apiKey: 'k', instanceId: '1' });
      assert.equal(info.status, 'pending');
    }
  );
});

test('vastai.terminate issues a DELETE against the instance', async () => {
  let method;
  await withFetch(
    async (url, options) => { method = options.method; return jsonResponse({}); },
    async () => assert.deepEqual(await vastai.terminate({ apiKey: 'k', instanceId: '1' }), { ok: true })
  );
  assert.equal(method, 'DELETE');
});

// ---------------------------------------------------------------------------
// Lambda Cloud (vm-style, REST + Basic auth)
// ---------------------------------------------------------------------------

test('lambda uses HTTP Basic auth with the API key as username and empty password', async () => {
  let authHeader;
  await withFetch(
    async (url, options) => { authHeader = options.headers.authorization; return jsonResponse({ data: {} }); },
    async () => { await lambda.listGpuTypes({ apiKey: 'lambda_secret' }); }
  );
  assert.equal(authHeader, `Basic ${Buffer.from('lambda_secret:').toString('base64')}`);
});

test('lambda.listGpuTypes converts price_cents_per_hour to dollars', async () => {
  await withFetch(
    async () => jsonResponse({ data: {
      gpu_1x_a10: { instance_type: { name: 'gpu_1x_a10', description: '1x A10', price_cents_per_hour: 75 }, regions_with_capacity_available: [{ name: 'us-east-1' }] },
    } }),
    async () => {
      const offers = await lambda.listGpuTypes({ apiKey: 'k' });
      assert.deepEqual(offers, [{ id: 'gpu_1x_a10', label: '1x A10', vramGB: null, priceHourlyUsd: 0.75, region: 'us-east-1' }]);
    }
  );
});

test('lambda.ensureSshKey reuses a matching registered key instead of creating a duplicate', async () => {
  let createCalled = false;
  await withFetch(
    async (url, options) => {
      if (options.method === 'POST') { createCalled = true; return jsonResponse({ data: { name: 'new-key' } }); }
      return jsonResponse({ data: [{ name: 'existing-key', public_key: 'ssh-ed25519 AAAA...  comment' }] });
    },
    async () => {
      const { ref } = await lambda.ensureSshKey({ apiKey: 'k', publicKey: 'ssh-ed25519 AAAA...  comment', label: 'sovereignai-lambda-default' });
      assert.equal(ref, 'existing-key');
    }
  );
  assert.equal(createCalled, false);
});

test('lambda.ensureSshKey registers a new key when no match exists', async () => {
  await withFetch(
    async (url, options) => {
      if (options.method === 'POST') {
        const body = JSON.parse(options.body);
        assert.equal(body.public_key, 'ssh-ed25519 BBBB');
        return jsonResponse({ data: { name: 'sovereignai-lambda-default' } });
      }
      return jsonResponse({ data: [] });
    },
    async () => {
      const { ref } = await lambda.ensureSshKey({ apiKey: 'k', publicKey: 'ssh-ed25519 BBBB', label: 'sovereignai-lambda-default' });
      assert.equal(ref, 'sovereignai-lambda-default');
    }
  );
});

test('lambda.provision requires a registered ssh key ref and returns the instance id', async () => {
  await assert.rejects(
    () => lambda.provision({ apiKey: 'k', gpuTypeId: 'gpu_1x_a10', name: 'main' }),
    (err) => /registered SSH key/.test(err.message)
  );

  let sentBody;
  await withFetch(
    async (url, options) => { sentBody = JSON.parse(options.body); return jsonResponse({ data: { instance_ids: ['i-abc'] } }); },
    async () => {
      const result = await lambda.provision({ apiKey: 'k', gpuTypeId: 'gpu_1x_a10', name: 'main', sshKeyRef: 'sovereignai-lambda-default', region: 'us-east-1' });
      assert.equal(result.instanceId, 'i-abc');
    }
  );
  assert.equal(sentBody.instance_type_name, 'gpu_1x_a10');
  assert.deepEqual(sentBody.ssh_key_names, ['sovereignai-lambda-default']);
  assert.equal(sentBody.region_name, 'us-east-1');
});

test('lambda.getInstance reports running only once an IP is assigned, and defaults the ssh user to ubuntu', async () => {
  await withFetch(
    async () => jsonResponse({ data: { id: 'i-abc', status: 'active', ip: '9.8.7.6' } }),
    async () => assert.deepEqual(await lambda.getInstance({ apiKey: 'k', instanceId: 'i-abc' }), { instanceId: 'i-abc', status: 'running', host: '9.8.7.6', sshUser: 'ubuntu' })
  );
  await withFetch(
    async () => jsonResponse({ data: { id: 'i-abc', status: 'booting', ip: null } }),
    async () => assert.equal((await lambda.getInstance({ apiKey: 'k', instanceId: 'i-abc' })).status, 'pending')
  );
});

test('lambda.terminate posts instance_ids', async () => {
  let sentBody;
  await withFetch(
    async (url, options) => { sentBody = JSON.parse(options.body); return jsonResponse({}); },
    async () => assert.deepEqual(await lambda.terminate({ apiKey: 'k', instanceId: 'i-abc' }), { ok: true })
  );
  assert.deepEqual(sentBody.instance_ids, ['i-abc']);
});

// ---------------------------------------------------------------------------
// Shared error handling (exercised through one provider, but the code path is shared)
// ---------------------------------------------------------------------------

test('an HTTP error response becomes a GpuProviderError with the provider-reported detail', async () => {
  await withFetch(
    async () => jsonResponse({ message: 'Insufficient balance' }, 402),
    async () => {
      await assert.rejects(
        () => lambda.terminate({ apiKey: 'k', instanceId: 'i-abc' }),
        (err) => err instanceof GpuProviderError && /Insufficient balance/.test(err.message)
      );
    }
  );
});

test('a network failure is wrapped, never thrown raw', async () => {
  await withFetch(
    async () => { throw new Error('getaddrinfo ENOTFOUND'); },
    async () => {
      await assert.rejects(
        () => vastai.listGpuTypes({ apiKey: 'k' }),
        (err) => err instanceof GpuProviderError && /Could not reach Vast\.ai/.test(err.message)
      );
    }
  );
});
