#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  loadConfig,
  saveConfig,
  configPath,
  scrubPersistedEnvironmentSecrets,
  DEFAULT_CONFIG,
  VERSION,
} from '../src/config.js';

// Source checkouts remain project-local by default. Installed launchers set
// SOVEREIGN_HOME to their stable install/state directory, and an explicit value
// always wins.
const rootDir = path.resolve(process.env.SOVEREIGN_HOME || process.cwd());
const [, , command = 'start', ...args] = process.argv;

class CliError extends Error {}

const HELP = `SovereignAI v${VERSION} — your own sovereign AI

Usage: sovereign <command>

Commands:
  start            Start the server (default)   [--port N] [--host H] [--lan]
  init             Create config in the active SovereignAI home
  doctor           Diagnose config, data, providers, models, and connectivity
  mcp              Run the MCP server (stdio) for Claude/Codex/Cursor/etc.
  export [file]    Export all data (personas, chats, memory, knowledge) to JSON
  import <file>    Import a previous export
  help             Show this help

Options:
  --lan            Bind 0.0.0.0 and protect remote API requests with a token
  --port N         Listen on a port from 1 to 65535
  --host H         Listen on an IP address or hostname (cannot combine with --lan)
  --no-network     With doctor, skip live provider and model checks

Environment:
  SOVEREIGN_HOME   Config + data directory. Installed launchers set a stable
                   default; set it explicitly for a separate/project instance.
`;

try {
  switch (command) {
    case 'start': {
      const flags = parseStartFlags(args);
      if (flags.help) console.log(HELP);
      else await start(flags);
      break;
    }
    case 'init':
      if (wantsHelp(args)) console.log(HELP);
      else {
        assertNoArgs('init', args);
        init();
      }
      break;
    case 'doctor': {
      const flags = parseDoctorFlags(args);
      if (flags.help) console.log(HELP);
      else await doctor(flags);
      break;
    }
    case 'mcp': {
      if (wantsHelp(args)) {
        console.log(HELP);
        break;
      }
      assertNoArgs('mcp', args);
      const { runMcpServer } = await import('../src/mcp.js');
      await runMcpServer(rootDir);
      break;
    }
    case 'export': {
      if (wantsHelp(args)) console.log(HELP);
      else await exportData(singlePathArg('export', args, { required: false }));
      break;
    }
    case 'import': {
      if (wantsHelp(args)) console.log(HELP);
      else await importData(singlePathArg('import', args, { required: true }));
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      assertNoArgs(command, args);
      console.log(HELP);
      break;
    case 'version':
    case '--version':
    case '-V':
      assertNoArgs(command, args);
      console.log(VERSION);
      break;
    default:
      throw new CliError(`Unknown command: ${command}`);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  if (err instanceof CliError) console.error('Run "sovereign help" for usage.');
  process.exitCode = 1;
}

async function start(flags) {
  fs.mkdirSync(rootDir, { recursive: true });
  if (flags.lan) {
    // LAN/tailnet mode: bind all interfaces, require a bearer token for remote clients
    const config = loadConfig(rootDir);
    if (!config.authToken) {
      const persisted = scrubPersistedEnvironmentSecrets(loadConfig(rootDir, { env: {} }), process.env);
      persisted.authToken = crypto.randomBytes(24).toString('base64url');
      saveConfig(rootDir, persisted);
    }
    flags.host = '0.0.0.0';
  }

  const { startServer } = await import('../src/server.js');
  const { host, port, config } = await startServer(rootDir, {
    host: flags.host,
    port: flags.port,
  });
  const localHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const localUrlHost = urlHost(localHost);
  // URL fragments are never sent to HTTP servers or tunnels, keeping the token out of access logs.
  const browserToken = config.authToken ? `#token=${encodeURIComponent(config.authToken)}` : '';
  console.log(`
  ⬡ SovereignAI v${VERSION} — "${config.name}"
    Web UI    http://${localUrlHost}:${port}/${browserToken}
    API       http://${localUrlHost}:${port}/api/status
    Home      ${rootDir}
    Data      ${path.join(rootDir, 'data')}`);
  if (flags.lan) {
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address);
    console.log(`
    LAN mode  open on another device:
              ${addresses.map((a) => `http://${a}:${port}/#token=${encodeURIComponent(config.authToken)}`).join('\n              ') || '(no LAN interfaces found)'}
              (the token is remembered by the browser after first visit;
               API clients send it as  Authorization: Bearer <token>)`);
  } else if (config.authToken) {
    console.log('\n    Access     bearer token required; use the authenticated Web UI URL above');
  }
  console.log('\n  Your models. Your memory. Your machine.\n');
}

function init() {
  fs.mkdirSync(rootDir, { recursive: true });
  const file = configPath(rootDir);
  if (fs.existsSync(file)) {
    console.log(`Config already exists: ${file}`);
    return;
  }
  saveConfig(rootDir, DEFAULT_CONFIG);
  console.log(
    `Created ${file}\nHome: ${rootDir}\nEdit it (or use the web UI Settings) to configure providers, then run: sovereign start`
  );
}

async function exportData(file) {
  const { createApp } = await import('../src/server.js');
  const { store } = createApp(rootDir);
  try {
    const out = {
      sovereignai: VERSION,
      exportedAt: new Date().toISOString(),
      data: store.exportAll(),
    };
    const target = file ?? `sovereign-export-${new Date().toISOString().slice(0, 10)}.json`;
    fs.writeFileSync(target, JSON.stringify(out, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(target, 0o600);
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'ENOSYS') throw err;
    }
    console.log(`Exported to ${target}`);
  } finally {
    store.close();
  }
}

async function importData(file) {
  const { createApp } = await import('../src/server.js');
  const { shouldReplaceSeedPersonas } = await import('../src/personas.js');
  const { store } = createApp(rootDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed.data) throw new Error('Not a SovereignAI export file');
    const counts = store.importAll(parsed.data, {
      replacePersonas: shouldReplaceSeedPersonas(store, parsed.data),
    });
    console.log('Imported:', counts);
  } finally {
    store.close();
  }
}

async function doctor({ network }) {
  const result = { failures: 0, warnings: 0, actions: [] };
  const report = (level, label, detail, action) => {
    console.log(`  [${level}] ${label}${detail ? ` — ${oneLine(detail)}` : ''}`);
    if (level === 'fail') result.failures++;
    if (level === 'warn') result.warnings++;
    if ((level === 'fail' || level === 'warn') && action && !result.actions.includes(action)) result.actions.push(action);
  };

  console.log(`SovereignAI doctor v${VERSION}\n`);
  console.log(`  Home     ${rootDir}`);
  console.log(`  Config   ${configPath(rootDir)}`);
  console.log(`  Database ${path.join(rootDir, 'data', 'sovereign.db')}\n`);

  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 5);
  report(nodeOk ? 'ok' : 'fail', 'Runtime', `Node ${process.versions.node}`, 'Install Node.js 22.5 or newer.');
  inspectHome(rootDir, report);

  let config;
  const file = configPath(rootDir);
  if (!fs.existsSync(file)) {
    report('warn', 'Config', 'not created; defaults and environment overrides are active', 'Run "sovereign init" or "sovereign start" and finish the setup wizard.');
  }
  try {
    config = loadConfig(rootDir);
    if (fs.existsSync(file)) report('ok', 'Config', 'valid JSON');
  } catch {
    report('fail', 'Config', 'cannot be parsed', `Fix or replace ${file}; doctor intentionally did not print its contents.`);
    finishDoctor(result);
    return;
  }

  if (config.setupComplete) report('ok', 'Setup', `complete for "${oneLine(config.name)}"`);
  else report('warn', 'Setup', 'first-run setup is not complete', 'Run "sovereign start", open the printed URL, and finish the setup wizard.');

  const configuredHost = String(config.host ?? '127.0.0.1');
  if (config.authToken) report('ok', 'Access token', 'configured (secret not shown)');
  else if (isLoopbackHost(configuredHost)) report('ok', 'Access', `local-only on ${configuredHost}`);
  else report('warn', 'Access token', `not configured for host ${oneLine(configuredHost)}`, 'Use "sovereign start --lan" to generate a remote-access token safely.');

  await inspectDatabase(path.join(rootDir, 'data', 'sovereign.db'), report);
  await inspectProviders(config, { network, report });
  finishDoctor(result);
}

function inspectHome(home, report) {
  let target = home;
  while (!fs.existsSync(target)) {
    const parent = path.dirname(target);
    if (parent === target) break;
    target = parent;
  }
  try {
    fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK);
    report('ok', 'Home directory', fs.existsSync(home) ? 'readable and writable' : `will be created under ${target}`);
  } catch {
    report('fail', 'Home directory', `not writable: ${target}`, 'Choose a writable SOVEREIGN_HOME directory.');
  }
}

async function inspectDatabase(file, report) {
  if (!fs.existsSync(file)) {
    report('warn', 'Database', 'not created yet', 'Run "sovereign start" once to initialize local data.');
    return;
  }

  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(file, { readOnly: true });
    const quickCheck = Object.values(db.prepare('PRAGMA quick_check').get() ?? {})[0];
    if (quickCheck !== 'ok') throw new Error('SQLite quick_check did not return ok');
    const tables = ['personas', 'conversations', 'messages', 'memories', 'documents', 'chunks'];
    const counts = [];
    for (const table of tables) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (exists) counts.push(`${table}=${db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n}`);
    }
    const size = formatBytes(fs.statSync(file).size);
    report('ok', 'Database', `healthy, ${size}${counts.length ? `; ${counts.join(', ')}` : ''}`);
  } catch {
    report('fail', 'Database', 'could not be opened or failed its integrity check', 'Restore a known-good export or back up the data directory before repairing the database.');
  } finally {
    db?.close();
  }
}

async function inspectProviders(config, { network, report }) {
  const { providers } = await import('../src/providers/index.js');
  const defaultProvider = config.defaults?.provider;
  const defaultModel = config.defaults?.model;
  const embeddingProvider = config.embeddings?.provider;
  const embeddingModel = config.embeddings?.model;

  if (!providers[defaultProvider]) {
    report('fail', 'Default provider', `unknown provider "${oneLine(defaultProvider ?? '')}"`, 'Choose a supported default provider in Settings.');
  } else if (!defaultModel && defaultProvider !== 'anthropic') {
    report('fail', 'Default model', 'none selected', 'Choose a default model in Settings.');
  } else {
    report('ok', 'Default model', defaultModel ? `${defaultProvider}/${oneLine(defaultModel)}` : `${defaultProvider}/provider default`);
  }

  const checks = Object.values(providers).map(async (provider) => {
    const cfg = config.providers?.[provider.id] ?? {};
    const isDefault = provider.id === defaultProvider;
    if (!cfg.enabled) {
      report(isDefault ? 'fail' : 'skip', provider.label, 'disabled', isDefault ? 'Enable the default provider or choose another one in Settings.' : undefined);
      return;
    }
    if (!provider.isConfigured(cfg)) {
      report(isDefault ? 'fail' : 'warn', provider.label, 'enabled but incomplete', provider.id === 'anthropic' ? 'Add the Anthropic API key in Settings or ANTHROPIC_API_KEY.' : 'Complete this provider configuration in Settings.');
      return;
    }
    if (!network) {
      report('skip', provider.label, `configured at ${safeEndpoint(cfg.baseUrl)}; live check skipped`);
      return;
    }

    try {
      const health = await provider.health(cfg);
      report('ok', provider.label, `${safeEndpoint(cfg.baseUrl)}; ${scrubSecrets(health.detail ?? 'reachable', config)}`);

      let models = [];
      try {
        models = await provider.listModels(cfg);
      } catch (err) {
        report('warn', `${provider.label} models`, scrubSecrets(err.message, config), 'The provider is reachable but its model-list endpoint failed; enter the model name manually if needed.');
        return;
      }
      const ids = new Set(models.map((model) => model.id));
      if (isDefault && defaultModel) {
        if (ids.has(defaultModel)) report('ok', 'Default model availability', `${oneLine(defaultModel)} is available`);
        else report('fail', 'Default model availability', `${oneLine(defaultModel)} was not returned by ${provider.label}`, provider.id === 'ollama' ? `Run "ollama pull ${oneLine(defaultModel)}".` : 'Choose an available model in Settings.');
      }
      if (provider.id === embeddingProvider && embeddingModel) {
        if (ids.has(embeddingModel)) report('ok', 'Embedding model availability', `${oneLine(embeddingModel)} is available`);
        else report('warn', 'Embedding model availability', `${oneLine(embeddingModel)} was not returned by ${provider.label}; search will use keywords`, provider.id === 'ollama' ? `Run "ollama pull ${oneLine(embeddingModel)}" for semantic search.` : 'Choose an available embedding model.');
      }
    } catch (err) {
      report(isDefault ? 'fail' : 'warn', provider.label, scrubSecrets(err.message, config), provider.id === 'ollama' ? 'Start Ollama ("ollama serve") and verify OLLAMA_BASE_URL, or use "sovereign doctor --no-network" for local-only checks.' : 'Check the provider URL/key and network access.');
    }
  });

  await Promise.all(checks);
}

function finishDoctor(result) {
  console.log('');
  if (result.actions.length) {
    console.log('Next steps:');
    result.actions.forEach((action, index) => console.log(`  ${index + 1}. ${action}`));
    console.log('');
  }
  if (result.failures) {
    console.log(`Result: ${result.failures} failure(s), ${result.warnings} warning(s).`);
    process.exitCode = 1;
  } else if (result.warnings) {
    console.log(`Result: usable with ${result.warnings} warning(s).`);
  } else {
    console.log('Result: ready.');
  }
}

function parseStartFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--lan') {
      setOnce(flags, 'lan', true);
      continue;
    }
    const match = arg.match(/^--(port|host)(?:=(.*))?$/);
    if (!match) {
      if (arg.startsWith('--')) throw new CliError(`Unknown start option: ${arg}`);
      throw new CliError(`Unexpected start argument: ${arg}`);
    }
    const key = match[1];
    let value = match[2];
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new CliError(`--${key} requires a value`);
    }
    if (!value) throw new CliError(`--${key} requires a value`);
    setOnce(flags, key, key === 'port' ? parsePort(value) : parseHost(value));
  }
  if (flags.lan && flags.host) throw new CliError('--lan and --host cannot be used together; --lan binds 0.0.0.0');
  return flags;
}

function parseDoctorFlags(argv) {
  const flags = { network: true };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--no-network') flags.network = false;
    else if (arg.startsWith('--')) throw new CliError(`Unknown doctor option: ${arg}`);
    else throw new CliError(`Unexpected doctor argument: ${arg}`);
  }
  return flags;
}

function parsePort(value) {
  if (!/^\d+$/.test(value)) throw new CliError(`Invalid port "${value}": expected an integer from 1 to 65535`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new CliError(`Invalid port "${value}": expected an integer from 1 to 65535`);
  return port;
}

function parseHost(value) {
  if (value !== value.trim()) throw new CliError('Invalid host: leading or trailing whitespace is not allowed');
  if (net.isIP(value)) return value;
  const hostname = value.endsWith('.') ? value.slice(0, -1) : value;
  const valid =
    hostname.length > 0 &&
    hostname.length <= 253 &&
    hostname.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
  if (!valid) throw new CliError(`Invalid host "${value}": use an IP address or hostname (without http:// or a path)`);
  return value;
}

function setOnce(target, key, value) {
  if (Object.hasOwn(target, key)) throw new CliError(`Option --${key} may only be provided once`);
  target[key] = value;
}

function wantsHelp(argv) {
  return argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h');
}

function assertNoArgs(commandName, argv) {
  if (argv.length) throw new CliError(`${commandName} does not accept arguments: ${argv.join(' ')}`);
}

function singlePathArg(commandName, argv, { required }) {
  if (argv.some((arg) => arg.startsWith('--'))) throw new CliError(`${commandName} does not accept options`);
  if (argv.length > 1) throw new CliError(`Usage: sovereign ${commandName}${required ? ' <file>' : ' [file]'}`);
  if (required && argv.length === 0) throw new CliError(`Usage: sovereign ${commandName} <file>`);
  return argv[0];
}

function urlHost(host) {
  return net.isIP(host) === 6 ? `[${host}]` : host;
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function safeEndpoint(value) {
  if (!value) return '(no endpoint)';
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '(configured endpoint)';
  }
}

function scrubSecrets(value, config) {
  let text = oneLine(value ?? 'unreachable');
  const secrets = [
    config.authToken,
    ...Object.values(config.providers ?? {}).map((provider) => provider?.apiKey),
  ].filter((secret) => typeof secret === 'string' && secret.length > 0);
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  text = text.replace(/https?:\/\/[^\s,;]+/gi, (url) => safeEndpoint(url));
  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1')
    .slice(0, 240);
}

function oneLine(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 240);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
