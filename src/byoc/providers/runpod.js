/**
 * RunPod GPU marketplace client — "container-style": a RunPod pod IS a
 * Docker container, not a VM with a Docker daemon inside it. So unlike rail
 * #1 (SSH in, `docker build`/`docker run` on a host we own), we ask RunPod to
 * run a pinned, pullable SovereignAI image directly and reach it over its
 * mapped HTTP port. See gpu-provision.js `provisionContainer`.
 *
 * ============================================================================
 * UNVERIFIED AGAINST LIVE INFRASTRUCTURE. Built from RunPod's documented
 * GraphQL API shape as known at model training time (cutoff ~January 2026),
 * with no RunPod account available to exercise it against. Before trusting
 * this for a real deployment: create a fresh RunPod account, try `sovereign
 * byoc gpu list runpod` and a deploy with the cheapest GPU type, and watch
 * the RunPod console the whole time. If it fails, check first:
 *   - Auth: this sends `api_key` as a URL query parameter on the GraphQL
 *     endpoint. RunPod has also published a newer REST API
 *     (rest.runpod.io) using `Authorization: Bearer` — if query-param auth
 *     now 401s, that's the most likely reason.
 *   - `podFindAndDeployOnDemand` input field names (gpuTypeId, imageName,
 *     containerDiskInGb, ports, env) and the `ports` syntax
 *     ("4321/http") may have changed.
 *   - `runtime.ports[].isIpPublic`/`publicPort` is how this code finds the
 *     externally reachable address; if RunPod changed that shape, getInstance
 *     will report "pending" forever instead of failing loudly — check the
 *     pod's actual state in the RunPod console if a deploy seems stuck.
 * ============================================================================
 */

import { GpuProviderError, requireApiKey, fetchJson, instanceLabel } from './shared.js';

const GRAPHQL_URL = 'https://api.runpod.io/graphql';

async function graphql(apiKey, query, variables) {
  // Send the key as a header, never in the URL query string, so it cannot
  // land in proxy/CDN/access logs. RunPod's GraphQL endpoint accepts Bearer
  // auth (same key as the documented REST API).
  const data = await fetchJson(GRAPHQL_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${requireApiKey(apiKey, 'RunPod')}` },
    body: { query, variables },
    providerLabel: 'RunPod',
  });
  if (Array.isArray(data?.errors) && data.errors.length) {
    throw new GpuProviderError(`RunPod error: ${data.errors[0]?.message ?? 'unknown GraphQL error'}`, { status: 502 });
  }
  return data?.data;
}

export const runpod = {
  id: 'runpod',
  label: 'RunPod',
  computeStyle: 'container',
  authHint: 'API key from the RunPod console: Settings → API Keys (console.runpod.io/user/settings).',

  async listGpuTypes({ apiKey }) {
    const data = await graphql(
      apiKey,
      `query {
        gpuTypes {
          id
          displayName
          memoryInGb
          lowestPrice(input: { gpuCount: 1 }) { uninterruptablePrice }
        }
      }`
    );
    const types = Array.isArray(data?.gpuTypes) ? data.gpuTypes : [];
    return types
      .map((t) => ({
        id: t?.id,
        label: t?.displayName ?? t?.id,
        vramGB: Number.isFinite(t?.memoryInGb) ? t.memoryInGb : null,
        priceHourlyUsd: Number.isFinite(t?.lowestPrice?.uninterruptablePrice) ? t.lowestPrice.uninterruptablePrice : null,
        region: null,
      }))
      .filter((t) => t.id);
  },

  // `port` (default 4321) is the container port the service listens on;
  // `args` (optional) become the image's CMD via RunPod's `dockerArgs` —
  // used by the serve rail to pass `--model …` to vLLM. Drift note: the
  // `dockerArgs` input field name is part of the unverified API surface above.
  async provision({ apiKey, gpuTypeId, name, image, env = {}, diskGB = 20, port = 4321, args = [] }) {
    if (!gpuTypeId) throw new GpuProviderError('RunPod needs a gpuTypeId (see "sovereign byoc gpu list runpod")', { status: 400 });
    if (!image) throw new GpuProviderError('RunPod needs a pullable image: pass --image <ref>', { status: 400 });
    const input = {
      cloudType: 'ALL',
      gpuTypeId,
      gpuCount: 1,
      name: instanceLabel(name),
      imageName: image,
      containerDiskInGb: diskGB,
      ports: `${port}/http`,
      env: Object.entries(env).map(([key, value]) => ({ key, value: String(value) })),
    };
    if (args.length) input.dockerArgs = args.join(' ');
    const data = await graphql(
      apiKey,
      `mutation Deploy($input: PodFindAndDeployOnDemandInput!) {
        podFindAndDeployOnDemand(input: $input) { id }
      }`,
      { input }
    );
    const podId = data?.podFindAndDeployOnDemand?.id;
    if (!podId) throw new GpuProviderError('RunPod did not return a pod id', { status: 502 });
    return { instanceId: podId };
  },

  async getInstance({ apiKey, instanceId, port = 4321 }) {
    const data = await graphql(
      apiKey,
      `query Pod($id: String!) {
        pod(input: { podId: $id }) {
          id
          desiredStatus
          runtime { ports { ip isIpPublic privatePort publicPort } }
        }
      }`,
      { id: instanceId }
    );
    const pod = data?.pod;
    if (!pod?.id) return { instanceId, status: 'terminated', host: null, port: null };
    const httpPort = (pod.runtime?.ports ?? []).find((p) => Number(p?.privatePort) === port && p?.isIpPublic);
    let status = 'pending';
    if (pod.desiredStatus === 'RUNNING' && httpPort) status = 'running';
    else if (pod.desiredStatus === 'EXITED' || pod.desiredStatus === 'TERMINATED') status = 'terminated';
    return {
      instanceId: pod.id,
      status,
      host: httpPort?.ip ?? null,
      port: httpPort ? Number(httpPort.publicPort) : null,
    };
  },

  async terminate({ apiKey, instanceId }) {
    await graphql(apiKey, `mutation Terminate($id: String!) { podTerminate(input: { podId: $id }) }`, { id: instanceId });
    return { ok: true };
  },
};
