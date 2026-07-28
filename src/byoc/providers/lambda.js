/**
 * Lambda Cloud GPU marketplace client — "vm-style": a Lambda instance is a
 * real box with a normal Docker daemon, the same shape rail #1 already
 * assumes. So unlike runpod.js/vastai.js, this provider only handles
 * provisioning and SSH-key registration; once the instance is reachable,
 * gpu-provision.js hands off to the EXISTING SSH deploy pipeline
 * (connector.js `deploy`) completely unchanged — same `docker build`/`docker
 * run` on the host, same token-generated-on-the-host trust model as a
 * manually-owned box.
 *
 * ============================================================================
 * UNVERIFIED AGAINST LIVE INFRASTRUCTURE. Built from Lambda Cloud's
 * documented REST API shape as known at model training time (cutoff ~January
 * 2026), with no Lambda account available to exercise it against. Before
 * trusting this for a real deployment: create a fresh Lambda Cloud account,
 * try `sovereign byoc gpu list lambda` and a deploy with the cheapest
 * instance type, and watch the Lambda console the whole time. If it fails,
 * check first:
 *   - Auth: this sends HTTP Basic auth with the API key as the username and
 *     an empty password. If that 401s, Lambda may now expect
 *     `Authorization: Bearer <key>` instead.
 *   - `/instance-operations/launch`'s body fields (region_name,
 *     instance_type_name, ssh_key_names, quantity, name) and
 *     `/instance-types`'s response shape (price_cents_per_hour, per-region
 *     capacity) are the parts most likely to have drifted.
 *   - The default SSH user is assumed to be "ubuntu" (Lambda's stock image
 *     default) — if their default image changes, connections will fail at
 *     the handoff to the SSH deploy pipeline with a clear SSH-level error,
 *     not a silent one.
 * ============================================================================
 */

import { GpuProviderError, requireApiKey, fetchJson, instanceLabel } from './shared.js';

const BASE = 'https://cloud.lambdalabs.com/api/v1';

function lambdaFetch(apiKey, method, path, body) {
  const key = requireApiKey(apiKey, 'Lambda Cloud');
  return fetchJson(`${BASE}${path}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body,
    providerLabel: 'Lambda Cloud',
  });
}

export const lambda = {
  id: 'lambda',
  label: 'Lambda Cloud',
  computeStyle: 'vm',
  authHint: 'API key from cloud.lambdalabs.com → API keys.',

  async listGpuTypes({ apiKey }) {
    const data = await lambdaFetch(apiKey, 'GET', '/instance-types');
    const entries = Object.values(data?.data ?? {});
    return entries
      .map((entry) => ({
        id: entry?.instance_type?.name ?? null,
        label: entry?.instance_type?.description ?? entry?.instance_type?.name ?? null,
        vramGB: null, // not broken out per-GPU in this endpoint's response
        priceHourlyUsd: Number.isFinite(entry?.instance_type?.price_cents_per_hour)
          ? entry.instance_type.price_cents_per_hour / 100
          : null,
        region: entry?.regions_with_capacity_available?.[0]?.name ?? null,
      }))
      .filter((t) => t.id);
  },

  /** VM-style only: Lambda requires the SSH public key pre-registered under a name before launch. */
  async ensureSshKey({ apiKey, publicKey, label }) {
    const existing = await lambdaFetch(apiKey, 'GET', '/ssh-keys');
    const match = (existing?.data ?? []).find((k) => typeof k?.public_key === 'string' && k.public_key.trim() === publicKey.trim());
    if (match) return { ref: match.name };
    const created = await lambdaFetch(apiKey, 'POST', '/ssh-keys', { name: label, public_key: publicKey });
    if (!created?.data?.name) throw new GpuProviderError('Lambda Cloud did not confirm the SSH key registration', { status: 502 });
    return { ref: created.data.name };
  },

  async provision({ apiKey, gpuTypeId, name, sshKeyRef, region }) {
    if (!gpuTypeId) throw new GpuProviderError('Lambda Cloud needs an instance type (see "sovereign byoc gpu list lambda")', { status: 400 });
    if (!sshKeyRef) throw new GpuProviderError('Lambda Cloud requires a registered SSH key (internal: ensureSshKey was not called)', { status: 400 });
    const data = await lambdaFetch(apiKey, 'POST', '/instance-operations/launch', {
      ...(region ? { region_name: region } : {}),
      instance_type_name: gpuTypeId,
      ssh_key_names: [sshKeyRef],
      quantity: 1,
      name: instanceLabel(name),
    });
    const instanceId = data?.data?.instance_ids?.[0];
    if (!instanceId) throw new GpuProviderError('Lambda Cloud did not return an instance id', { status: 502 });
    return { instanceId };
  },

  async getInstance({ apiKey, instanceId }) {
    const data = await lambdaFetch(apiKey, 'GET', `/instances/${encodeURIComponent(instanceId)}`);
    const inst = data?.data;
    if (!inst) return { instanceId, status: 'terminated', host: null, sshUser: null };
    let status = 'pending';
    if (inst.status === 'active' && inst.ip) status = 'running';
    else if (inst.status === 'terminated' || inst.status === 'terminating') status = 'terminated';
    else if (inst.status === 'unhealthy') status = 'error';
    return { instanceId: inst.id, status, host: typeof inst.ip === 'string' ? inst.ip : null, sshUser: 'ubuntu' };
  },

  async terminate({ apiKey, instanceId }) {
    await lambdaFetch(apiKey, 'POST', '/instance-operations/terminate', { instance_ids: [instanceId] });
    return { ok: true };
  },
};
