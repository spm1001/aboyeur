# Conductor Mesh Setup

Connect any Claude Code session to Anthropic's conductor mesh — the same mesh that Office Claude (Excel, Word, PowerPoint) instances use. CC sessions appear as peers alongside Office agents, with bidirectional messaging.

## What you get

Run `claude-mesh` instead of `claude`. You get the full CC TUI — identical experience — but a bridge sidecar connects you to the conductor mesh in the background. CC gains the `mesh` CLI:

```
mesh peers          List connected agents
mesh send <id> "…"  Send a message to a peer
mesh inbox          Show received messages
mesh status         Connection status
mesh id             Your mesh identity
```

Incoming mesh messages are injected directly into CC's terminal as text.

## Architecture

```
┌──────────────────────────────────────┐
│  mesh-claude.py  (PTY wrapper)       │
│  ┌──────────┐   ┌────────────────┐   │
│  │ Terminal  │   │ conductor-     │   │
│  │ I/O pass- │   │ bridge.ts      │   │
│  │ through   │   │ (WS sidecar)   │   │
│  └─────┬─────┘   └──────┬────────┘   │
│        │     PTY master  │            │
│        └───────┬─────────┘            │
│                ↕                      │
│        claude (PTY slave)             │
└──────────────────────────────────────┘
```

- **mesh-claude.py** creates a PTY, spawns `claude` as the slave, passes all terminal I/O transparently, and polls for mesh messages to inject.
- **conductor-bridge.ts** maintains a WebSocket to `bridge.claudeusercontent.com`, handles registration/ping/reconnection, and communicates with the wrapper via file-based IPC under `/tmp/conductor-bridge/{agent_id}/`.

## Prerequisites

| Requirement | Why | Check |
|---|---|---|
| **Claude Code** (authenticated, Max subscription) | Bridge reuses CC's OAuth token from `~/.claude/.credentials.json` | `claude --version` |
| **Node.js 18+** | Bridge is TypeScript; the `ws` library requires Node (Python WebSocket clients fail after 60s) | `node --version` |
| **npm** | Install `ws` dependency | `npm --version` |
| **Python 3.10+** | PTY wrapper uses stdlib `pty` module (Unix only) | `python3 --version` |
| **uv** | Runs the wrapper via PEP 723 inline metadata | `uv --version` |

All of these should already be present on any machine where you use Claude Code regularly.

## Setup

### 1. Get the repo

```bash
# First time:
cd ~/Repos
git clone git@github.com:spm1001/aboyeur.git

# Or pull latest:
cd ~/Repos/aboyeur
git pull
```

### 2. Install Node dependencies

```bash
cd ~/Repos/aboyeur
npm install
```

This installs `ws` (WebSocket library) into `node_modules/`. The bridge won't connect without it.

### 3. Put `claude-mesh` on your PATH

```bash
ln -sf ~/Repos/aboyeur/tools/claude-mesh ~/.local/bin/claude-mesh
```

Make sure `~/.local/bin` is on your PATH. If not:

```bash
# bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

# zsh (macOS default)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

### 4. Launch

```bash
cd ~/Repos/any-project
claude-mesh
```

That's it. After ~4 seconds you'll see a mesh orientation line injected into CC showing your agent ID and any online peers.

## Options

```
claude-mesh [options] [-- claude-args...]

  --agent-id ID    Override mesh identity (default: cc-{repo-name}-{hex6})
  --label LABEL    Override display name (default: {repo-name} (CC))
  --color COLOR    Hex color for peer display (default: #7719AA)
  --no-mesh        Run the PTY wrapper without mesh (useful for debugging)
```

Any arguments after `--` pass through to `claude` itself.

## Verifying it works

Once inside a `claude-mesh` session:

1. **Check status**: `mesh status` should say `connected`
2. **Check peers**: `mesh peers` lists other agents on the mesh
3. **Check logs**: `cat /tmp/conductor-bridge/cc-{your-id}/bridge.log` shows connection lifecycle
4. **Check events**: `cat /tmp/conductor-bridge/cc-{your-id}/events.jsonl` has the full protocol trace

If an Office Claude (Excel, Word) is open on the same account, it will appear in `mesh peers`.

## How identity works

Each session auto-generates its identity:

- **agent_id**: `cc-{repo-name}-{hex6}` (e.g., `cc-aboyeur-07d3fe`)
- **display name**: `{repo-name} ({hex6})` (e.g., `aboyeur (07d3fe)`)
- **appName** (shown in Office "Connected files"): the repo/project name

The hex suffix is random per session, so multiple CC sessions in the same repo get distinct identities.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `mesh status` says `disconnected` | Bridge failed to connect | Check `bridge.log` for auth errors. Run `claude` once to refresh OAuth token. |
| `npx tsx` not found | Node.js not installed or not on PATH | Install Node.js 18+ |
| `uv: command not found` | uv not installed | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Bridge connects then dies after 60s | You're somehow using a Python WebSocket client | Ensure `src/conductor-bridge.ts` exists and `npx tsx` resolves correctly |
| `readlink: illegal option -- f` | macOS < 12.3 | Upgrade macOS, or install GNU coreutils: `brew install coreutils` |
| No `node_modules/ws` | Forgot `npm install` | `cd ~/Repos/aboyeur && npm install` |
| CC starts but no mesh orientation | Bridge sidecar crashed on startup | Check `bridge.log`. Common: missing `~/.claude/.credentials.json` (run `claude` normally first to authenticate) |

## File-based IPC

The bridge communicates with the PTY wrapper through files in `/tmp/conductor-bridge/{agent_id}/`:

| File | Purpose |
|---|---|
| `inbox.jsonl` | Incoming messages (wrapper polls this, injects into PTY) |
| `outbox.jsonl` | Outgoing messages (CC writes via `mesh send`, bridge polls and transmits) |
| `peers.json` | Snapshot of connected agents (updated on peer join/leave) |
| `status` | Connection state: `connected`, `disconnected`, or `reconnecting` |
| `events.jsonl` | Full protocol trace (rotates at 1MB) |
| `bridge.log` | Human-readable activity log |
