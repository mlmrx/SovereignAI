# SovereignAI everywhere, via MCP

SovereignAI ships a built-in **MCP server** (`sovereign mcp`, stdio, zero dependencies). Any MCP-capable AI tool gains these tools:

| Tool | What it does |
|---|---|
| `ask_sovereign` | Ask your private AI (persona + memory + knowledge, on your machine) |
| `search_knowledge` | Search your private knowledge base |
| `add_knowledge` | Save a document into the knowledge base |
| `add_memory` | Store a long-term memory note |
| `list_memories` | List memory notes |

All data stays in your local `data/` directory — the MCP client only sees tool results.

> Replace `C:/path/to/SovereignAI` below with the absolute path to this repo. `SOVEREIGN_HOME` tells the server where your config + `data/` live.

## Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "sovereign": {
      "command": "node",
      "args": ["--no-warnings", "C:/path/to/SovereignAI/bin/sovereign.js", "mcp"],
      "env": { "SOVEREIGN_HOME": "C:/path/to/SovereignAI" }
    }
  }
}
```

## Claude Code

```bash
claude mcp add sovereign -e SOVEREIGN_HOME=C:/path/to/SovereignAI -- node --no-warnings C:/path/to/SovereignAI/bin/sovereign.js mcp
```

## Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.sovereign]
command = "node"
args = ["--no-warnings", "C:/path/to/SovereignAI/bin/sovereign.js", "mcp"]
env = { SOVEREIGN_HOME = "C:/path/to/SovereignAI" }
```

## Cursor / Windsurf

`.cursor/mcp.json` (or Windsurf's `mcp_config.json`):

```json
{
  "mcpServers": {
    "sovereign": {
      "command": "node",
      "args": ["--no-warnings", "C:/path/to/SovereignAI/bin/sovereign.js", "mcp"],
      "env": { "SOVEREIGN_HOME": "C:/path/to/SovereignAI" }
    }
  }
}
```

## Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "sovereign": {
      "command": "node",
      "args": ["--no-warnings", "C:/path/to/SovereignAI/bin/sovereign.js", "mcp"],
      "env": { "SOVEREIGN_HOME": "C:/path/to/SovereignAI" }
    }
  }
}
```

## Try it

In any connected client: *“Use sovereign to search my knowledge for the launch codename, then remember that I confirmed it today.”*
