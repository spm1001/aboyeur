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
  │  │ I/O pass- │   │ bridge.ts      │   │
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

BRIDGE_SCRIPT = Path(__file__).parent.parent / "src" / "conductor-bridge.ts"


def derive_identity():
    """Derive mesh identity from current directory with unique suffix.

    Pattern mirrors Office Claudes: excel-d49606, powerpoint-b483e7.
    We produce: cc-aboyeur-a3f9e2, cc-trousse-7b1d04.
    """
    repo_name = Path.cwd().name.lower().replace(" ", "-")
    suffix = os.urandom(3).hex()  # 6 hex chars, ~16M combinations
    agent_id = f"cc-{repo_name}-{suffix}"
    label = f"{Path.cwd().name} (CC)"
    return agent_id, label


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
    parser.add_argument("--agent-id", help="Mesh identity (default: auto-generated cc-{repo}-{hex})")
    parser.add_argument("--label", help="Display name")
    parser.add_argument("--color", default="#7719AA", help="Hex color")
    parser.add_argument("--no-mesh", action="store_true", help="Skip mesh connection")
    parser.add_argument("--walkie-id", help="Walkie-talkie identity (enables local backchannel)")
    parser.add_argument("--walkie-partner", help="Walkie-talkie partner identity")
    args, claude_args = parser.parse_known_args()  # unknown flags pass through to claude

    default_id, default_label = derive_identity()
    agent_id = args.agent_id or default_id
    label = args.label or default_label
    color = args.color
    # Display name shown to peers in "Connected files".
    # Extract the short suffix from agent_id for display: cc-aboyeur-a3f9e2 → "aboyeur (a3f9e2)"
    repo_name = Path.cwd().name
    repo_prefix = f"cc-{repo_name.lower().replace(' ', '-')}-"
    if agent_id.startswith(repo_prefix):
        short_suffix = agent_id[len(repo_prefix):]
        display_name = f"{repo_name} ({short_suffix})"
    elif agent_id.removeprefix("cc-").lower() == repo_name.lower():
        display_name = repo_name
    else:
        display_name = f"{repo_name} ({agent_id.removeprefix('cc-')})"

    bridge_dir = Path(f"/tmp/conductor-bridge/{agent_id}")
    tools_dir = Path(__file__).parent

    # --- Install mesh CLI ---
    install_mesh_cli(tools_dir)

    # --- Create PTY pair ---
    master_fd, slave_fd = pty.openpty()
    if sys.stdin.isatty():
        winsize = fcntl.ioctl(sys.stdin, termios.TIOCGWINSZ, b"\x00" * 8)
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)

    # --- Spawn claude with mesh + walkie env vars ---
    env = os.environ.copy()
    env["MESH_AGENT_ID"] = agent_id
    env["MESH_BRIDGE_DIR"] = str(bridge_dir)
    # Ensure tools/ is in PATH so CC can run `mesh` and `walkie` via Bash
    env["PATH"] = f"{tools_dir}:{env.get('PATH', '')}"
    # Walkie-talkie backchannel (local agent-to-agent messaging via PostToolUse hook)
    if args.walkie_id:
        env["WALKIE_ID"] = args.walkie_id
        os.makedirs("/tmp/walkie", exist_ok=True)
    if args.walkie_partner:
        env["WALKIE_PARTNER"] = args.walkie_partner

    proc = subprocess.Popen(
        ["claude"] + claude_args,
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
            ["npx", "tsx", str(BRIDGE_SCRIPT), agent_id, label, color, display_name],
            stdout=open(bridge_log, "w"),
            stderr=subprocess.STDOUT,
            cwd=BRIDGE_SCRIPT.parent.parent,  # repo root, for node_modules resolution
            preexec_fn=os.setsid,  # own process group so cleanup kills the whole npx→node chain
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
        # Dedup removed from injection layer — the bridge handles time-windowed
        # dedup now, so inbox.jsonl won't contain conductor replay duplicates.
        # Keeping a set here would block legitimate repeat messages.
        start_time = time.time()
        mesh_orientation_sent = not bool(inbox_path)  # skip if no mesh
        last_prompt_seen = 0.0    # when CC last showed an idle prompt
        last_user_input = 0.0     # when user last typed something
        has_uncommitted_input = False  # user has typed something but not pressed Enter
        PROMPT_IDLE_MIN = 0.2     # wait 200ms after prompt before injecting
        USER_QUIET_MIN = 2.0      # wait 2s after last keystroke (safety margin)

        while proc.poll() is None:
            # Inject mesh orientation once CC has rendered its first prompt.
            # Waits for prompt detection rather than a fixed timer — safe
            # regardless of how long CC takes to initialise.
            if not mesh_orientation_sent and last_prompt_seen > 0 and \
               time.time() - last_prompt_seen > PROMPT_IDLE_MIN:
                mesh_orientation_sent = True
                # Set initial state so subsequent message injection can flow
                has_uncommitted_input = False
                last_user_input = 0.0
                # Build peer list from bridge's peers.json
                peer_summary = ""
                try:
                    peers = json.loads((bridge_dir / "peers.json").read_text())
                    if peers:
                        names = [f"{pid} ({info.get('file') or info.get('label', '?')})"
                                 for pid, info in peers.items()]
                        peer_summary = f" Peers online: {', '.join(names)}."
                except (FileNotFoundError, json.JSONDecodeError):
                    pass
                walkie_summary = ""
                if args.walkie_id and args.walkie_partner:
                    walkie_summary = (
                        f" Walkie backchannel: walkie send \"msg\" to {args.walkie_partner},"
                        f" walkie read, walkie log. Messages arrive via PostToolUse hook."
                    )
                orient = (
                    f"[mesh connected as {agent_id}]"
                    f" Commands: mesh send <id> \"msg\", mesh peers, mesh inbox, mesh status."
                    f"{peer_summary}{walkie_summary}"
                )
                os.write(master_fd, orient.encode())
                time.sleep(0.05)
                os.write(master_fd, b"\r")
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
                last_user_input = time.time()
                if data.endswith(b"\r") or data.endswith(b"\n"):
                    has_uncommitted_input = False
                else:
                    has_uncommitted_input = True

            # CC → Terminal (transparent pass-through)
            if master_fd in rlist:
                try:
                    data = os.read(master_fd, 4096)
                    if not data:
                        break
                    os.write(stdout_fd, data)
                    # Detect CC's idle prompt: ❯ (U+276F) or "> " at line start.
                    # When CC is ready for input, it renders the prompt character.
                    # We track this to gate message injection.
                    if b"\xe2\x9d\xaf" in data or b"\n> " in data or b"\r> " in data:
                        last_prompt_seen = time.time()
                        has_uncommitted_input = False  # fresh prompt = clean line
                except OSError:
                    break

            # Poll inbox for mesh messages (every 0.5s)
            # Only inject when CC is at an idle prompt and user isn't typing.
            # This prevents: message landing mid-response, colliding with
            # user typing ([Pasted Text] marker), or hitting a survey prompt.
            #
            # KEY FINDINGS from probe testing (16 Mar 2026):
            # - Single messages of ANY size (tested up to 8K) inject cleanly
            # - Paste blocks are caused by BURST delivery (multiple messages
            #   injected in rapid succession), not by message length
            # - Fix: inject ONE message per poll cycle, wait for next cycle
            now = time.time()
            prompt_age = now - last_prompt_seen
            user_quiet = now - last_user_input
            prompt_is_idle = (prompt_age > PROMPT_IDLE_MIN)
            # Three conditions for safe injection:
            # 1. CC has rendered a prompt (not mid-response)
            # 2. No uncommitted text on the input line (user not composing)
            # 3. Brief quiet period after last keystroke (debounce)
            # The uncommitted-input flag is the key insight: it distinguishes
            # "user paused to think mid-sentence" from "user is done."
            # Reset on: Enter, new prompt (Ctrl+C, CC response complete).
            user_is_quiet = (user_quiet > USER_QUIET_MIN) and not has_uncommitted_input

            if inbox_path and now - last_inbox_check > 0.5:
                last_inbox_check = now
                try:
                    size = inbox_path.stat().st_size
                    if size > inbox_pos:
                        if not (prompt_is_idle and user_is_quiet):
                            # Messages waiting but CC isn't idle — skip this
                            # poll cycle, we'll pick them up next time.
                            continue
                        # Inject ONE message per poll cycle to prevent paste
                        # block stacking. Remaining messages will be picked up
                        # on the next cycle (0.5s later).
                        with open(inbox_path) as f:
                            f.seek(inbox_pos)
                            for line in f:
                                line = line.strip()
                                if not line:
                                    continue
                                msg = json.loads(line)
                                sender = msg.get("from", "unknown")
                                text = msg.get("message", "").replace("\n", " ")
                                inbox_pos = f.tell()
                                content = f"[mesh from {sender}] {text}"
                                os.write(master_fd, content.encode())
                                time.sleep(0.05)
                                os.write(master_fd, b"\r")
                                break  # one message per cycle
                except (FileNotFoundError, json.JSONDecodeError, OSError):
                    pass

    finally:
        if old_attrs is not None:
            termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old_attrs)
        # Restore terminal state that stty alone can't fix:
        # - Exit alternate screen buffer (\e[?1049l)
        # - Show cursor (\e[?25h)
        # - Reset character attributes (\e[0m)
        # Without this, if claude dies without sending its cleanup escapes,
        # the terminal is stuck with no echo and no visible cursor.
        try:
            os.write(sys.stdout.fileno(), b"\033[?1049l\033[?25h\033[0m")
        except OSError:
            pass
        os.close(master_fd)

        # Clean up bridge sidecar (kill process group, not just top PID —
        # npx tsx spawns a chain: npx → sh → node tsx → node, and killing
        # only the top leaves orphans on the mesh)
        if bridge_proc and bridge_proc.poll() is None:
            try:
                os.killpg(os.getpgid(bridge_proc.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                bridge_proc.terminate()
            try:
                bridge_proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(bridge_proc.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    bridge_proc.kill()

        # Clean up socket
        try:
            os.unlink(sock_path)
        except OSError:
            pass

        # proc.wait() returns negative values for signal deaths (-SIGTERM = -15).
        # sys.exit() with negative ints is undefined behaviour in some contexts.
        # Map to 128+signal (POSIX convention) or 0 for clean exit.
        rc = proc.wait()
        sys.exit(max(rc, 0) if rc >= 0 else 128 + abs(rc))


if __name__ == "__main__":
    main()
