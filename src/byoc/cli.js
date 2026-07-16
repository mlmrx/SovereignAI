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
                                         is re-inspected and shown.

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

function listCommand(rootDir, argv) {
  parseFlags(argv, {});
  const instances = openRegistry(rootDir).list();
  if (!instances.length) {
    console.log('No BYOC instances registered. Start with: sovereign byoc deploy --host user@host');
    return;
  }
  for (const record of instances) {
    const health = record.lastHealth
      ? `${record.lastHealth.ok ? 'healthy' : 'unhealthy'} as of ${record.lastHealth.at}`
      : 'never checked';
    console.log(`  ${record.name.padEnd(12)} ${String(record.status).padEnd(12)} v${record.app?.version ?? '?'}  ${record.ssh.target}:${record.bind.port}  ${health}`);
  }
  console.log('\n  ("sovereign byoc status <name>" runs a live check.)');
}

async function statusCommand(rootDir, argv) {
  const { record, runner } = existingInstance(rootDir, argv);
  const result = await checkHealth({ rootDir, runner, record });
  if (result.ok) {
    console.log(`  ${record.name}: healthy — SovereignAI v${result.status.version}, up ${result.status.uptimeSeconds}s, setup ${result.status.setupComplete ? 'complete' : 'pending'}`);
  } else {
    console.log(`  ${record.name}: NOT healthy — container is ${result.containerState}${result.detail ? ` (${result.detail})` : ''}`);
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
  const flags = parseFlags(argv, { 'purge-data': 'boolean', yes: 'boolean' }, { positionals: 1 });
  const { record, runner } = existingInstance(rootDir, flags._.length ? [flags._[0]] : []);
  if (flags['purge-data']) {
    console.log(`  WARNING: --purge-data deletes the ${record.volume} volume — chats, memory, documents, keys. Run "sovereign byoc export ${record.name}" first if you want them.`);
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
  if (!clean) {
    console.log('  Something was left behind — inspect the host before assuming removal.');
    process.exitCode = 1;
  }
}

function existingInstance(rootDir, argv) {
  const name = argv[0];
  if (!name) throw new ByocError('An instance name is required. See "sovereign byoc list".');
  const record = openRegistry(rootDir).get(name);
  if (!record) throw new ByocError(`No instance named "${name}". See "sovereign byoc list".`);
  const runner = createSshRunner({
    target: record.ssh.target,
    sshPort: record.ssh.port ?? 22,
    keyPath: record.ssh.keyPath ?? null,
    knownHostsFile: knownHostsPath(rootDir),
    strictHostKey: true, // the pinned host key must match; a changed key fails loudly
  });
  return { record, runner };
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
