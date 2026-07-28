/**
 * Vast.ai GPU marketplace client — "container-style", same reasoning as
 * runpod.js: a Vast.ai "instance" is a Docker container running on a peer
 * host, not a VM we can `docker build`/`docker run` inside over SSH. We ask
 * Vast.ai to run a pinned, pullable SovereignAI image directly. See
 * gpu-provision.js `provisionContainer`.
 *
 * ============================================================================
 * UNVERIFIED AGAINST LIVE INFRASTRUCTURE. Built from Vast.ai's documented
 * REST API shape as known at model training time (cutoff ~January 2026),
 * with no Vast.ai account available to exercise it against. Before trusting
 * this for a real deployment: create a fresh Vast.ai account, try
 * `sovereign byoc gpu list vastai` and a deploy with the cheapest offer, and
 * watch the Vast.ai console the whole time. If it fails, check first:
 *   - Auth: this sends `Authorization: Bearer <key>`. Some Vast.ai docs
 *     instead show an `api_key` query parameter — if requests 401, try that.
 *   - The offer search endpoint (`GET /bundles/`) and its query-object shape,
 *     and the instance-create endpoint (`PUT /asks/{id}/`) and its body
 *     fields (image, disk, env, runtype, label) are the parts most likely to
 *     have drifted — Vast.ai's API has changed shape before.
 *   - `instances/{id}/`'s `ports` field (Docker-style port-map JSON) is how
 *     this code finds the externally reachable address; if that shape is
 *     off, getInstance will report "pending" forever instead of failing
 *     loudly — check the instance's actual state in the Vast.ai console if a
 *     deploy seems stuck.
 * ============================================================================
 */

import { GpuProviderError, requireApiKey, fetchJson, instanceLabel } from './shared.js';

const BASE = 'https://console.vast.ai/api/v0';

function vastFetch(apiKey, method, path, body) {
  return fetchJson(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${requireApiKey(apiKey, 'Vast.ai')}` },
    body,
    providerLabel: 'Vast.ai',
  });
}

export const vastai = {
  id: 'vastai',
  label: 'Vast.ai',
  computeStyle: 'container',
  authHint: 'API key from cloud.vast.ai → Account → API Keys.',

  async listGpuTypes({ apiKey }) {
    const query = JSON.stringify({ rentable: { eq: true }, order: [['dph_total', 'asc']] });
    const data = await vastFetch(apiKey, 'GET', `/bundles/?q=${encodeURIComponent(query)}`);
    const offers = Array.isArray(data?.offers) ? data.offers : [];
    return offers
      .slice(0, 50)
      .map((o) => ({
        id: o?.id !== undefined ? String(o.id) : null,
        label: o?.gpu_name ? `${o.num_gpus ?? 1}x ${o.gpu_name}` : null,
        vramGB: Number.isFinite(o?.gpu_ram) ? Math.round(o.gpu_ram / 1024) : null,
        priceHourlyUsd: Number.isFinite(o?.dph_total) ? o.dph_total : null,
        region: typeof o?.geolocation === 'string' ? o.geolocation : null,
      }))
      .filter((o) => o.id && o.label);
  },

  async provision({ apiKey, gpuTypeId, name, image, env = {}, diskGB = 20 }) {
    if (!gpuTypeId) throw new GpuProviderError('Vast.ai needs an offer id (see "sovereign byoc gpu list vastai")', { status: 400 });
    if (!image) throw new GpuProviderError('Vast.ai needs a pullable image: pass --image <ref>', { status: 400 });
    const envString = Object.entries(env)
      .map(([key, value]) => `-e ${key}=${JSON.stringify(String(value))}`)
      .join(' ');
    const data = await vastFetch(apiKey, 'PUT', `/asks/${encodeURIComponent(gpuTypeId)}/`, {
      client_id: 'me',
      image,
      disk: diskGB,
      env: envString,
      runtype: 'ssh', // keep the container running as a service rather than exiting like a batch job
      label: instanceLabel(name),
    });
    const instanceId = data?.new_contract ?? data?.new_contract_id;
    if (instanceId === undefined || instanceId === null) {
      throw new GpuProviderError('Vast.ai did not return an instance id', { status: 502 });
    }
    return { instanceId: String(instanceId) };
  },

  async getInstance({ apiKey, instanceId }) {
    const data = await vastFetch(apiKey, 'GET', `/instances/${encodeURIComponent(instanceId)}/`);
    const inst = data?.instances ?? data;
    if (!inst || inst.id === undefined || inst.id === null) {
      return { instanceId, status: 'terminated', host: null, port: null };
    }
    const mapped = inst.ports?.['4321/tcp']?.[0];
    let status = 'pending';
    if (inst.actual_status === 'running' && mapped) status = 'running';
    else if (inst.actual_status === 'exited') status = 'terminated';
    return {
      instanceId: String(inst.id),
      status,
      host: mapped?.HostIp ?? (typeof inst.public_ipaddr === 'string' ? inst.public_ipaddr : null),
      port: mapped?.HostPort ? Number(mapped.HostPort) : null,
    };
  },

  async terminate({ apiKey, instanceId }) {
    await vastFetch(apiKey, 'DELETE', `/instances/${encodeURIComponent(instanceId)}/`);
    return { ok: true };
  },
};
