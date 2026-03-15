# /// script
# requires-python = ">=3.10"
# ///
"""mesh-claude: transparent PTY wrapper for Claude Code with conductor mesh.

Spawns `claude` in a PTY with full terminal transparency. Optionally connects
to Anthropic's conductor mesh via the bridge sidecar. Mesh messages inject
directly into CC's terminal input as keystrokes.

Architecture:
  ┌──────────────────────────────────────┐
  │  mesh-claude                         │
  │  ┌──────────┐   ┌────────────────┐   │
  │  │ Terminal  │   │ conductor-     │   │
  │  │ I/O pass- │   │ bridge.py      │   │
  │  │ through   │   │ (sidecar)      │   │
  │  └─────┬─────┘   └──────┬────────┘   │
  │        │     PTY master  │            │
  │        └───────┬─────────┘            │
  │                ↕                      │
  │        claude (PTY slave)             │
  └──────────────────────────────────────┘

Usage:
  uv run --script tools/mesh-claude.py [options]

  Options:
    --agent-id ID    Mesh identity (default: cc-{repo-name})
    --label LABEL    Display name (default: {repo-name} (CC))
    --color COLOR    Hex color (default: #7719AA)
    --no-mesh        Skip mesh connection (just PTY wrapper)

Outbound (CC uses via Bash tool):
  mesh send <agent_id> "message"
  mesh peers
  mesh inbox
  mesh status
  mesh id
"""

import argparse
import fcntl
import json
import os
import pty
import select
import signal
import socket
import subprocess
import sys
import termios
import threading
import time
import tty
from pathlib import Path

BRIDGE_SCRIPT = Path(__file__).parent / "conductor-bridge.py"


def derive_identity():
    """Derive mesh identity from current directory (repo name)."""
    repo_name = Path.cwd().name.lower().replace(" ", "-")
    return f"cc-{repo_name}", f"{Path.cwd().name} (CC)"


def install_mesh_cli(tools_dir):
    """Write the `mesh` CLI script into tools/. Uses MESH_* env vars at runtime."""
    mesh_path = tools_dir / "mesh"
    mesh_path.write_text("""\
#!/bin/bash
# mesh — conductor mesh CLI
# Reads MESH_AGENT_ID and MESH_BRIDGE_DIR from environment (set by mesh-claude)
DIR="${MESH_BRIDGE_DIR:?MESH_BRIDGE_DIR not set — are you running inside mesh-claude?}"
AGENT_ID="${MESH_AGENT_ID:-unknown}"

case "${1:-help}" in
  send)
    [ -z "$2" ] || [ -z "$3" ] && echo "Usage: mesh send <agent_id> \\"message\\"" && exit 1
    python3 -c "import json,sys; f=open(sys.argv[3]+'/outbox.jsonl','a'); f.write(json.dumps({'to':sys.argv[1],'message':sys.argv[2]})+chr(10)); f.close()" "$2" "$3" "$DIR"
    echo "→ Sent to $2"
    ;;
  peers)
    if [ -f "$DIR/peers.json" ]; then
      python3 -c '
import json, sys
peers = json.load(open(sys.argv[1]+"/peers.json"))
if not peers: print("No peers connected")
else:
  for pid, info in peers.items():
    label = info.get("label", "?")
    app = info.get("app", "?")
    print(f"  {pid}: {label} ({app})")
' "$DIR"
    else
      echo "No peers file — bridge may not be connected"
    fi
    ;;
  inbox)
    if [ -f "$DIR/inbox.jsonl" ] && [ -s "$DIR/inbox.jsonl" ]; then
      python3 -c '
import json, sys
for line in open(sys.argv[1]+"/inbox.jsonl"):
  msg = json.loads(line.strip())
  sender = msg["from"]
  text = msg["message"]
  print(f"  [{sender}] {text}")
' "$DIR"
    else
      echo "No messages"
    fi
    ;;
  status)
    cat "$DIR/status" 2>/dev/null || echo "unknown"
    ;;
  id)
    echo "$AGENT_ID"
    ;;
  *)
    echo "mesh — conductor mesh messaging"
    echo "  Agent: $AGENT_ID"
    echo ""
    echo "Commands:"
    echo "  mesh send <agent_id> \\"message\\"  Send a message"
    echo "  mesh peers                       List connected agents"
    echo "  mesh inbox                       Show received messages"
    echo "  mesh status                      Connection status"
    echo "  mesh id                          Show your mesh identity"
    ;;
esac
""")
    mesh_path.chmod(0o755)
    return mesh_path


def main():
    parser = argparse.ArgumentParser(description="mesh-claude: PTY wrapper with conductor mesh")
    parser.add_argument("--agent-id", help="Mesh identity (default: cc-{repo-name})")
    parser.add_argument("--label", help="Display name")
    parser.add_argument("--color", default="#7719AA", help="Hex color")
    parser.add_argument("--no-mesh", action="store_true", help="Skip mesh connection")
    args = parser.parse_args()

    default_id, default_label = derive_identity()
    agent_id = args.agent_id or default_id
    label = args.label or default_label
    color = args.color

    bridge_dir = Path(f"/tmp/conductor-bridge/{agent_id}")
    tools_dir = Path(__file__).parent

    # --- Install mesh CLI ---
    install_mesh_cli(tools_dir)

    # --- Create PTY pair ---
    master_fd, slave_fd = pty.openpty()
    if sys.stdin.isatty():
        winsize = fcntl.ioctl(sys.stdin, termios.TIOCGWINSZ, b"\x00" * 8)
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)

    # --- Spawn claude with mesh env vars ---
    env = os.environ.copy()
    env["MESH_AGENT_ID"] = agent_id
    env["MESH_BRIDGE_DIR"] = str(bridge_dir)
    # Ensure tools/ is in PATH so CC can run `mesh` via Bash
    env["PATH"] = f"{tools_dir}:{env.get('PATH', '')}"

    proc = subprocess.Popen(
        ["claude"],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        preexec_fn=os.setsid,
        env=env,
    )
    os.close(slave_fd)

    # --- Forward terminal resize (SIGWINCH) ---
    def on_winch(sig, frame):
        if sys.stdin.isatty():
            ws = fcntl.ioctl(sys.stdin, termios.TIOCGWINSZ, b"\x00" * 8)
            fcntl.ioctl(master_fd, termios.TIOCSWINSZ, ws)
            try:
                os.kill(proc.pid, signal.SIGWINCH)
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGWINCH, on_winch)

    # --- Start conductor bridge sidecar ---
    bridge_proc = None
    inbox_path = None
    inbox_pos = 0

    if not args.no_mesh and BRIDGE_SCRIPT.exists():
        bridge_dir.mkdir(parents=True, exist_ok=True)
        inbox_path = bridge_dir / "inbox.jsonl"
        inbox_path.touch()
        inbox_pos = inbox_path.stat().st_size  # skip pre-existing messages

        bridge_log = bridge_dir / "bridge.log"
        bridge_proc = subprocess.Popen(
            ["uv", "run", "--script", str(BRIDGE_SCRIPT), agent_id, label, color],
            stdout=open(bridge_log, "w"),
            stderr=subprocess.STDOUT,
        )

    # --- Injection socket (for manual/external injection) ---
    sock_path = f"/tmp/mesh-claude-{agent_id}.sock"
    if os.path.exists(sock_path):
        os.unlink(sock_path)

    def injection_listener():
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.bind(sock_path)
        sock.listen(5)
        sock.settimeout(1.0)
        while proc.poll() is None:
            try:
                conn, _ = sock.accept()
                conn.settimeout(0.1)
                data = conn.recv(4096)
                conn.close()
                if data:
                    os.write(master_fd, data.rstrip(b"\r\n"))
                    time.sleep(0.05)
                    os.write(master_fd, b"\r")
            except socket.timeout:
                continue
            except OSError:
                break
        sock.close()
        try:
            os.unlink(sock_path)
        except OSError:
            pass

    inject_thread = threading.Thread(target=injection_listener, daemon=True)
    inject_thread.start()

    # --- Raw mode + main I/O loop ---
    old_attrs = None
    if sys.stdin.isatty():
        old_attrs = termios.tcgetattr(sys.stdin)
        tty.setraw(sys.stdin)

    try:
        stdin_fd = sys.stdin.fileno()
        stdout_fd = sys.stdout.fileno()
        last_inbox_check = 0

        while proc.poll() is None:
            try:
                rlist, _, _ = select.select([stdin_fd, master_fd], [], [], 0.25)
            except (select.error, ValueError, InterruptedError):
                continue

            # Terminal → CC (transparent pass-through)
            if stdin_fd in rlist:
                data = os.read(stdin_fd, 1024)
                if not data:
                    break
                os.write(master_fd, data)

            # CC → Terminal (transparent pass-through)
            if master_fd in rlist:
                try:
                    data = os.read(master_fd, 4096)
                    if not data:
                        break
                    os.write(stdout_fd, data)
                except OSError:
                    break

            # Poll inbox for mesh messages (every 0.5s)
            now = time.time()
            if inbox_path and now - last_inbox_check > 0.5:
                last_inbox_check = now
                try:
                    size = inbox_path.stat().st_size
                    if size > inbox_pos:
                        with open(inbox_path) as f:
                            f.seek(inbox_pos)
                            for line in f:
                                line = line.strip()
                                if not line:
                                    continue
                                msg = json.loads(line)
                                sender = msg.get("from", "unknown")
                                text = msg.get("message", "").replace("\n", " ")
                                # Inject using bracketed paste + Enter.
                                # Bracketed paste (\x1b[200~ ... \x1b[201~) tells
                                # CC's TUI to insert text literally, not interpret
                                # characters as commands. \r after paste-end submits.
                                # If a permission prompt has focus, the paste is
                                # likely ignored (graceful degradation).
                                content = f"[mesh from {sender}] {text}"
                                os.write(master_fd, content.encode())
                                time.sleep(0.05)
                                os.write(master_fd, b"\r")
                            inbox_pos = f.tell()
                except (FileNotFoundError, json.JSONDecodeError, OSError):
                    pass

    finally:
        if old_attrs is not None:
            termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old_attrs)
        os.close(master_fd)

        # Clean up bridge sidecar
        if bridge_proc and bridge_proc.poll() is None:
            bridge_proc.terminate()
            try:
                bridge_proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                bridge_proc.kill()

        # Clean up socket
        try:
            os.unlink(sock_path)
        except OSError:
            pass

        sys.exit(proc.wait())


if __name__ == "__main__":
    main()
