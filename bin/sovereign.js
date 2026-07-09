#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { startServer } from '../src/server.js';
import { loadConfig, saveConfig, configPath, DEFAULT_CONFIG, VERSION } from '../src/config.js';

const rootDir = process.env.SOVEREIGN_HOME ?? process.cwd();
const [, , command = 'start', ...args] = process.argv;

const HELP = `SovereignAI v${VERSION} — your own sovereign AI

Usage: sovereign <command>

Commands:
  start            Start the server (default)   [--port N] [--host H]
  init             Create sovereign.config.json in the current directory
  mcp              Run the MCP server (stdio) for Claude/Codex/Cursor/etc.
  export [file]    Export all data (personas, chats, memory, knowledge) to JSON
  import <file>    Import a previous export
  help             Show this help
`;

try {
  switch (command) {
    case 'start':
      await start(parseFlags(args));
      break;
    case 'init':
      init();
      break;
    case 'mcp': {
      const { runMcpServer } = await import('../src/mcp.js');
      await runMcpServer(rootDir);
      break;
    }
    case 'export':
      await exportData(args[0]);
      break;
    case 'import':
      await importData(args[0]);
      break;
    default:
      console.log(HELP);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

async function start(flags) {
  const { host, port, config } = await startServer(rootDir, {
    host: flags.host,
    port: flags.port ? Number(flags.port) : undefined,
  });
  console.log(`
  ⬡ SovereignAI v${VERSION} — "${config.name}"
    Web UI    http://${host}:${port}
    API       http://${host}:${port}/api/status
    Data      ${path.join(rootDir, 'data')}

  Your models. Your memory. Your machine.
`);
}

function init() {
  const file = configPath(rootDir);
  if (fs.existsSync(file)) {
    console.log(`Config already exists: ${file}`);
    return;
  }
  saveConfig(rootDir, DEFAULT_CONFIG);
  console.log(`Created ${file}\nEdit it (or use the web UI Settings) to configure providers, then run: sovereign start`);
}

async function exportData(file) {
  const { createApp } = await import('../src/server.js');
  const { store } = createApp(rootDir);
  const out = {
    sovereignai: VERSION,
    exportedAt: new Date().toISOString(),
    data: store.exportAll(),
  };
  const target = file ?? `sovereign-export-${new Date().toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(target, JSON.stringify(out, null, 2));
  console.log(`Exported to ${target}`);
  store.close();
}

async function importData(file) {
  if (!file) throw new Error('Usage: sovereign import <file>');
  const { createApp } = await import('../src/server.js');
  const { store } = createApp(rootDir);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed.data) throw new Error('Not a SovereignAI export file');
  const counts = store.importAll(parsed.data);
  console.log('Imported:', counts);
  store.close();
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1];
  }
  return flags;
}
