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


def socket_dir() -> Path:
    """Where Claude Code binds per-session inbox sockets."""
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime:
        return Path(runtime) / "cc-socks"
    return Path("/tmp") / f"cc-socks-{os.getuid()}"


def live_sessions() -> list[tuple[int, Path, Path]]:
    """Every reachable session as (pid, cwd, socket_path), newest first.

    The socket filename is the session's pid, so /proc gives us its working
    directory — the only way a script can tell which repo a session is sitting in.
    """
    found = []
    for sock in socket_dir().glob("*.sock"):
        try:
            pid = int(sock.stem)
            cwd = Path(os.readlink(f"/proc/{pid}/cwd"))
        except (ValueError, OSError):
            continue  # not a session socket, or the process is gone
        found.append((pid, cwd, sock))
    found.sort(key=lambda s: s[2].stat().st_mtime, reverse=True)
    return found


def sessions_in(repo: Path) -> list[tuple[int, Path, Path]]:
    """Sessions whose cwd is the repo or somewhere inside it."""
    return [s for s in live_sessions() if s[1] == repo or repo in s[1].parents]


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


def spawn(repo: Path, timeout: float = 90.0) -> tuple[int, Path, Path]:
    """Start a session in `repo` under tmux and wait for its inbox socket.

    Returns the new session once it is reachable. The session is left running and
    detached, so it can be attached to later and messaged again.
    """
    tmux_name = f"sonner-{repo.name}"
    before = {s[2] for s in live_sessions()}

    subprocess.run(
        ["tmux", "new-session", "-d", "-s", tmux_name, "-c", str(repo), "claude"],
        check=True,
    )

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for session in sessions_in(repo):
            if session[2] not in before:
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
        for pid, cwd, sock in sessions:
            print(f"{pid:>8}  {cwd}")
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

    for pid, cwd, sock in targets:
        deliver(sock, body, args.sender)
        how = "woke" if spawned else "rang"
        print(f"{how} pid {pid} in {cwd}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
