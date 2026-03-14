# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets"]
# ///
"""
Conductor mesh bridge — connects a Claude Code agent to Anthropic's conductor mesh.

Maintains a persistent WebSocket connection to bridge.claudeusercontent.com.
CC sessions interact through the filesystem:

  /tmp/conductor-bridge/<agent_id>/inbox.jsonl   — incoming messages (append-only)
  /tmp/conductor-bridge/<agent_id>/outbox.jsonl  — write a line to send a message
  /tmp/conductor-bridge/<agent_id>/peers.json    — snapshot of connected agents
  /tmp/conductor-bridge/<agent_id>/status         — "connected" or "disconnected"

Usage:
  uv run --script conductor-bridge.py <agent_id> <label> [<color>]

Examples:
  uv run --script conductor-bridge.py cc-aboyeur "Aboyeur (CC)" "#7719AA"
  uv run --script conductor-bridge.py cc-office "Claude-in-Office (CC)" "#2B579A"

To send a message, append a JSON line to the outbox:
  echo '{"to": "cc-aboyeur", "message": "Hello from office"}' >> outbox.jsonl

Incoming messages arrive in inbox.jsonl as:
  {"ts": 1773511339.07, "from": "cc-aboyeur", "message": "Hello from aboyeur"}

Wire protocol (Anthropic conductor mesh):
  - WebSocket: wss://bridge.claudeusercontent.com/v2/conductor/{profile_uuid}
  - Auth: Bearer token from ~/.claude/.credentials.json (CC's own OAuth token)
  - First message must be: {"type": "register", "agentId": "...", "schema": {...}, "oauth_token": "..."}
  - Server responds: {"type": "conductor_connected", "agentId": "...", "protocol_version": 2}
  - Then replays buffered events (peer connects, statuses, transcripts)
  - Send: {"type": "conductor_send_message", "to": "<id>", "message": "...", "_agent_id": "<my_id>"}
  - Recv: {"type": "conductor_message", "from": "<id>", "message": "...", "_for_agent_id": "<my_id>"}
  - Keepalive: {"type": "ping", "_agent_id": "<my_id>"} -> {"type": "pong"}
  - All messages in multiplexed mode require _agent_id
"""
import asyncio
import json
import sys
import time
from pathlib import Path

import websockets

BRIDGE_DIR = Path("/tmp/conductor-bridge")
CREDS_PATH = Path.home() / ".claude" / ".credentials.json"


def read_creds():
    with open(CREDS_PATH) as f:
        creds = json.load(f)
    oauth = creds["claudeAiOauth"]
    return oauth["accessToken"]


def get_profile_uuid(token):
    """Get profile UUID from Anthropic OAuth API."""
    import urllib.request
    req = urllib.request.Request(
        "https://api.anthropic.com/api/oauth/profile",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
    return data["account"]["uuid"]


def make_registration(agent_id, label, color, token):
    return {
        "type": "register",
        "agentId": agent_id,
        "schema": {
            "instructions": (
                f"I am {label}, a Claude Code agent. "
                "Send me a task or message and I will respond. "
                "I can read and write code, run commands, search files, "
                "and interact with the local development environment."
            ),
            "appName": "claude-code",
            "version": "2",
            "interface": "Claude Code",
            "capabilities": {
                "receive_message": {},
                "file_sharing": {"accept": ["json", "txt", "md", "ts", "js", "py"]},
            },
            "display": {"label": label, "color": color},
        },
        "oauth_token": token,
    }


def log(agent_id, msg):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] [{agent_id}] {msg}", flush=True)


async def watch_outbox(ws, agent_id, agent_dir):
    """Poll outbox file for messages to send."""
    outbox = agent_dir / "outbox.jsonl"
    outbox.touch()
    last_pos = 0

    while True:
        await asyncio.sleep(0.5)
        try:
            size = outbox.stat().st_size
            if size > last_pos:
                with open(outbox) as f:
                    f.seek(last_pos)
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        msg = json.loads(line)
                        wire_msg = {
                            "type": "conductor_send_message",
                            "to": msg["to"],
                            "message": msg["message"],
                            "_agent_id": agent_id,
                        }
                        await ws.send(json.dumps(wire_msg))
                        log(agent_id, f"SENT to {msg['to']}: {msg['message'][:100]}")
                    last_pos = f.tell()
        except (FileNotFoundError, json.JSONDecodeError):
            pass


async def run_agent(agent_id, label, color):
    agent_dir = BRIDGE_DIR / agent_id
    agent_dir.mkdir(parents=True, exist_ok=True)

    inbox = agent_dir / "inbox.jsonl"
    peers_file = agent_dir / "peers.json"
    status_file = agent_dir / "status"

    inbox.touch()
    status_file.write_text("connecting")

    peers = {}
    token = read_creds()
    profile_uuid = get_profile_uuid(token)
    ws_url = f"wss://bridge.claudeusercontent.com/v2/conductor/{profile_uuid}"

    log(agent_id, f"Connecting to conductor mesh as {label}...")
    log(agent_id, f"Profile: {profile_uuid[:8]}...")

    while True:
        try:
            async with websockets.connect(
                ws_url,
                additional_headers={"Authorization": f"Bearer {token}"},
                ping_interval=None,
                ping_timeout=None,
                close_timeout=5,
            ) as ws:
                # Register
                reg = make_registration(agent_id, label, color, token)
                await ws.send(json.dumps(reg))
                log(agent_id, "Registration sent")

                # Background tasks
                outbox_task = asyncio.create_task(watch_outbox(ws, agent_id, agent_dir))

                async def pinger():
                    while True:
                        await asyncio.sleep(30)
                        try:
                            await ws.send(json.dumps({"type": "ping", "_agent_id": agent_id}))
                        except Exception:
                            break

                ping_task = asyncio.create_task(pinger())

                try:
                    async for raw in ws:
                        data = json.loads(raw)
                        msg_type = data.get("type", "")

                        if msg_type == "conductor_connected":
                            status_file.write_text("connected")
                            log(agent_id, f"Connected! Protocol v{data.get('protocol_version')}")

                        elif msg_type == "conductor_replay_complete":
                            n = data.get("events_replayed", 0)
                            log(agent_id, f"Replay complete ({n} events)")

                        elif msg_type == "conductor_event":
                            evt = data.get("event_type", "")
                            peer_id = data.get("agent_id", "")
                            payload = data.get("payload", {})
                            replay = data.get("replay", False)

                            if evt == "connect":
                                peers[peer_id] = {
                                    "label": payload.get("display", {}).get("label", peer_id),
                                    "app": payload.get("appName", "?"),
                                    "color": payload.get("display", {}).get("color", ""),
                                }
                                peers_file.write_text(json.dumps(peers, indent=2))
                                if not replay:
                                    log(agent_id, f"Peer joined: {peer_id}")

                            elif evt == "disconnect":
                                peers.pop(peer_id, None)
                                peers_file.write_text(json.dumps(peers, indent=2))
                                if not replay:
                                    log(agent_id, f"Peer left: {peer_id}")

                            elif evt == "status":
                                if peer_id in peers:
                                    peers[peer_id]["file"] = payload.get("fileName", "")
                                    peers_file.write_text(json.dumps(peers, indent=2))

                        elif msg_type == "conductor_agent_online":
                            peer_id = data.get("agentId", "")
                            schema = data.get("schema", {})
                            peers[peer_id] = {
                                "label": schema.get("display", {}).get("label", peer_id),
                                "app": schema.get("appName", "?"),
                                "color": schema.get("display", {}).get("color", ""),
                            }
                            peers_file.write_text(json.dumps(peers, indent=2))
                            log(agent_id, f"Peer online: {peer_id} ({peers[peer_id]['label']})")

                        elif msg_type == "conductor_agent_offline":
                            peer_id = data.get("agentId", "")
                            peers.pop(peer_id, None)
                            peers_file.write_text(json.dumps(peers, indent=2))
                            log(agent_id, f"Peer offline: {peer_id}")

                        elif msg_type == "conductor_message":
                            from_id = data.get("from", "?")
                            message = data.get("message", "")
                            entry = {
                                "ts": time.time(),
                                "from": from_id,
                                "message": message,
                            }
                            with open(inbox, "a") as f:
                                f.write(json.dumps(entry) + "\n")
                            log(agent_id, f"MSG from {from_id}: {message[:120]}")

                        elif msg_type == "pong":
                            pass

                        elif msg_type == "conductor_error":
                            log(agent_id, f"ERROR: {data.get('error', data)}")

                        else:
                            log(agent_id, f"[{msg_type}] {json.dumps(data)[:200]}")

                finally:
                    outbox_task.cancel()
                    ping_task.cancel()
                    status_file.write_text("disconnected")

        except (websockets.exceptions.ConnectionClosed, OSError) as e:
            log(agent_id, f"Connection lost ({e}), reconnecting in 5s...")
            status_file.write_text("reconnecting")
            await asyncio.sleep(5)
        except KeyboardInterrupt:
            log(agent_id, "Shutting down")
            status_file.write_text("disconnected")
            break


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <agent_id> <label> [<color>]")
        print(f"  agent_id: unique identifier (e.g. cc-aboyeur)")
        print(f"  label: display name (e.g. 'Aboyeur (CC)')")
        print(f"  color: hex color (default: #7719AA)")
        sys.exit(1)

    agent_id = sys.argv[1]
    label = sys.argv[2]
    color = sys.argv[3] if len(sys.argv) > 3 else "#7719AA"

    asyncio.run(run_agent(agent_id, label, color))
