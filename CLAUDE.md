# Aboyeur — Project Context

Multi-session orchestrator built on a flat peer model. A **daemon** (always-on trigger watcher, just code) watches the world and spawns Claude sessions. Claudes communicate as **peers** via the Anthropic conductor mesh (`<channel>` tags) — no hierarchy, no management layer. Coordination lives in bons and .inbox/, not in a conductor Claude.

Read `docs/architecture-decisions.md` for the full design rationale, rejected alternatives, and reference implementations to crib from.

## Architecture

```
Daemon (Node.js, always-on, no intelligence)
  ├── polls: Gmail API, cron, filesystem, .inbox/, webhooks
  ├── normalizes triggers → SQLite queue
  ├── drains queue through per-context FIFO (max 3 concurrent)
  └── spawns Claudes via spawnAgent()

Claudes (peers on the conductor mesh)
  ├── one-shot: triage an email, check a status, exit
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
| Standalone next action | One-shot: trigger → single Claude → done |
| Project (multi-step) | Sequence of peer sessions coordinated via bons |
| Areas of focus / goals | Bon outcomes |
| Weekly review | HEARTBEAT cron trigger |

### Key Files

| File | Purpose | Sensitivity |
|------|---------|-------------|
| `src/spawn-agent.ts` | spawnAgent() — spawn claude, collect output, resume sessions | High — all spawning goes through here |
| `src/trigger-db.ts` | SQLite trigger queue — schema, dedup, cursors, crash recovery | High — daemon state lives here |
| `src/trigger-loop.ts` | Polling loop that drains the trigger queue | Medium |
| `src/context-queue.ts` | Per-context FIFO with concurrency limits and lane policies | High — prevents runaway spawning |
| `src/router.ts` | Trigger → SpawnAgentOptions resolver (session naming, prompt loading) | High — routing brain |
| `src/trigger-cron.ts` | Interval-based cron triggers (HEARTBEAT) | Medium |
| `src/daemon.ts` | Wires trigger loop → context queue → spawn (with mock injection for tests) | High — integration point |
| `src/main.ts` | Daemon entry point — wires router, cron, shutdown handlers | High — the executable |
| `src/conductor-bridge.ts` | WebSocket bridge to Anthropic's conductor mesh — ConductorBridge class (transport layer, used by conductor-channel.ts) | High — mesh infrastructure |
| `src/conductor-channel.ts` | MCP Channels server wrapping ConductorBridge — CC loads via `--dangerously-load-development-channels server:conductor-channel` | High — mesh integration |
| `src/index.ts` | Barrel export for daemon modules | Low |
| `docs/architecture-decisions.md` | Design decisions and rejected alternatives | High — prevents re-derivation |
| `shared/prompts/aboyeur-open.md` | Aboyeur instructions (routing, session naming) | High — the brain |
| `shared/prompts/email-triage.md` | One-shot email handling (classify, draft, escalate) | High — email quality |
| `shared/prompts/reflector-open.md` | Reflector instructions (code/work review) | High — sycophancy risk if weakened |
| `shared/prompts/planning-reflector.md` | Planning reflector (architecture review) | High — catches assumption errors |
| `shared/prompts/worker-open.md` | Worker instructions | Medium |
| `shared/prompts/legacy/mesh-awareness.md` | Retired sidecar-era mesh instructions — replaced by conductor-channel.ts instructions field | Low |
| `service/aboyeur-daemon.service` | Systemd user unit for hezza | Medium |
| `HEARTBEAT.md` | Periodic health check checklist | Low |

### Mesh Integration (validated)

CC sessions join the Anthropic conductor mesh (`bridge.claudeusercontent.com`) via a Channels MCP server. The Channels API (CC v2.1.80+, research preview) lets an MCP server push events directly into a CC session as `<channel>` tags — no PTY injection, no file polling.

**How it works:** `conductor-channel.ts` wraps `ConductorBridge` as an MCP Channels server. CC is started with `--dangerously-load-development-channels server:conductor-channel`. Incoming mesh messages arrive as `<channel source="conductor-channel">` tags. Claude sends via `send_message` MCP tool, discovers peers via `mesh_peers`.

**Env vars:** `MESH_AGENT_ID` (optional — explicit mesh identity override) and `MESH_ROLE` (aboyeur|pm|worker|user — affects interrupt semantics in instructions). When `MESH_AGENT_ID` is absent, auto-derived from the CC session's JSONL: `cc-{folder}-{first 8 chars of session UUID}`. This is stable across resume and unique per concurrent session. `MESH_DISABLED=1` suppresses mesh entirely (safe for subagent inheritance).

**MCP registration required:** The channel server must be registered in MCP config for the `--dangerously-load-development-channels` flag to find it. Add to `.mcp.json` or `settings.json`:
```json
{ "mcpServers": { "conductor-channel": { "command": "node", "args": ["dist/conductor-channel.js"] } } }
```

**spawnAgent() integration:** Pass `meshAgentId` and `meshRole` options — this adds the channel flag to args and sets env vars. Without these options, no mesh — Guéridon behaviour unchanged.

**agentId scheme** (auto-derived when `MESH_AGENT_ID` is not set):

| Session type | Mesh agentId | How assigned |
|---|---|---|
| Interactive (auto) | `cc-{folder}-{first8 of session UUID}` e.g. `cc-aboyeur-143b6b6d` | Derived from most recent JSONL in `~/.claude/projects/` |
| PM (explicit) | `cc-pm-{outcome-id}` e.g. `cc-pm-aby-kikebu` | `MESH_AGENT_ID` env var |
| Worker (explicit) | `cc-worker-{action-id}-{seq}` e.g. `cc-worker-aby-sanimu-01` | `MESH_AGENT_ID` env var |
| Reflector (explicit) | `cc-reflector-{action-id}-{seq}` | `MESH_AGENT_ID` env var |
| Spawned reviewer | `cc-reviewer-{timestamp}` | `MESH_AGENT_ID` env var |

Auto-derived IDs are stable across resume (same JSONL → same UUID) and unique per concurrent session. Explicit `MESH_AGENT_ID` overrides auto-derivation for daemon-spawned sessions.

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
| FIFO queue + concurrency | `~/Repos/nanoclaw/src/group-queue.ts` |
| Trigger normalization | `~/Repos/nanoclaw/src/index.ts` |

## Conventions

- **TypeScript** for all new code (daemon, conductor, spawnAgent)
- **Gueridon's spawn pattern** for daemon spawning (`claude` CLI + stream-json)
- **Gueridon bridge API** for session lifecycle (spawn, list, kill, events)
- **Channels MCP** for mesh connectivity (`conductor-channel.ts`, not sidecar)
- **MESH_AGENT_ID env var** to gate mesh on/off per spawn — absent means no mesh
- **Max subscription** auth for all agents
- **Bon `--json`** for structured work state (not markdown parsing)
- Prompts: direct, concrete instructions over abstract principles
- The conductor should stay lean — complexity belongs in environment files (CLAUDE.md, handoffs, bon), not the orchestrator

## Dependencies

- **claude CLI** — session spawning via stream-json
- **better-sqlite3** — trigger queue, cursor tracking
- **Bon CLI** (`bon`) — work tracking, structured state via `--json`
- **Jeton** (`~/Repos/jeton/`) — OAuth token management for Gmail polling
- **Mise** (`~/Repos/mise-en-space/`) — Google Workspace MCP (email draft/reply/fetch)
- **Gueridon** (`~/Repos/gueridon/`) — bridge API for session lifecycle (spawn, list, kill, events)

## Testing

End-to-end test harness (aby-wesaci, complete) with mock spawn injection. Tests the plumbing (trigger → queue → spawn → output → route), not Claude's intelligence. Daemon integration tests cover: full cycle, parallel contexts, FIFO ordering, error handling, crash recovery, dedup, clean shutdown. All fast (<3s), no external deps.

## Status

Pre-alpha. Daemon plumbing built and tested. Mesh connectivity validated via Channels MCP (conductor-channel.ts). Peer review loop proven with live mesh round-trips. Interactive mode supersession fix in place (aby-tarafo). Next: aby-pacojo (.inbox/ fallback for peer review without mesh), aby-sanimu (Gmail trigger), aby-metepe (conversational peer patterns).
