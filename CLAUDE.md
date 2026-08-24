# Aboyeur — Project Context

Multi-session orchestrator, now riding CC-native loop primitives (the revival direction, aby-degeki). The hand-rolled scheduling column — SQLite trigger queue, polling loops, cron poller, daemon entry point, systemd unit — was **deleted 2026-08-24 (aby-cazete)**; none of it was ever deployed. What orchestrates today: an orchestrating session's own control flow (the estate's `~/.claude/loop.md` rhythm) spawning fresh-context worker/reflector roles via the Agent tool, **handoff files as the protocol between sessions**, bons as the inbox, and CronCreate ticks for cadence. The responsibility-by-responsibility port is `docs/native-loop-map-2026-08-24.md`. Claudes communicate as **peers** via the Anthropic conductor mesh (`<channel>` tags) — no hierarchy, no management layer.

Read `docs/architecture-decisions.md` for the pre-native design rationale (historical since 2026-08-24).

## Architecture

```
Orchestrating session (loop.md rhythm; no daemon, no SQLite)
  ├── alternation: sequential Agent() calls — worker role, then reflector role
  ├── protocol: handoff files on disk (newest = next session's brief)
  ├── tick checks: bon-hash drift (stuck?), anchored HUMAN REVIEW NEEDED: (escalate?)
  ├── cadence: CronCreate ticks (session-scoped — see the map's residue list)
  └── health: HEARTBEAT.md as a native scheduled-task prompt (aby-gonida)

Claudes (peers on the conductor mesh)
  ├── peer reviewer: read code, send observations via mesh, exit
  ├── conversational: two Claudes discuss a design decision
  ├── beat worker: autonomous code task (beat.ts pattern)
  └── all coordinate via bons and mesh — no management layer
```

### Communication — Transport Shapes Dynamics

How a message arrives determines how Claude treats it:

| Channel | Arrives as | Dynamic |
|---------|-----------|---------|
| Conductor mesh (Channels MCP) | `<channel>` tag | Peer — honest exchange, no ranking |
| Guéridon stdin | User message | Authority — trained deference |
| .inbox/ file | Read during /open | Neutral — evaluative |

Use mesh for peer-to-peer, stdin for authority/direction. Don't mix them.

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
| `src/conductor-bridge.ts` | WebSocket bridge to Anthropic's conductor mesh — ConductorBridge class (transport layer, used by conductor-channel.ts) | High — mesh infrastructure |
| `src/conductor-channel.ts` | MCP Channels server wrapping ConductorBridge — CC loads via `--dangerously-load-development-channels server:conductor-channel` | High — mesh integration |
| `src/mesh-capability.ts` | `detectMeshCapability()` — can this session surface inbound, or is it send-only? Pure function over (env, parent argv); statusline.sh mirrors it in bash | High — gates what we advertise on the wire |
| `src/index.ts` | Barrel export (spawnAgent only, since aby-cazete) | Low |
| `docs/architecture-decisions.md` | Design decisions and rejected alternatives | High — prevents re-derivation |
| `shared/prompts/reflector-open.md` | Reflector instructions (code/work review) | High — sycophancy risk if weakened |
| `shared/prompts/planning-reflector.md` | Planning reflector (architecture review) | High — catches assumption errors |
| `shared/prompts/worker-open.md` | Worker instructions | Medium |
| `shared/prompts/legacy/` | Retired prompts: sidecar-era mesh-awareness, daemon-era aboyeur-open + email-triage (retired with the trigger path, aby-cazete) | Low |
| `HEARTBEAT.md` | Self-contained health-check prompt for a native CronCreate loop (ported off the daemon cron 2026-08-24, aby-gonida) | Low |

### Mesh Integration (validated)

CC sessions join the Anthropic conductor mesh (`bridge.claudeusercontent.com`) via a Channels MCP server. The Channels API (CC v2.1.80+, research preview) lets an MCP server push events directly into a CC session as `<channel>` tags — no PTY injection, no file polling.

**How it works:** `conductor-channel.ts` wraps `ConductorBridge` as an MCP Channels server. CC is started with `--dangerously-load-development-channels server:conductor-channel`. Incoming mesh messages arrive as `<channel source="conductor-channel">` tags. Claude sends via `send_message` MCP tool, discovers peers via `mesh_peers`.

**Env vars:** `MESH_AGENT_ID` (optional — explicit mesh identity override) and `MESH_ROLE` (aboyeur|pm|worker|user — affects interrupt semantics in instructions). When `MESH_AGENT_ID` is absent, auto-derived as `cc-{folder}-{first 8 chars of session UUID}`, where the UUID is read from `CLAUDE_CODE_SESSION_ID` (CC sets it at MCP-spawn time). This is race-free and stable across resume, so two sessions in the SAME cwd get **distinct** ids (fixed 2026-07-15, aby-pupaso). *History:* the UUID used to be read from the most-recently-modified JSONL in the project dir, which let a newcomer adopt a busy sibling's UUID and collide — measured 2026-07-14 as 114 supersession events, both sessions knocked offline. Falls back to that JSONL scan only if `CLAUDE_CODE_SESSION_ID` is absent (older CC). `MESH_DISABLED=1` suppresses mesh entirely (safe for subagent inheritance).

**MCP registration required:** The channel server must be registered in MCP config for the `--dangerously-load-development-channels` flag to find it. `.mcp.json` (canonical) or `settings.json`:
```json
{ "mcpServers": { "conductor-channel": { "command": "bun", "args": ["src/conductor-channel.ts"] } } }
```
Bun runs the TypeScript directly — no build step (Phase 3, aby-bosuwa, 2026-07-15). `bun` must be on the CC process's PATH or the MCP server ENOENTs silently (MCP fails soft); on tube via a `~/.local/bin/bun` symlink.

**Shipped as a plugin (aby-zufefu, 2026-07-19):** conductor-channel now also ships as **`sonnette`** in the public **`batterie`** marketplace (`claude plugin install sonnette@batterie`). The plugin carries a committed single-file bundle (`sonnette/conductor-channel.js`, `npm run build:sonnette`) + a bun-locating wrapper (`sonnette/run.sh`), because the batterie assembler vendors source without `node_modules`. **After editing any `src/` mesh code, rebuild the bundle and commit it** — aboyeur CI (`sonnette-bundle-fresh`) diffs it against a pinned-bun rebuild and goes red on drift. Plugin-loaded tools are namespaced `mcp__plugin_sonnette_sonnette__{send_message,mesh_peers}` (not `mcp__conductor-channel__*`).

**Mesh-at-birth — and sonnette is DISABLED STANDING since 2026-07-26 (bds-micozi).** The estate's rule is now all-or-nothing: `enabledPlugins.sonnette@batterie=false` sits in `~/.claude/settings.json`, so a bare `claude` has **no sonnette tools at all**, and `claudem` re-enables it per launch via `--settings '{"enabledPlugins":{"sonnette@batterie":true}}'` alongside `--dangerously-load-development-channels plugin:sonnette@batterie`. Rationale: a flagless session used to hold a live registration while inbound-deaf, and two handoff messages were lost to exactly that. Measured mechanism: **the channels flag only rides an ENABLED plugin** — uninstalled or disabled means no tools even when flagged. `-m` on `claudev`/`claudefv` now **refuses**, because Vertex sessions cannot bind channels at all ("Channels are not available on third-party providers") and enabling there would mint registered-but-deaf deliberately. One trust dialog per launch. Dialog-free-everywhere (allowlist) is **externally blocked** — `/etc/claude-code/managed-settings.json` `allowedChannelPlugins` is server-shadowed on Teams (measured dead 2026-07-19, aby-lesefu), waiting on Anthropic (#58152 / a Teams console allowlist field).

**This standing state is an INTERIM, not the destination.** The 2026-07-26 step-back session decided the opposite philosophy — decouple membership from bidirectionality and make capability *honest* rather than removing it — and Sameer adjudicated the two as a sequence: micozi is the tourniquet, `aby-jepezu` is the surgery. `aby-werazu` flips sonnette back on standing once `aby-sahifi` ships honest capability. Read `.bon/understanding.md` §transport decision before changing anything here.

**Landmine — two servers in aboyeur's OWN cwd (now claudem-only):** this repo is the only place with a project `.mcp.json` conductor server, so a session here that *also* has the plugin active loads BOTH (project `bun src/…` + plugin), deriving the same agentId. Since micozi's standing-disable that means **`claudem` in this cwd**, not every session. They no longer flap (aby-suwawo, 1.16.1: a shared `owner.pid` makes the younger yield permanently to the live older sibling — age, not liveness, so the aby-tarafo restart-survivor still revives), but two servers still run with one yielded, and both still announce their birth to the estate (`aby-gukori` moves the yield before `register`). If mesh acts oddly *in aboyeur*, suspect this first; work from another cwd to rule it out. Regression repro: `tests/suwawo-two-process.mjs`.

**Quiet by default (aby-huciza, 2026-07-26, sonnette 1.22.4):** peer join/leave no longer surfaces as `<channel>` tags — presence is *pull* (`mesh_peers`), only real messages and the one-time birth summary *push*. The bridge also emits `peer_online` only on absent→present transitions and `peer_offline` only for known peers, so re-registers update the roster silently. Validated live: a peer joined and left while a flag-born session watched — zero roster tags, message tags intact.

**A session can tell whether it can actually receive (aby-masogo, 2026-07-26):** `src/mesh-capability.ts` → `detectMeshCapability(env, argv)` returns `{canReceive, reason, detail}`, published at `/tmp/conductor-bridge/{agentId}/capability`. `getClientCapabilities()` does **not** discriminate (identical across plain / flagged-Vertex / flagged-Teams once read from `oninitialized`, where it is actually populated) — what does is the parent's argv (exact-token match; the wrappers pass a `--settings` JSON blob) plus `CLAUDE_CODE_ENTRYPOINT` (`cli` interactive vs `sdk-cli` headless) and `CLAUDE_CODE_USE_VERTEX`. Every unknown resolves to send-only by design. **Known gap:** it reads `/proc`, so macOS falsely reports send-only — `aby-wazica`, must fix before `aby-sahifi` consumes the verdict.

**Testing anything interactive:** `claude -p` is a different product surface — inbound tags, dialogs and the statusline do not exist there, so a headless green proves nothing about the TUI. Use the **`hublot`** skill (trousse 1.23.0) to drive and observe a real interactive session.

**spawnAgent() integration:** Pass `meshAgentId` and `meshRole` options — this adds the channel flag to args and sets env vars. Without these options, no mesh — Guéridon behaviour unchanged.

**agentId scheme** (auto-derived when `MESH_AGENT_ID` is not set):

| Session type | Mesh agentId | How assigned |
|---|---|---|
| Interactive (auto) | `cc-{folder}-{first8 of session UUID}` e.g. `cc-aboyeur-143b6b6d` | Derived from `CLAUDE_CODE_SESSION_ID` (the session's own uuid) |
| PM (explicit) | `cc-pm-{outcome-id}` e.g. `cc-pm-aby-kikebu` | `MESH_AGENT_ID` env var |
| Worker (explicit) | `cc-worker-{action-id}-{seq}` e.g. `cc-worker-aby-sanimu-01` | `MESH_AGENT_ID` env var |
| Reflector (explicit) | `cc-reflector-{action-id}-{seq}` | `MESH_AGENT_ID` env var |
| Spawned reviewer | `cc-reviewer-{timestamp}` | `MESH_AGENT_ID` env var |

Auto-derived IDs are stable across resume (same session → same UUID) and **collision-free** for two sessions in the same cwd — each reads its own `CLAUDE_CODE_SESSION_ID` rather than the busiest JSONL (fixed 2026-07-15, aby-pupaso). Explicit `MESH_AGENT_ID` still overrides auto-derivation for spawnAgent-spawned sessions (PM/worker/reviewer naming).

**Peer removal:** `conductor_agent_offline`, `conductor_agent_expired`, and `conductor_agent_reset` are all handled — any of them removes the peer from the map. `conductor_agent_offline` is a no-op in the Office bundle (empty handler) but we handle it anyway for completeness.

**Intel repo:** `~/Repos/claude-in-office` has the full conductor protocol documentation, Office bundle analysis, and timing measurements. Read `docs/CONDUCTOR-PROTOCOL.md` there before working on mesh code — it is the canonical protocol reference.

### Reference Implementations (crib from these)

| Pattern | Where to look |
|---------|---------------|
| Channels MCP server | `src/conductor-channel.ts` (built) + `https://code.claude.com/docs/en/channels-reference` (CC Channels API docs) |
| Spawn + env-var stripping | `~/Repos/gueridon/server/bridge.ts:326-345` (THE primary reference) |
| Session resume logic | `~/Repos/gueridon/server/bridge-logic.ts` (buildCCArgs, resolveSessionForFolder) |
| Gueridon bridge API | `~/Repos/gueridon/server/bridge.ts` (session lifecycle: spawn, list, kill, events) |
| Orphan process management | `~/Repos/gueridon/server/orphan.ts` |
| Event parsing | `~/Repos/gueridon/server/state-builder.ts` |

## Conventions

- **TypeScript** for all new code (mesh, spawnAgent)
- **Gueridon's spawn pattern** for session spawning (`claude` CLI + stream-json, via spawnAgent)
- **Gueridon bridge API** for session lifecycle (spawn, list, kill, events)
- **Channels MCP** for mesh connectivity (`conductor-channel.ts`, not sidecar)
- **MESH_AGENT_ID env var** to gate mesh on/off per spawn — absent means no mesh
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

`npm test` = 13 node tests (spawn-agent, mesh-capability) + 10 bun channel tests (conductor-channel, bridge supersession, mesh-id seam, send-confirm, deregister timing, quiet roster). The daemon integration suite went with the daemon (aby-cazete, 2026-08-24) — its patterns live on in git history pre-`refactor!: delete the SQLite trigger path`.

## Status

Pre-alpha, mid-revival. The SQLite daemon column is deleted (aby-cazete, 2026-08-24; never deployed) and orchestration rides native primitives — HEARTBEAT on a scheduled task (aby-gonida), the worker/reflector cycle proven on Agent-tool control flow (aby-dujato, map in `docs/native-loop-map-2026-08-24.md`). `npm test` = 13 node + 10 bun. Mesh connectivity validated via Channels MCP. Peer review loop proven with live round-trips. Supersession fixed (aby-tarafo); same-id double-server war fixed (aby-suwawo, 1.16.1). **Mesh is shipped for real use:** sonnette in the batterie marketplace (aby-zufefu), mesh-at-birth via `claudem` (aby-pafada), one-shot phone-a-friend via `/consult`. The three-rung capability ladder is mapped in `.bon/understanding.md`.

**Current focus is `aby-jepezu`** — quiet by default, truthful about capability, observable at a glance. Shipped so far: quiet roster (aby-huciza) and capability self-detection (aby-masogo), both live-validated on a real `claudem` session. Next: **aby-sahifi** (advertise capability honestly at registration, in `mesh_peers`, and at send time) — which unblocks **aby-werazu** (re-enable sonnette standing, reversing the micozi interim) and is gated on **aby-wazica** (the `/proc` portability fix). Then aby-gukori, aby-kisemi, aby-darode, aby-cezihe, aby-lejoso, aby-zawigu. Elsewhere: aby-lezuhu closes the Bun outcome (docs sweep, scope now just `docs/MESH-SETUP.md`), aby-luviwu graduates `/consult` to trousse. `aby-rawupo` has one step left — verify the shipped instructions render in a *fresh* session.
