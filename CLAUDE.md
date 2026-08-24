# Aboyeur — Project Context

Multi-session orchestrator, now riding CC-native loop primitives (the revival direction, aby-degeki). The hand-rolled scheduling column — SQLite trigger queue, polling loops, cron poller, daemon entry point, systemd unit — was **deleted 2026-08-24 (aby-cazete)**; none of it was ever deployed. What orchestrates today: an orchestrating session's own control flow (the estate's `~/.claude/loop.md` rhythm) spawning fresh-context worker/reflector roles via the Agent tool, **handoff files as the protocol between sessions**, bons as the inbox, and CronCreate ticks for cadence. The responsibility-by-responsibility port is `docs/native-loop-map-2026-08-24.md`. Claudes communicate as **peers** — no hierarchy, no management layer — over handoff files, bons, and `sonner` for anything that cannot wait for the next session start.

**Aboyeur is one thing now, not two.** It was an orchestrator *and* a mesh; the mesh was deleted on 2026-08-24 (see "The mesh — REMOVED" below). What remains is orchestration on CC-native primitives, which is a sharpening rather than a loss — but it means more than half this repo's source is in the history rather than the tree, and several board items still speak as if the mesh were live. `aby-nedora` is adjudicating those.

Read `docs/architecture-decisions.md` for the pre-native design rationale (historical since 2026-08-24).

## Architecture

```
Orchestrating session (loop.md rhythm; no daemon, no SQLite)
  ├── alternation: sequential Agent() calls — worker role, then reflector role
  ├── protocol: handoff files on disk (newest = next session's brief)
  ├── tick checks: bon-hash drift (stuck?), anchored HUMAN REVIEW NEEDED: (escalate?)
  ├── cadence: CronCreate ticks (session-scoped — see the map's residue list)
  └── health: HEARTBEAT.md as a native scheduled-task prompt (aby-gonida)

Claudes (peers — same machine, no hierarchy)
  ├── peer reviewer: read code, report observations, exit
  ├── beat worker: autonomous code task (beat.ts pattern)
  └── all coordinate via bons, handoff files, and sonner
```

### Communication — Transport Shapes Dynamics

How a message arrives determines how Claude treats it:

| Channel | Arrives as | Dynamic |
|---------|-----------|---------|
| `sonner` | Peer message on the inbox socket | Peer — honest exchange, no ranking |
| Guéridon stdin | User message | Authority — trained deference |
| .inbox/ file | Read during /open | Neutral — evaluative |

Use sonner for peer-to-peer, stdin for authority/direction. Don't mix them.

**This table is the durable idea here, and it survived the transport underneath it.** The conductor mesh delivered peer messages as `<channel>` tags; sonner delivers them over a unix socket. Different wire, same dynamic — which is exactly why sonner refuses to pass a message as a spawned session's *prompt*: that would move it into row two and make a peer read as the user.

### Session Naming Convention

| Session type | Pattern | Example |
|---|---|---|
| One-shot | `oneshot-{trigger}-{HHMMSS}` | `oneshot-gmail-203022` |
| Peer reviewer | `reviewer-{target}-{HHMMSS}` | `reviewer-aboyeur-203015` |
| Beat worker | `worker-{action-id}-{seq}` | `worker-aby-sanimu-01` |
| Beat reflector | `reflector-{action-id}-{seq}` | `reflector-aby-sanimu-01` |

### The Beat Pattern (autonomous code tasks)

beat.ts implements a worker→reflector cycle for unsupervised code work. This is one pattern among several, not the organising architecture:

```
bon work <action-id>
  → spawn worker (80 turns, full tool access)
    → worker finishes, writes handoff
  → spawn reflector (40 turns, no Edit tool)
    → writes .beat/APPROVED or .beat/ISSUES.md
  → approved? bon done, pick next action
  → rejected? spawn new worker with fix instructions
```

### GTD Mapping

| GTD | Aboyeur equivalent |
|---|---|
| Standalone next action | One-shot session (sonner ring or Agent spawn) → done |
| Project (multi-step) | Sequence of peer sessions coordinated via bons |
| Areas of focus / goals | Bon outcomes |
| Weekly review | HEARTBEAT native loop (`HEARTBEAT.md` on a CronCreate task — no daemon) |

### Key Files

| File | Purpose | Sensitivity |
|------|---------|-------------|
| `src/spawn-agent.ts` | spawnAgent() — spawn claude, collect output, resume sessions | High — beat.ts's spawner |
| `src/beat.ts` | The beat pattern — autonomous code task loop over spawnAgent | High |
| `src/index.ts` | Barrel export (spawnAgent only, since aby-cazete) | Low |
| `docs/architecture-decisions.md` | Design decisions and rejected alternatives | High — prevents re-derivation |
| `shared/prompts/reflector-open.md` | Reflector instructions (code/work review) | High — sycophancy risk if weakened |
| `shared/prompts/planning-reflector.md` | Planning reflector (architecture review) | High — catches assumption errors |
| `shared/prompts/worker-open.md` | Worker instructions | Medium |
| `shared/prompts/legacy/` | Retired prompts: sidecar-era mesh-awareness, daemon-era aboyeur-open + email-triage (retired with the trigger path, aby-cazete) | Low |
| `HEARTBEAT.md` | Self-contained health-check prompt for a native CronCreate loop (ported off the daemon cron 2026-08-24, aby-gonida) | Low |

### The mesh — REMOVED 2026-08-24 (son-pilalu / aby-nedora)

Aboyeur used to carry a second, separate limb: a WebSocket bridge to Anthropic's
conductor mesh, shipped to the world as the **sonnette** plugin. **All of it is
gone** — `conductor-bridge.ts`, `conductor-channel.ts`, `mesh-capability.ts`,
`mesh-id.ts`, their tests, the `sonnette/` bundle, `.mcp.json` and the
`sonnette-bundle-fresh` CI job. Deleted in `4f41e80`; `git show 4f41e80^` has
every line of it. **`docs/MESH-SETUP.md` is deliberately KEPT** as a historical
record, at `aby-dunudo`'s request — its delivery-semantics measurements explain
why the honesty bar for the successor was set where it was. It carries a header
saying nothing in it is runnable.

> **`conductor.sh` is NOT part of that and was never mesh code** — it is the
> worker/reflector loop this repo is named for, and it contains zero mesh
> references. It was deleted by mistake in `4f41e80` on a name collision
> ("conductor.sh" vs "conductor-channel.ts") and restored immediately after.
> If you are pruning here, that shared word is the tripwire: the *channel* is
> the mesh, the *shell script* is the orchestrator.

**Why:** Sameer delisted sonnette from the batterie marketplace, then chose deletion
over freezing. Measured conductor-channel traffic had stopped on 2026-07-19 — five
weeks dead — and keeping the code meant a CI job policing an artefact nobody ships
plus a rebuild-the-bundle rule nagging every future edit.

**Peer messaging is `sonner` now** (`spm1001/sonner`), and it is not a mesh: it rings
a *repo* over a unix socket, spawning a session if none is home.

**Cross-machine reach is NOT lost — correcting a claim this file briefly carried.**
sonner is machine-local in *discovery*, which reads like "no cross-machine messaging",
and on 2026-08-24 a session wrote exactly that here before finding `aby-dunudo`, which
had recorded the successor on 2026-08-09: you reach another host by running sonner
there, `ssh <host> sonner <repo> '<msg>'`, demonstrated tube→Mac into a live session
that day and re-verified over non-interactive ssh on 2026-08-24. What genuinely
narrowed is *ambient* presence — a remote peer will not appear in a local `--list`,
and you must know which host to reach. The one capability with no successor at all is
Office-Claude interop, dropped knowingly. Full ledger: `docs/mesh-retirement-2026-08-24.md`.

**What this means for the code that stayed.** The excision was clean — `index.ts`,
`beat.ts` and `spawn-agent.ts` imported no mesh module. `spawnAgent()` lost its
`meshAgentId` / `meshRole` options and the channel flag they added. `MESH_DISABLED=1`
is still set unconditionally on spawn, deliberately: nothing here reads it any more,
but an older conductor-channel could still be installed somewhere on the estate, and
a spawned session inheriting a live one would mint an unwanted identity.

**Do not rebuild this from the history without reading `aby-nedora` first.** Several
board items still describe the mesh as live; they are being adjudicated, not honoured.

**One lesson from that work outlives it, and is not mesh-specific:** `claude -p` is a
different product surface from an interactive session — inbound tags, dialogs and the
statusline do not exist there, so a headless green proves nothing about the TUI. Use
the **`hublot`** skill (trousse) to drive and observe a real interactive session.

### Reference Implementations (crib from these)

| Pattern | Where to look |
|---------|---------------|
| Spawn + env-var stripping | `~/Repos/gueridon/server/bridge.ts:326-345` (THE primary reference) |
| Session resume logic | `~/Repos/gueridon/server/bridge-logic.ts` (buildCCArgs, resolveSessionForFolder) |
| Gueridon bridge API | `~/Repos/gueridon/server/bridge.ts` (session lifecycle: spawn, list, kill, events) |
| Orphan process management | `~/Repos/gueridon/server/orphan.ts` |
| Event parsing | `~/Repos/gueridon/server/state-builder.ts` |

## Invocation-log attribution (erg-konewa, 2026-08-24)

The estate's invocation-log shim (spm1001/harness-ergonomics, `shim/invocation_log.py`)
stamps every instrumented CLI call — bon, passe, accomplis, deglacer, sonner, glaneur —
with `caller=robot` + the parent process's `/proc` comm when no CC env and no tty is
present. Aboyeur itself has **nothing to vendor the shim into**: it is not an installed
CLI — post-cazete there is no daemon, no console script, no Python; the orchestrator is
a Claude session (whose own CLI calls stamp `model` via env) plus two dev-run surfaces.
Attribution of aboyeur-driven robot calls therefore arrives via the *adopted tools'*
parent-comm stamp, and both surfaces are now covered:

- **conductor.sh** needs nothing: a shebang script's children see the script name as
  parent comm (probed 2026-08-24 — comm truncates at 15 chars; "conductor.sh" fits),
  so its `bon list` calls already stamp `robot/conductor.sh`.
- **beat.ts** sets `process.title = "aboyeur"` (node's title setter writes comm) and
  calls bon via `execFileSync` — `execSync` interposes `/bin/sh -c`, which makes bon's
  parent "sh" and destroys the attribution. Keep both halves if you touch these calls:
  title without direct spawn stamps `robot/sh`; direct spawn without title stamps
  `robot/node`. Verified against the real instrumented bon:
  `{"caller":"robot","caller_detail":"aboyeur"}`.

If aboyeur ever regrows an installed CLI (a daemon revival), that is the moment it
adopts the shim properly — vendor + conformance line in harness-ergonomics, per that
repo's CLAUDE.md checklist.

## Conventions

- **TypeScript** for all new code
- **Gueridon's spawn pattern** for session spawning (`claude` CLI + stream-json, via spawnAgent)
- **Gueridon bridge API** for session lifecycle (spawn, list, kill, events)
- **Max subscription** auth for all agents
- **Bon `--json`** for structured work state (not markdown parsing)
- Prompts: direct, concrete instructions over abstract principles
- The conductor should stay lean — complexity belongs in environment files (CLAUDE.md, handoffs, bon), not the orchestrator

## Dependencies

- **claude CLI** — session spawning via stream-json
- **Bon CLI** (`bon`) — work tracking, structured state via `--json`
- **Mise** (`~/Repos/mise-en-space/`) — Google Workspace MCP (email draft/reply/fetch)
- **Gueridon** (`~/Repos/gueridon/`) — bridge API for session lifecycle (spawn, list, kill, events)

## Testing

`npm test` = 4 node tests (spawn-agent). It was 13 node + 10 bun until 2026-08-24; the missing 19 were all mesh and went with it (`4f41e80`), which is the honest measure of how much of this repo was the mesh. The daemon integration suite went earlier with the daemon (aby-cazete) — its patterns live on in git history pre-`refactor!: delete the SQLite trigger path`. CI runs `npm test` as of 2026-08-24; before that it only typechecked.

## Status

Pre-alpha, mid-revival, and **narrower than it was**. Two limbs became one on 2026-08-24: the mesh was deleted outright (`4f41e80`, son-pilalu / aby-nedora) after sonnette was delisted from the batterie marketplace, so what remains is orchestration on CC-native primitives. The SQLite daemon column went the same day (aby-cazete; never deployed), leaving HEARTBEAT on a scheduled task (aby-gonida) and the worker/reflector cycle proven on Agent-tool control flow (aby-dujato, map in `docs/native-loop-map-2026-08-24.md`). `npm test` = 4 node tests, CI green.

**The board is mid-adjudication and you should not trust it yet.** Thirteen of fourteen open items were mesh items when the mesh was deleted, including three whole outcomes: `aby-cusera` ("every session born on the mesh") and `aby-jepezu` ("mesh transport quiet, truthful, observable") are dead, and `aby-suloro` ("every Claude can see, consult and wake any other") is **achieved** — by sonner, in another repo, which is a different verdict from abandoned. `aby-nedora` holds the triage. Until it is worked, an open item here is not evidence that its subject exists.

**Worth carrying out of the mesh work:** `aby-sahifi`'s principle, which outlived its transport — *the fault is not that send-only sessions exist, it is that they are indistinguishable from absent ones.* That is now sonner's live problem, measured there as five of eight sessions on tube being deaf, and it moved to `son-nukuzi`.
