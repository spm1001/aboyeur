#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""sonner — ring a repo, and a Claude answers.

Native cross-session messaging (Claude Code >=2.1.224) delivers between sessions that
are *already running*. There is no store-and-forward and no spawn-on-demand: a message
to a repo nobody is sitting in is simply undeliverable.

sonner closes that gap. Give it a repo and a message:

    sonner ~/repos/spm1001/infra "the deadman for notes-sync went red"

If a live session is already in that repo, the message is delivered to its inbox socket.
If none is, sonner starts one under tmux, waits for its socket, and then delivers the
same message. Either way the receiving Claude sees an ordinary peer message and wakes.

Why spawn-then-deliver rather than passing the text as the new session's prompt: a prompt
reads as the *user* speaking, which invites deference. Delivering over the socket keeps
the peer framing, so the woken Claude treats it as a colleague's note and applies the
harness's own peer guardrails (a peer cannot approve permissions or change config).

    sonner REPO MESSAGE [--from NAME] [--all] [--no-spawn] [--no-stamp] [--list]

Every message carries a timestamp, because Claude Code silently drops a message whose
text is byte-identical to a recent one from the same sender while still reporting
success. A fixed-text heartbeat would vanish with nothing to see. The stamp makes that
class of loss impossible rather than merely documented; --no-stamp opts out.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import NamedTuple


class Session(NamedTuple):
    pid: int
    cwd: Path | None  # None: reachable but unplaceable (no record, no /proc)
    socket: Path
    name: str
    started: int


def socket_dirs() -> list[Path]:
    """Where sessions bind inbox sockets — the machine-wide ground truth.

    Every session on the machine binds here regardless of which config dir it
    runs under, so this is the roster; registry records are only an enrichment.
    """
    dirs = []
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime:
        dirs.append(Path(runtime) / "cc-socks")
    dirs.append(Path("/tmp") / f"cc-socks-{os.getuid()}")  # macOS and no-XDG fallback
    return [d for d in dirs if d.is_dir()]


def session_records() -> dict[int, dict]:
    """Session records by pid, swept across every config dir on the machine.

    Each session writes <pid>.json under ITS OWN config dir's sessions/ — so a
    session running with CLAUDE_CONFIG_DIR=~/.claude-commis registers there, not
    in ~/.claude. Reading only one registry silently hides every session homed in
    another (which is exactly how the first ~/notes/work ring was lost: sonner
    inherited the caller's CLAUDE_CONFIG_DIR and watched the wrong letterbox for
    90 seconds while the spawned session registered in the default one).
    """
    home = Path.home()
    config_dirs = {home / ".claude", *home.glob(".claude-*")}
    env = os.environ.get("CLAUDE_CONFIG_DIR")
    if env:
        config_dirs.add(Path(env))

    records: dict[int, dict] = {}
    for config in config_dirs:
        for record in (config / "sessions").glob("*.json"):
            try:
                r = json.loads(record.read_text())
                records[int(r["pid"])] = r
            except (OSError, ValueError, KeyError):
                continue
    return records


def live_sessions() -> list[Session]:
    """Every reachable session, newest first: sockets for truth, records for names.

    A bound socket whose pid is alive IS a session, whether or not any record
    describes it. The record adds the addressable name and (on machines without
    /proc) the cwd; a record without a socket is a dead session's leavings.
    """
    records = session_records()
    found = []
    for sock in (s for d in socket_dirs() for s in d.glob("*.sock")):
        try:
            pid = int(sock.stem)
            os.kill(pid, 0)
        except (ValueError, ProcessLookupError):
            continue  # not a session socket, or its process is gone
        except PermissionError:
            pass  # alive, just not ours to signal

        r = records.get(pid, {})
        cwd = r.get("cwd")
        if cwd is None:
            try:
                cwd = os.readlink(f"/proc/{pid}/cwd")
            except OSError:
                pass  # no record and no /proc: reachable but unplaceable
        found.append(
            Session(
                pid=pid,
                cwd=Path(cwd) if cwd else None,
                socket=sock,
                name=r.get("name") or f"pid-{pid}",
                started=int(r.get("startedAt", 0)) or int(sock.stat().st_mtime * 1000),
            )
        )

    found.sort(key=lambda s: s.started, reverse=True)
    return found


def sessions_in(repo: Path) -> list[Session]:
    """Sessions whose cwd is the repo or somewhere inside it."""
    return [s for s in live_sessions() if s.cwd and (s.cwd == repo or repo in s.cwd.parents)]


def deliver(sock_path: Path, body: str, sender: str) -> None:
    """Write one message envelope to a session's inbox socket.

    The wire format is a single line of JSON. `from` is sender-authored — Claude Code
    keys real identity on the kernel-verified pid of the connecting process, so this
    field is for reply routing and display only.
    """
    envelope = {
        "msgV": 1,
        "msg_id": str(uuid.uuid4()),
        "type": "user",
        "message": {
            "role": "user",
            "content": (
                f'<cross-session-message from="script:{sender}" '
                f'from-name="{sender}" from-mode="prompting">\n'
                f"{body}\n"
                "</cross-session-message>"
            ),
        },
        "priority": "next",
        "from": f"script:{sender}",
    }
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.connect(str(sock_path))
        s.sendall((json.dumps(envelope) + "\n").encode())


def spawn(repo: Path, timeout: float = 180.0) -> Session:
    """Start a session in `repo` under tmux and wait for its inbox socket.

    Returns the new session once it is reachable. The session is left running and
    detached, so it can be attached to later and messaged again. The wait is
    generous because a session start runs hooks and orientation before binding.
    """
    tmux_name = f"sonner-{repo.name}"
    if subprocess.run(["tmux", "has-session", "-t", tmux_name], capture_output=True).returncode == 0:
        tmux_name = f"{tmux_name}-{os.getpid()}"  # earlier ring left its window open
    before = {s.socket for s in live_sessions()}

    subprocess.run(
        ["tmux", "new-session", "-d", "-s", tmux_name, "-c", str(repo), "claude"],
        check=True,
    )

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for session in sessions_in(repo):
            if session.socket not in before:
                return session
        time.sleep(0.5)

    raise TimeoutError(
        f"session started in tmux '{tmux_name}' but bound no inbox socket within "
        f"{timeout:.0f}s — attach with 'tmux attach -t {tmux_name}' to see why"
    )


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("repo", nargs="?", help="repo to ring")
    p.add_argument("message", nargs="?", help="what to say")
    p.add_argument("--from", dest="sender", default="sonner", help="sender name shown to the receiver")
    p.add_argument("--all", action="store_true", help="ring every session in the repo, not just the newest")
    p.add_argument("--no-spawn", action="store_true", help="fail rather than start a session")
    p.add_argument(
        "--no-stamp",
        dest="stamp",
        action="store_false",
        help="omit the timestamp — only for one-off messages you will never repeat",
    )
    p.add_argument("--list", action="store_true", help="show reachable sessions and exit")
    args = p.parse_args()

    if args.list:
        sessions = live_sessions()
        if not sessions:
            print("no reachable sessions")
        for s in sessions:
            print(f"{s.name:<20} {s.pid:>8}  {s.cwd}")
        return 0

    if not args.repo or not args.message:
        p.error("repo and message are both required (or use --list)")

    repo = Path(args.repo).expanduser().resolve()
    if not repo.is_dir():
        print(f"not a directory: {repo}", file=sys.stderr)
        return 2

    body = args.message
    if args.stamp:
        body = f"{body}\n\n[{datetime.now(timezone.utc).isoformat(timespec='milliseconds')}]"

    targets = sessions_in(repo)
    spawned = False

    if not targets:
        if args.no_spawn:
            print(f"no session in {repo} and --no-spawn given", file=sys.stderr)
            return 1
        print(f"no session in {repo} — starting one", file=sys.stderr)
        targets = [spawn(repo)]
        spawned = True
    elif not args.all:
        targets = targets[:1]

    for s in targets:
        deliver(s.socket, body, args.sender)
        how = "woke" if spawned else "rang"
        print(f"{how} {s.name} (pid {s.pid}) in {s.cwd}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
