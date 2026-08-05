import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createSshRunner, pinnedHostKeyFingerprint, parseSshTarget } from './ssh.js';
import { knownHostsPath, openRegistry } from './registry.js';
import {
  ByocError,
  checkHealth,
  deploy,
  deployPlan,
  destroyInstance,
  exportInstance,
  resumeInstance,
  sourceArchive,
  suspendInstance,
  upgradeInstance,
} from './connector.js';
import { gpuProviders, getGpuProvider } from './providers/index.js';
import { provisionContainer, provisionServeContainer, provisionVm, DEFAULT_SERVE_IMAGE } from './gpu-provision.js';
import { loadConfig, saveConfig, scrubPersistedEnvironmentSecrets } from '../config.js';

export const BYOC_HELP = `sovereign byoc — deploy SovereignAI to a Docker host you own, over SSH

Your box (a VPS, a homelab, on-prem — anything with SSH and Docker), your
data. The control plane keeps connection metadata and health only: an SSH
target, a token HASH, a version. Revoke its key on the host and its access
ends completely.

Usage: sovereign byoc <action> [args]

Actions:
  deploy    --host user@host [options]   Provision a new instance (shows the
                                         full plan; add --yes to apply)
  list                                   Show registered instances
  status <name>                          Live health check (updates registry)
  upgrade <name> [--image ref]           Deploy a new version; auto-rollback
                                         to the previous one on failed health
  export <name> [file]                   Stream a full data export to THIS
                                         machine (the exit path, always open)
  suspend <name> / resume <name>         Stop / start the container
  destroy <name> --yes [--purge-data]    Remove the instance; data volume is
                                         kept unless --purge-data. The result
                                         is re-inspected and shown. If the
                                         instance was rented via "gpu deploy",
                                         this also terminates it (stops
                                         billing) unless --keep-cloud-instance.
  gpu <action>                           Rent a GPU instance from a
                                         marketplace instead of bringing your
                                         own box. Run "sovereign byoc gpu
                                         help" for details — UNVERIFIED
                                         against live infrastructure, test
                                         with the cheapest GPU type first.

Deploy options:
  --host user@host   SSH target (required)
  --key file         SSH private key (default: your ssh config/agent)
  --ssh-port N       SSH port (default 22)
  --name x           Instance name (default "main")
  --port N           App port on the host (default 4321)
  --bind MODE        loopback (default; reach via SSH tunnel or your reverse
                     proxy) or lan (0.0.0.0, token-protected — TLS is on you)
  --image ref        Pull this image instead of building your committed
                     source on the host (the default, which needs a git
                     checkout of SovereignAI)
  --env K=V          Extra instance env (repeatable), e.g. provider endpoints
  --yes              Apply without prompting
`;

export const GPU_HELP = `sovereign byoc gpu — rent a GPU instance and deploy onto it (rail 1.5)

UNVERIFIED against live provider infrastructure — built from each
provider's documented API, with no account available to test against. See
the warning at the top of src/byoc/providers/<provider>.js before trusting
this for a real deployment. Try the cheapest GPU type first and watch the
provider's own console.

Providers: runpod, vastai (container-style: run a pulled image directly, no
SSH) · lambda (vm-style: a real box, deploys over SSH like rail #1).

Usage: sovereign byoc gpu <action> [args]

Actions:
  list <provider> [--api-key key]              Show GPU offers and hourly
                                               pricing (read-only, no cost)
  deploy <provider> --gpu-type id [options]    Rent an instance and deploy
                                               (shows the full plan and
                                               estimated cost; add --yes to
                                               apply — THIS COSTS MONEY)
  serve <provider> --gpu-type id --model <huggingface-id> [options]
                                               Rent a GPU that runs an
                                               OpenAI-compatible inference
                                               server (vLLM) with the open
                                               weights you choose — for
                                               models too big for your own
                                               box. container-style
                                               providers only. THIS COSTS
                                               MONEY while it runs.

Deploy options:
  --gpu-type id      GPU type/offer id from "gpu list" (required)
  --name x           Instance name (default "main")
  --api-key key       Provider API key (default: env var, e.g. RUNPOD_API_KEY)
  --image ref        Pullable image (required for runpod/vastai; optional
                     for lambda, which can build your committed source
                     instead, same as rail #1)
  --region x         Region hint (lambda only; providers vary in support)
  --disk-gb N        Container/instance disk size (default 20)
  --port N           App port on the host (lambda only; default 4321)
  --bind MODE        loopback or lan (lambda only; default loopback)
  --env K=V          Extra instance env (lambda only, repeatable)
  --yes              Apply without prompting (starts billing)

Destroy a GPU-provisioned instance the same way as any other:
  sovereign byoc destroy <name> --api-key key
`;

export async function runByoc(rootDir, argv) {
  const [action = 'help', ...rest] = argv;
  switch (action) {
    case 'deploy':
      return deployCommand(rootDir, rest);
    case 'list':
      return listCommand(rootDir, rest);
    case 'status':
      return statusCommand(rootDir, rest);
    case 'upgrade':
      return upgradeCommand(rootDir, rest);
    case 'export':
      return exportCommand(rootDir, rest);
    case 'suspend':
      return suspendCommand(rootDir, rest);
    case 'resume':
      return resumeCommand(rootDir, rest);
    case 'destroy':
      return destroyCommand(rootDir, rest);
    case 'gpu':
      return gpuCommand(rootDir, rest);
    case 'help':
    case '--help':
    case '-h':
      console.log(BYOC_HELP);
      return;
    default:
      throw new ByocError(`Unknown byoc action: ${action}\nRun "sovereign byoc help" for usage.`);
  }
}

function parseFlags(argv, spec, { positionals = 0 } = {}) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      flags._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const known = spec[name];
    if (!known) throw new ByocError(`Unknown option --${name}\nRun "sovereign byoc help" for usage.`);
    if (known === 'boolean') {
      if (eq !== -1) throw new ByocError(`--${name} does not take a value`);
      flags[name] = true;
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || (eq === -1 && value.startsWith('--'))) throw new ByocError(`--${name} requires a value`);
    if (known === 'repeat') (flags[name] ??= []).push(value);
    else if (name in flags) throw new ByocError(`Option --${name} may only be provided once`);
    else flags[name] = value;
  }
  if (flags._.length > positionals) throw new ByocError(`Unexpected argument: ${flags._[positionals]}`);
  return flags;
}

function parsePortFlag(value, label, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new ByocError(`Invalid ${label} "${value}": expected an integer from 1 to 65535`);
  }
  return Number(value);
}

async function deployCommand(rootDir, argv) {
  const flags = parseFlags(argv, {
    host: 'value', key: 'value', 'ssh-port': 'value', name: 'value', port: 'value',
    bind: 'value', image: 'value', env: 'repeat', yes: 'boolean',
  });
  if (!flags.host) throw new ByocError('deploy requires --host user@host\nRun "sovereign byoc help" for usage.');
  parseSshTarget(flags.host);
  if (flags.key && !fs.existsSync(flags.key)) throw new ByocError(`SSH key not found: ${flags.key}`);

  const name = flags.name ?? 'main';
  const port = parsePortFlag(flags.port, '--port', 4321);
  const sshPort = parsePortFlag(flags['ssh-port'], '--ssh-port', 22);
  const bind = flags.bind ?? 'loopback';
  const env = {};
  for (const pair of flags.env ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new ByocError(`Invalid --env "${pair}": expected KEY=value`);
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const image = flags.image ? { mode: 'pull', ref: flags.image } : { mode: 'source' };
  const archive = image.mode === 'source' ? sourceArchive() : null;

  console.log(`\nDeployment plan\n${'-'.repeat(15)}`);
  console.log(deployPlan({ name, target: flags.host, port, bind, image, envKeys: Object.keys(env) }));
  console.log('');

  if (!flags.yes) {
    if (!(await confirm('Deploy this instance? (y/N) '))) {
      console.log('Nothing was deployed. Re-run with --yes to apply this plan.');
      return;
    }
  }

  const runner = createSshRunner({
    target: flags.host,
    sshPort,
    keyPath: flags.key ?? null,
    knownHostsFile: knownHostsPath(rootDir),
    strictHostKey: false, // first contact pins the host key; every later session requires it
  });

  const { record, handoff } = await deploy({
    rootDir, runner, name, port, bind, image, env, archive,
    fingerprint: () => pinnedHostKeyFingerprint({ host: runner.host, sshPort, knownHostsFile: knownHostsPath(rootDir) }),
    log: console.log,
  });

  console.log(`
  ⬡ ${record.name} is live on ${runner.describe()} — SovereignAI v${record.app.version}
    Host key   ${record.hostKeyFingerprint ?? '(fingerprint unavailable; see byoc/known_hosts)'}
${handoff.tunnel ? `    Tunnel     ${handoff.tunnel}\n` : ''}    Web UI     ${handoff.url}
    ${handoff.note}

    The token above is shown once and is not stored here (only its hash is).
    ${handoff.revoke}
`);
}

async function gpuCommand(rootDir, argv) {
  const [sub = 'help', ...rest] = argv;
  switch (sub) {
    case 'list':
      return gpuListCommand(rest);
    case 'deploy':
      return gpuDeployCommand(rootDir, rest);
    case 'serve':
      return gpuServeCommand(rootDir, rest);
    case 'help':
    case '--help':
    case '-h':
      console.log(GPU_HELP);
      return;
    default:
      throw new ByocError(`Unknown byoc gpu action: ${sub}\nRun "sovereign byoc gpu help" for usage.`);
  }
}

/**
 * The serve rail: rent a GPU running vLLM with chosen open weights, then
 * hand the operator (or --wire directly into config) an OpenAI-compatible
 * endpoint. The weights' license is between the operator and the publisher —
 * the plan says so instead of pretending "open weights" means "no terms".
 */
async function gpuServeCommand(rootDir, argv) {
  const flags = parseFlags(
    argv,
    {
      'gpu-type': 'value', name: 'value', model: 'value', image: 'value', 'api-key': 'value',
      'disk-gb': 'value', 'vllm-arg': 'repeat', 'hf-token-env': 'value', wire: 'boolean', yes: 'boolean',
    },
    { positionals: 1 }
  );
  const providerId = flags._[0];
  if (!providerId) throw new ByocError(`gpu serve requires a provider: ${Object.keys(gpuProviders).join(', ')}\nRun "sovereign byoc gpu help" for usage.`);
  const provider = getGpuProvider(providerId);
  if (!flags['gpu-type']) throw new ByocError(`gpu serve requires --gpu-type <id>. See "sovereign byoc gpu list ${providerId}".`);
  if (!flags.model) throw new ByocError('gpu serve requires --model <huggingface-id>, e.g. --model Qwen/Qwen3-32B');
  const apiKey = flags['api-key'] ?? process.env[apiKeyEnvVar(providerId)];
  if (!apiKey) throw new ByocError(`gpu serve needs an API key: pass --api-key or set ${apiKeyEnvVar(providerId)}\n${provider.authHint}`);

  const name = flags.name ?? 'serve';
  if (openRegistry(rootDir).get(name)) {
    throw new ByocError(`Instance "${name}" already exists in the registry. Use another --name, or destroy it first.`);
  }
  const diskGB = flags['disk-gb'] !== undefined ? Number(flags['disk-gb']) : 60;
  if (!Number.isInteger(diskGB) || diskGB < 1) throw new ByocError(`Invalid --disk-gb "${flags['disk-gb']}"`);
  const image = flags.image ?? DEFAULT_SERVE_IMAGE;
  const hfTokenEnv = flags['hf-token-env'];
  const hfToken = hfTokenEnv ? process.env[hfTokenEnv] : undefined;
  if (hfTokenEnv && !hfToken) throw new ByocError(`--hf-token-env ${hfTokenEnv}: that environment variable is empty.`);

  console.log(`\nGPU serve plan\n${'-'.repeat(20)}`);
  console.log(`Provider   ${provider.label} (container-style — runs the inference image directly, no SSH)`);
  console.log(`GPU type   ${flags['gpu-type']}`);
  console.log(`Instance   ${name} (role: inference)`);
  console.log(`Image      pull ${image}`);
  console.log(`Weights    ${flags.model} — pulled by the instance straight from Hugging Face on first boot. Their license is between you and the model's publisher; open weights are not automatically open license.`);
  console.log('Secrets    The inference API key is generated by THIS CLI and sent to the provider as instance env (no SSH access to generate it host-side). Only its hash is stored locally. Same disclosed trade-off as container-style deploy.');
  console.log(`Billing    starts the moment ${provider.label} accepts this request and CONTINUES UNTIL DESTROYED — big weights can take many minutes to download before the endpoint is usable. "sovereign byoc destroy ${name}" terminates it.`);
  console.log(`\nTHIS IS UNVERIFIED against live ${provider.label} infrastructure — see the warning at the top of src/byoc/providers/${providerId}.js. Use the cheapest workable GPU type for a first try.\n`);

  if (!flags.yes) {
    if (!(await confirm(`Provision on ${provider.label} and serve ${flags.model}? This will start billing. (y/N) `))) {
      console.log('Nothing was provisioned.');
      return;
    }
  }

  const result = await provisionServeContainer({
    providerId, apiKey, gpuTypeId: flags['gpu-type'], name,
    model: flags.model, image, extraArgs: flags['vllm-arg'] ?? [], hfToken, diskGB, log: console.log,
  });

  const record = openRegistry(rootDir).save({
    name,
    createdAt: new Date().toISOString(),
    computeStyle: 'container',
    role: 'inference',
    provider: result.provider,
    host: result.host,
    port: result.port,
    servicePort: 8000,
    model: result.model,
    apiKeySha256: result.apiKeySha256,
    status: 'running',
    lastHealth: { at: new Date().toISOString(), ok: true },
  });

  const baseUrl = `http://${result.host}:${result.port}`;
  let wired = false;
  if (flags.wire) {
    const persisted = scrubPersistedEnvironmentSecrets(loadConfig(rootDir, { env: {} }), process.env);
    if (persisted.providers.openai?.enabled && persisted.providers.openai.baseUrl && persisted.providers.openai.baseUrl !== baseUrl) {
      console.log(`  --wire skipped: the OpenAI-compatible provider is already enabled at ${persisted.providers.openai.baseUrl}. Wire it manually in Settings if you want to switch.`);
    } else {
      persisted.providers.openai = { ...persisted.providers.openai, enabled: true, baseUrl, apiKey: result.apiKey };
      saveConfig(rootDir, persisted);
      wired = true;
    }
  }

  console.log(`
  ⬡ ${record.name} is serving ${result.model} on ${provider.label} (instance ${result.provider.instanceId})
    Endpoint   ${baseUrl}  (OpenAI-compatible; server reports: ${result.models.join(', ')})
    API key    ${result.apiKey}
               Shown once — only its hash is stored. ${provider.label} maps this port to the internet: the key is the only thing protecting the endpoint. Put TLS in front before sharing it.
    ${wired
      ? `Wired      providers.openai now points at this endpoint. Pick "${result.models[0]}" as a model in Settings or on a persona.`
      : `Wire it    Settings → OpenAI-compatible: baseUrl ${baseUrl}, API key above — or re-run with --wire.`}
    Billing    runs until: sovereign byoc destroy ${record.name} --api-key <key>
`);
}

async function gpuListCommand(argv) {
  const flags = parseFlags(argv, { 'api-key': 'value' }, { positionals: 1 });
  const providerId = flags._[0];
  if (!providerId) throw new ByocError(`gpu list requires a provider: ${Object.keys(gpuProviders).join(', ')}\nRun "sovereign byoc gpu help" for usage.`);
  const provider = getGpuProvider(providerId);
  const apiKey = flags['api-key'] ?? process.env[apiKeyEnvVar(providerId)];
  if (!apiKey) throw new ByocError(`gpu list needs an API key: pass --api-key or set ${apiKeyEnvVar(providerId)}\n${provider.authHint}`);

  const offers = await provider.listGpuTypes({ apiKey });
  if (!offers.length) {
    console.log(`  ${provider.label} returned no GPU offers.`);
    return;
  }
  console.log(`\n${provider.label} GPU offers (UNVERIFIED against live infra — see src/byoc/providers/${providerId}.js)\n`);
  for (const offer of offers) {
    const price = offer.priceHourlyUsd != null ? `$${offer.priceHourlyUsd.toFixed(2)}/hr` : 'price unknown';
    const vram = offer.vramGB != null ? `${offer.vramGB} GB VRAM` : '';
    const region = offer.region ? ` (${offer.region})` : '';
    console.log(`  ${String(offer.id).padEnd(24)} ${String(offer.label ?? '').padEnd(28)} ${price.padEnd(12)} ${vram}${region}`);
  }
}

async function gpuDeployCommand(rootDir, argv) {
  const flags = parseFlags(
    argv,
    {
      'gpu-type': 'value', name: 'value', image: 'value', region: 'value', 'api-key': 'value',
      'disk-gb': 'value', port: 'value', bind: 'value', env: 'repeat', yes: 'boolean',
    },
    { positionals: 1 }
  );
  const providerId = flags._[0];
  if (!providerId) throw new ByocError(`gpu deploy requires a provider: ${Object.keys(gpuProviders).join(', ')}\nRun "sovereign byoc gpu help" for usage.`);
  const provider = getGpuProvider(providerId);
  if (!flags['gpu-type']) throw new ByocError(`gpu deploy requires --gpu-type <id>. See "sovereign byoc gpu list ${providerId}".`);
  const apiKey = flags['api-key'] ?? process.env[apiKeyEnvVar(providerId)];
  if (!apiKey) throw new ByocError(`gpu deploy needs an API key: pass --api-key or set ${apiKeyEnvVar(providerId)}\n${provider.authHint}`);

  const name = flags.name ?? 'main';
  if (openRegistry(rootDir).get(name)) {
    throw new ByocError(`Instance "${name}" already exists in the registry. Use another --name, or destroy it first.`);
  }
  const diskGB = flags['disk-gb'] !== undefined ? Number(flags['disk-gb']) : 20;
  if (!Number.isInteger(diskGB) || diskGB < 1) throw new ByocError(`Invalid --disk-gb "${flags['disk-gb']}"`);
  if (provider.computeStyle === 'container' && !flags.image) {
    throw new ByocError(`${provider.label} needs a pullable image: pass --image <ref>. Rail 1.5 does not build or push images for you.`);
  }

  console.log(`\nGPU deployment plan\n${'-'.repeat(20)}`);
  console.log(`Provider   ${provider.label} (${provider.computeStyle}-style — ${provider.computeStyle === 'container' ? 'runs a pulled image directly, no SSH' : 'a real box; deploys over SSH like rail #1'})`);
  console.log(`GPU type   ${flags['gpu-type']}${flags.region ? ` in ${flags.region}` : ''}`);
  console.log(`Instance   ${name}`);
  const image = flags.image ? { mode: 'pull', ref: flags.image } : { mode: 'source' };
  if (provider.computeStyle === 'container') {
    console.log(`Image      pull ${flags.image}`);
    console.log('Secrets    SOVEREIGN_TOKEN is generated by THIS CLI and sent to the provider as instance env — unlike rail #1, it is not generated on a host we control, because there is no SSH access to a container-style instance. See docs/BYOC_SSH_CONNECTOR.md.');
  } else {
    console.log(`Image      ${image.mode === 'pull' ? `pull ${image.ref}` : 'build on the host from your committed source (git archive HEAD), same as rail #1'}`);
    console.log('Secrets    SOVEREIGN_TOKEN generated ON the host, same trust model as rail #1.');
  }
  console.log(`Billing    starts the moment ${provider.label} accepts this request. "sovereign byoc destroy ${name}" will terminate the cloud instance too — this is not just a local record.`);
  console.log(`\nTHIS IS UNVERIFIED against live ${provider.label} infrastructure — see the warning at the top of src/byoc/providers/${providerId}.js. Use the cheapest GPU type for a first try.\n`);

  if (!flags.yes) {
    if (!(await confirm(`Provision on ${provider.label} and deploy? This will start billing. (y/N) `))) {
      console.log('Nothing was provisioned.');
      return;
    }
  }

  if (provider.computeStyle === 'container') {
    const result = await provisionContainer({ providerId, apiKey, gpuTypeId: flags['gpu-type'], name, image: flags.image, diskGB, log: console.log });
    const record = openRegistry(rootDir).save({
      name,
      createdAt: new Date().toISOString(),
      computeStyle: 'container',
      provider: result.provider,
      host: result.host,
      port: result.port,
      tokenSha256: result.tokenSha256,
      app: { version: result.status.version, setupComplete: Boolean(result.status.setupComplete) },
      status: 'running',
      lastHealth: { at: new Date().toISOString(), ok: true, uptimeSeconds: result.status.uptimeSeconds ?? 0 },
    });
    console.log(`
  ⬡ ${record.name} is live on ${provider.label} (instance ${result.provider.instanceId}) — SovereignAI v${result.status.version}
    Web UI     http://${result.host}:${result.port}/#token=${encodeURIComponent(result.token)}
    Note       ${provider.label} maps this port directly to the internet. Treat the URL as a secret — the bearer token is the only thing protecting it. Put TLS in front before sharing it further.

    The token above is shown once and is not stored here (only its hash is).
    To stop billing: sovereign byoc destroy ${record.name} --api-key <key>
`);
    return;
  }

  const provisioned = await provisionVm({ rootDir, providerId, apiKey, gpuTypeId: flags['gpu-type'], name, region: flags.region, log: console.log });
  const runner = createSshRunner({
    target: provisioned.target,
    sshPort: provisioned.sshPort,
    keyPath: provisioned.keyPath,
    knownHostsFile: knownHostsPath(rootDir),
    strictHostKey: true, // pinned already during provisionVm's SSH-ready wait
  });
  const port = parsePortFlag(flags.port, '--port', 4321);
  const bind = flags.bind ?? 'loopback';
  const env = {};
  for (const pair of flags.env ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new ByocError(`Invalid --env "${pair}": expected KEY=value`);
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const archive = image.mode === 'source' ? sourceArchive() : null;

  const { record, handoff } = await deploy({
    rootDir, runner, name, port, bind, image, env, archive,
    fingerprint: () => pinnedHostKeyFingerprint({ host: runner.host, sshPort: provisioned.sshPort, knownHostsFile: knownHostsPath(rootDir) }),
    log: console.log,
  });
  const saved = openRegistry(rootDir).save({ ...record, computeStyle: 'vm', provider: provisioned.provider });

  console.log(`
  ⬡ ${saved.name} is live on ${provider.label} (${runner.describe()}, instance ${provisioned.provider.instanceId}) — SovereignAI v${record.app.version}
    Host key   ${record.hostKeyFingerprint ?? '(fingerprint unavailable; see byoc/known_hosts)'}
${handoff.tunnel ? `    Tunnel     ${handoff.tunnel}\n` : ''}    Web UI     ${handoff.url}
    ${handoff.note}

    The token above is shown once and is not stored here (only its hash is).
    To stop billing (this is a rented box, not one you own): sovereign byoc destroy ${saved.name} --api-key <key>
`);
}

function listCommand(rootDir, argv) {
  parseFlags(argv, {});
  const instances = openRegistry(rootDir).list();
  if (!instances.length) {
    console.log('No BYOC instances registered. Start with: sovereign byoc deploy --host user@host, or sovereign byoc gpu deploy <provider>');
    return;
  }
  for (const record of instances) {
    const health = record.lastHealth
      ? `${record.lastHealth.ok ? 'healthy' : 'unhealthy'} as of ${record.lastHealth.at}`
      : 'never checked';
    const where = record.computeStyle === 'container'
      ? `${record.provider?.name ?? '?'} instance ${record.provider?.instanceId ?? '?'} @ ${record.host}:${record.port}`
      : `${record.ssh.target}:${record.bind.port}`;
    console.log(`  ${record.name.padEnd(12)} ${String(record.status).padEnd(12)} v${record.app?.version ?? '?'}  ${where}  ${health}`);
  }
  console.log('\n  ("sovereign byoc status <name>" runs a live check.)');
}

async function statusCommand(rootDir, argv) {
  const flags = parseFlags(argv, { 'api-key': 'value' }, { positionals: 1 });
  const record = loadInstance(rootDir, flags._);

  if (record.computeStyle === 'container') {
    const provider = getGpuProvider(record.provider.name);
    const apiKey = flags['api-key'] ?? process.env[apiKeyEnvVar(record.provider.name)];
    if (!apiKey) {
      throw new ByocError(`Checking "${record.name}" needs a provider API key: pass --api-key or set ${apiKeyEnvVar(record.provider.name)}`);
    }
    const info = await provider.getInstance({ apiKey, instanceId: record.provider.instanceId, port: record.servicePort ?? 4321 });
    const role = record.role === 'inference' ? ` (serving ${record.model})` : '';
    console.log(`  ${record.name}${role}: ${provider.label} reports "${info.status}"${info.host ? ` at ${info.host}:${info.port ?? ''}` : ''}.`);
    if (info.status !== 'running') process.exitCode = 1;
    return;
  }

  const { record: rec, runner } = existingInstance(rootDir, flags._);
  const result = await checkHealth({ rootDir, runner, record: rec });
  if (result.ok) {
    console.log(`  ${rec.name}: healthy — SovereignAI v${result.status.version}, up ${result.status.uptimeSeconds}s, setup ${result.status.setupComplete ? 'complete' : 'pending'}`);
  } else {
    console.log(`  ${rec.name}: NOT healthy — container is ${result.containerState}${result.detail ? ` (${result.detail})` : ''}`);
    process.exitCode = 1;
  }
}

async function upgradeCommand(rootDir, argv) {
  const flags = parseFlags(argv, { image: 'value' }, { positionals: 1 });
  const { record, runner } = existingInstance(rootDir, flags._.length ? [flags._[0]] : []);
  const image = flags.image ? { mode: 'pull', ref: flags.image } : { mode: 'source' };
  const archive = image.mode === 'source' ? sourceArchive() : null;
  await upgradeInstance({ rootDir, runner, record, image, archive, log: console.log });
}

async function exportCommand(rootDir, argv) {
  const flags = parseFlags(argv, {}, { positionals: 2 });
  const { record, runner } = existingInstance(rootDir, flags._.length ? [flags._[0]] : []);
  const outFile = flags._[1] ?? `sovereign-${record.name}-export-${new Date().toISOString().slice(0, 10)}.json`;
  const { bytes } = await exportInstance({ runner, record, outFile: path.resolve(outFile), log: console.log });
  console.log(`  Exported ${formatBytes(bytes)} to ${outFile} — your data, on your machine, no control plane in between.`);
}

async function suspendCommand(rootDir, argv) {
  const { record, runner } = existingInstance(rootDir, argv);
  await suspendInstance({ rootDir, runner, record });
  console.log(`  ${record.name} suspended (container stopped; data volume untouched).`);
}

async function resumeCommand(rootDir, argv) {
  const { record, runner } = existingInstance(rootDir, argv);
  const status = await resumeInstance({ rootDir, runner, record, log: console.log });
  console.log(`  ${record.name} resumed — SovereignAI v${status.version} healthy.`);
}

async function destroyCommand(rootDir, argv) {
  const flags = parseFlags(argv, { 'purge-data': 'boolean', yes: 'boolean', 'api-key': 'value', 'keep-cloud-instance': 'boolean' }, { positionals: 1 });
  const record = loadInstance(rootDir, flags._);

  if (record.computeStyle === 'container') {
    return destroyContainerInstance(rootDir, record, flags);
  }

  const runner = createSshRunner({
    target: record.ssh.target,
    sshPort: record.ssh.port ?? 22,
    keyPath: record.ssh.keyPath ?? null,
    knownHostsFile: knownHostsPath(rootDir),
    strictHostKey: true,
  });
  if (flags['purge-data']) {
    console.log(`  WARNING: --purge-data deletes the ${record.volume} volume — chats, memory, documents, keys. Run "sovereign byoc export ${record.name}" first if you want them.`);
  }
  if (record.provider && !flags['keep-cloud-instance']) {
    console.log(`  Note: "${record.name}" is a ${record.provider.name} rented instance. Destroying also terminates the cloud instance (stops billing) — pass --keep-cloud-instance to only remove the app.`);
  }
  if (!flags.yes) {
    if (!(await confirm(`Destroy "${record.name}" on ${record.ssh.target}${flags['purge-data'] ? ' INCLUDING ALL DATA' : ' (keeping the data volume)'}? (y/N) `))) {
      console.log('Nothing was removed.');
      return;
    }
  }
  const { verification, clean } = await destroyInstance({ rootDir, runner, record, purgeData: Boolean(flags['purge-data']), log: console.log });
  console.log(`  Verified on the host: container ${verification.container}, volume ${verification.volume}, instance dir ${verification.dir}.`);
  if (!flags['purge-data'] && verification.volume === 'present') {
    console.log(`  Your data is still on the host in the ${record.volume} volume. Re-deploy with the same --name to pick it back up, or purge it later.`);
  }
  let cloudTerminated = true;
  if (record.provider && !flags['keep-cloud-instance']) {
    cloudTerminated = await terminateProviderInstance(record, flags['api-key']);
  }
  if (!clean || !cloudTerminated) {
    console.log('  Something was left behind — inspect the host/console before assuming removal.');
    process.exitCode = 1;
  }
}

async function terminateProviderInstance(record, apiKeyFlag) {
  const provider = getGpuProvider(record.provider.name);
  const apiKey = apiKeyFlag ?? process.env[apiKeyEnvVar(record.provider.name)];
  if (!apiKey) {
    console.log(`  WARNING: could not terminate the ${provider.label} instance ${record.provider.instanceId} — no API key. Pass --api-key or set ${apiKeyEnvVar(record.provider.name)}, or terminate it manually in the ${provider.label} console. IT IS STILL BILLING.`);
    return false;
  }
  try {
    await provider.terminate({ apiKey, instanceId: record.provider.instanceId });
    console.log(`  Terminated instance ${record.provider.instanceId} on ${provider.label} — billing stopped.`);
    return true;
  } catch (err) {
    console.log(`  WARNING: could not terminate the ${provider.label} instance ${record.provider.instanceId}: ${err.message}. Check the ${provider.label} console — IT MAY STILL BE BILLING.`);
    return false;
  }
}

async function destroyContainerInstance(rootDir, record, flags) {
  const provider = getGpuProvider(record.provider.name);
  console.log(`  "${record.name}" is a container-style instance on ${provider.label} — there is no SSH access or separate local container to remove; this only terminates the cloud instance.`);
  if (flags['purge-data']) {
    console.log('  Note: --purge-data has no separate effect here. Container-style instances keep no data volume this CLI controls; terminating the instance removes everything on it. This rail does not support remote export for container-style instances yet.');
  }
  if (!flags.yes) {
    if (!(await confirm(`Terminate "${record.name}" (instance ${record.provider.instanceId}) on ${provider.label}? This deletes everything on it and stops billing. (y/N) `))) {
      console.log('Nothing was removed.');
      return;
    }
  }
  const ok = await terminateProviderInstance(record, flags['api-key']);
  if (ok) {
    openRegistry(rootDir).remove(record.name);
  } else {
    console.log(`  The local record was kept so you can retry: sovereign byoc destroy ${record.name} --api-key <key>`);
    process.exitCode = 1;
  }
}

function loadInstance(rootDir, argv) {
  const name = argv[0];
  if (!name) throw new ByocError('An instance name is required. See "sovereign byoc list".');
  const record = openRegistry(rootDir).get(name);
  if (!record) throw new ByocError(`No instance named "${name}". See "sovereign byoc list".`);
  return record;
}

/** For actions that need SSH: upgrade, suspend, resume, export, and the legacy/vm-style destroy path. */
function existingInstance(rootDir, argv) {
  const record = loadInstance(rootDir, argv);
  if (record.computeStyle === 'container') {
    throw new ByocError(
      `"${record.name}" is a container-style GPU instance (${record.provider?.name}) with no SSH access, so this action isn't supported for it. Supported for container-style instances: "sovereign byoc status ${record.name}" and "sovereign byoc destroy ${record.name}".`
    );
  }
  const runner = createSshRunner({
    target: record.ssh.target,
    sshPort: record.ssh.port ?? 22,
    keyPath: record.ssh.keyPath ?? null,
    knownHostsFile: knownHostsPath(rootDir),
    strictHostKey: true, // the pinned host key must match; a changed key fails loudly
  });
  return { record, runner };
}

function apiKeyEnvVar(providerId) {
  return { runpod: 'RUNPOD_API_KEY', vastai: 'VASTAI_API_KEY', lambda: 'LAMBDA_API_KEY' }[providerId] ?? `${providerId.toUpperCase()}_API_KEY`;
}

async function confirm(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
