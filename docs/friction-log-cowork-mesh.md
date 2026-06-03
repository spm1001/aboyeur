# Friction log — joining the conductor mesh from Cowork

**Session:** 2026-05-07, Cowork mode (Claude Desktop sandbox)
**Goal:** run `src/conductor-bridge.ts` from inside Cowork, list peers, exchange a hello, deregister.
**Result:** **blocked at credential resolution**. Bridge starts, opens its IPC dir, then fails at `readFileSync('~/.claude/.credentials.json')` and enters retry-backoff. WS handshake never attempted.

---

## What I tried

Probed the sandbox (Linux aarch64, Ubuntu 22, Node v22.22.0), read `docs/MESH-SETUP.md` and `src/conductor-bridge.ts`, then invoked the bridge directly:

```
cd /sessions/.../mnt/aboyeur
node --experimental-strip-types src/conductor-bridge.ts \
  cowork-friction-test 'Cowork Friction Test' '#FF8800' 'cowork-friction'
```

Output (verbatim, three retries before SIGTERM):

```
[cowork-friction-test] Connecting to conductor mesh...
[cowork-friction-test] Auth failed: ENOENT: no such file or directory,
   open '/sessions/focused-loving-brown/.claude/.credentials.json'.
   Retrying in 1000ms...
[cowork-friction-test] Auth failed: ... Retrying in 2000ms...
[cowork-friction-test] Auth failed: ... Retrying in 4000ms...
[cowork-friction-test] Closed
```

The IPC dir `/tmp/conductor-bridge/cowork-friction-test/` was created on first attempt, then cleaned up on exit. No `peers.json`, no `events.jsonl` — code path never got past `resolveAuth()`.

---

## Blockers (the data you actually want)

### 1. **Credentials are unreachable from the sandbox.** This is the wall.

The bridge's `resolveAuth()` is OS-conditional:
- `darwin` → reads macOS Keychain via `security find-generic-password`
- otherwise → `readFileSync('~/.claude/.credentials.json')`

The Cowork sandbox is **Linux** (`uname -a` returns `Linux claude 6.8.0-106-generic ... aarch64`). So the bridge takes the Linux branch. But:

- **HOME inside the sandbox is `/sessions/focused-loving-brown`**, not `/Users/modha`. There is no `.claude/` directory there.
- **The host Mac filesystem is not mounted.** `/Users/modha/.claude/` does not exist from inside bash. The only host-side mount visible is the workspace folder at `/sessions/focused-loving-brown/mnt/aboyeur/`. The CLAUDE.md system context says I can read this folder; I cannot reach `~/.claude/` on the Mac.
- **No `CLAUDE_CODE_OAUTH_TOKEN`** (or anything Anthropic-related) in env. `env | grep -i claude` returns only `CLAUDE_TMPDIR` / `CLAUDE_CODE_TMPDIR`.
- **The macOS Keychain is moot** even if I switched to the darwin branch — Keychain lives on the host, the sandbox is Linux, and `security` is a macOS-only binary.

Possible workarounds I deliberately did **not** take, per your instruction:
- Asking you to paste your OAuth token into chat. Sensitive credential, security-policy off-limits, and would be the wrong shape of help anyway — you'd then have it pasted into a transcript.
- Inventing a `CLAUDE_CODE_OAUTH_TOKEN` env hook that doesn't exist in the bridge today.
- Trying to scrape the token out of any Cowork-internal MCP. Did not look — felt like the kind of escalation you want to know is possible, not for me to silently attempt.

**This is the core question for the design:** there is no standard "give the sandbox a Claude OAuth token" mechanism. Until there is, Cowork Claudes can't dial the conductor mesh, full stop.

### 2. **Docs prescribe `npx tsx`; tsx is not installed and Node 22 doesn't need it.**

`docs/MESH-SETUP.md` and the file's own header say `npx tsx src/conductor-bridge.ts ...`. But:

- `node_modules/tsx` is absent (it's not a `package.json` dependency — only `typescript` is).
- `npx tsx` would download from the registry. The sandbox can reach `registry.npmjs.org` (HTTP 200), so this would work — but at the cost of a network round-trip every cold start.
- **Node v22 strips TS types natively with `--experimental-strip-types`.** That ran the bridge with no install, no flag-loaded loader, no tsx. Worth either updating the docs or building a `dist/` and shipping JS.

### 3. **`/tmp/conductor-bridge/` lives in the sandbox, not on the host.**

The bridge's filesystem IPC writes to `/tmp/conductor-bridge/{agent_id}/`. From the sandbox, that path is **inside the sandbox**, not the user's host `/tmp`. Implication: even if the bridge connected, anything else on the host that polls `/tmp/conductor-bridge/` (the PTY wrapper, `mesh` CLI, peer-review .inbox/ tooling) would see nothing. The two halves are partitioned.

There's no obvious way to expose the workspace mount as the bridge dir without changing the bridge to accept e.g. `BRIDGE_DIR=…` from env (it already accepts `bridgeDir` via the `BridgeOptions` constructor — the CLI just doesn't expose it).

---

## Things I had to guess at

- **Where HOME would be.** Docs assume macOS / Linux dev box. Sandbox HOME is `/sessions/focused-loving-brown` — found by inspection, not docs.
- **Whether host `/Users/modha/...` is mounted.** Tried, isn't. The only mount is the workspace folder I'm rooted in.
- **Whether `CLAUDE_CODE_OAUTH_TOKEN` (or similar) is the official Cowork hook.** No env var I checked is set; nothing in the bridge looks for one. So either it's not the convention or it's not wired.
- **Whether the `mesh` CLI inside CC reaches across the sandbox boundary.** I am not running inside a `claude-mesh` PTY here — I'm a Cowork Claude. The `mesh` slash-command flow assumes a PTY wrapper that doesn't exist here.

---

## Things that worked but felt awkward

- **`HTTP 426` from the bridge host** is the right answer (WebSocket-only endpoint refusing a plain HTTP HEAD), but the failure mode is silent — no obvious "yes this is reachable" check in the bridge or docs short of running it. A `bridge ping` subcommand that hits `wss://...` and returns "reachable / unauth / unreachable" would speed up triage.
- **`peer_online` vs `peer_offline` vs `expired` vs `reset`** — three close-flavours converge to a single "peer gone" event, but the protocol surface is wider than the friction-log-writer cares about. Knowing "is X actually there right now or did they 60-second-time-out" requires reading the bridge log, not just `peers.json`. A staleness column in `peers.json` (`last_seen_ms_ago`) would be cheaper than reading events.jsonl.
- **The CLI signature `<agent_id> <label> [<color>] [<fileName>]`** is positional and the fourth slot is hard to remember. Docs describe identity auto-generation (`cc-{repo}-{hex6}`) but the bare CLI doesn't do auto-generation — that lives in the `claude-mesh` wrapper. So a Cowork Claude invoking the bridge directly has to roll its own.
- **Default agent_id naming.** I picked `cowork-friction-test`. Whether peers should treat `cowork-*` as a recognised app-class isn't documented; I made it up. A registry of well-known agent_id prefixes (`cc-`, `office-`, `cowork-`?) would help peers route appropriately.

---

## What a "Cowork mesh" Skill should teach the next Claude

If we were to write a Skill for this, the must-haves:

1. **Pre-flight check.** A script that reports, in one go: `HOME`, presence of `~/.claude/.credentials.json`, presence of `$CLAUDE_CODE_OAUTH_TOKEN` (or whatever the eventual hook is), node version, `node_modules/ws` present, TLS reach to `bridge.claudeusercontent.com:443`, TLS reach to `api.anthropic.com:443`. Either all green → proceed; otherwise stop and emit exactly which check failed.
2. **The credential-injection contract.** Whatever path Anthropic blesses (env var, mounted secret, dedicated MCP), document it explicitly so future Cowork Claudes don't reinvent guesses. Right now there is no contract.
3. **Use `node --experimental-strip-types`, not `npx tsx`.** No network round-trip, no extra deps, identical result on Node 22+.
4. **`agent_id` convention for Cowork.** Suggest something like `cowork-{folder}-{hex6}` so peers can tell at a glance what's calling. Document whatever convention is chosen.
5. **`bridgeDir` should be configurable from the CLI.** If we want the host's PTY/mesh tooling to see Cowork's bridge state, the dir needs to be in the mounted workspace, not the sandbox `/tmp`. Add `--bridge-dir` to the CLI entrypoint at the bottom of `conductor-bridge.ts`.
6. **A peer-aware idle/stale signal.** Three event types resolve to "gone" but the friction log writer wants to know "is this peer responsive *right now*". Either expose `last_seen` per peer in `peers.json` or document that you have to grep `events.jsonl`.
7. **Deregister on graceful shutdown is already correct** (line 209-211 of the bridge: `deregister` sent before `ws.close()`, triggers ~12s `conductor_agent_reset` on peers instead of 60-120s expiry). Worth flagging in the Skill that SIGTERM is fine, SIGKILL leaves peers seeing you for up to two minutes.

---

## Summary

| Step | Status |
|---|---|
| Read bridge source + docs | ✅ |
| Sandbox FS reach (workspace mount, /tmp) | ✅ |
| Node 22 + `ws` available | ✅ |
| `tsx` installed | ❌ — not needed; Node 22 strips types natively |
| Network egress to `bridge.claudeusercontent.com:443` | ✅ (HTTP 426 = WS-only endpoint, expected) |
| Network egress to `api.anthropic.com:443` | ✅ |
| Network egress to `registry.npmjs.org`, `github.com` | ✅ |
| **Claude OAuth credentials accessible** | **❌ — fatal** |
| WS handshake | ❌ blocked upstream |
| List peers | ❌ blocked upstream |
| Send hello | ❌ blocked upstream |
| Deregister | ✅ (clean exit via SIGTERM, no IPC dir leak after cleanup) |

The single blocker is credentials. Everything else works or is trivially fixable. The interesting design question is therefore *not* "can a Cowork Claude run the bridge" — it's "what's the canonical way for Anthropic's sandboxes to hand their Claudes a usable OAuth token without exposing it in the transcript?"
