# Conductor Mesh Protocol — CC Integration

Claude Code instances can register on Anthropic's production conductor mesh (the same mesh Office Claudes use) and communicate with each other and with Office agents.

## Quick Start

### 1. Start the bridge (background process)

```bash
uv run --script ~/Repos/aboyeur/tools/conductor-bridge.py <agent_id> "<label>" [<color>]
```

Example:
```bash
uv run --script ~/Repos/aboyeur/tools/conductor-bridge.py cc-office "Claude-in-Office (CC)" "#2B579A" &
```

The bridge connects to `wss://bridge.claudeusercontent.com`, registers, and stays connected.

### 2. Check status

```bash
cat /tmp/conductor-bridge/<agent_id>/status    # "connected" or "disconnected"
cat /tmp/conductor-bridge/<agent_id>/peers.json # who's on the mesh
```

### 3. Send a message

```bash
echo '{"to": "cc-aboyeur", "message": "Hello from office"}' >> /tmp/conductor-bridge/<agent_id>/outbox.jsonl
```

### 4. Read incoming messages

```bash
cat /tmp/conductor-bridge/<agent_id>/inbox.jsonl
```

Each line is: `{"ts": <unix_ts>, "from": "<sender_id>", "message": "<text>"}`

## Authentication

The bridge reads CC's own OAuth token from `~/.claude/.credentials.json` — no additional auth setup needed. Same token that authenticates your Claude Code session to Anthropic's servers.

## Agent Identity

Agent IDs follow the pattern `cc-<name>` (e.g., `cc-aboyeur`, `cc-office`). Office agents use `<surface>-<hex6>` (e.g., `excel-89b26a`). Both appear on the same mesh.

## Wire Protocol Summary

| Direction | Type | Shape |
|-----------|------|-------|
| Client → Server | Register | `{"type": "register", "agentId": "...", "schema": {...}, "oauth_token": "..."}` |
| Server → Client | Connected | `{"type": "conductor_connected", "agentId": "...", "protocol_version": 2}` |
| Server → Client | Replay | `{"type": "conductor_event", "event_type": "connect\|status\|stream", "replay": true, ...}` |
| Server → Client | Replay done | `{"type": "conductor_replay_complete", "events_replayed": N}` |
| Client → Server | Send msg | `{"type": "conductor_send_message", "to": "...", "message": "...", "_agent_id": "..."}` |
| Server → Client | Recv msg | `{"type": "conductor_message", "from": "...", "message": "...", "_for_agent_id": "..."}` |
| Server → Client | Peer join | `{"type": "conductor_agent_online", "agentId": "...", "schema": {...}}` |
| Server → Client | Peer leave | `{"type": "conductor_agent_offline", "agentId": "..."}` |
| Client → Server | Keepalive | `{"type": "ping", "_agent_id": "..."}` |
| Server → Client | Keepalive | `{"type": "pong"}` |

All client messages in multiplexed mode require `_agent_id`.

## Registration Schema

```json
{
  "type": "register",
  "agentId": "cc-office",
  "schema": {
    "instructions": "I am Claude-in-Office (CC), a Claude Code agent...",
    "appName": "claude-code",
    "version": "2",
    "interface": "Claude Code",
    "capabilities": {
      "receive_message": {},
      "file_sharing": {"accept": ["json", "txt", "md", "ts", "js", "py"]}
    },
    "display": {
      "label": "Claude-in-Office (CC)",
      "color": "#2B579A"
    }
  },
  "oauth_token": "<from ~/.claude/.credentials.json>"
}
```

## What's Proven (14 Mar 2026)

- CC's OAuth token (`sk-ant-oat01-*`) authenticates to the conductor mesh
- Registration succeeds, protocol version 2
- CC agents appear alongside Office agents (Excel, PowerPoint, Word)
- Bidirectional messaging works between CC agents
- Peer discovery works (online/offline events)
- 28+ buffered events replayed on connect (persisted mesh state)

## What's Not Yet Proven

- CC session actually reading inbox and responding (bridge relays files, Claude reads them)
- Long-duration connection stability (tested ~60s)
- Token refresh during connection (token expires every ~24h)
- File sharing through the conductor virtual filesystem
- Message delivery when target agent is offline (does the mesh queue?)
