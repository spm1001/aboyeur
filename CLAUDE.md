# Aboyeur — Project Context

Multi-session orchestrator. A **daemon** (always-on trigger watcher, just code) wakes an **aboyeur** (persistent Claude that holds goals and routes work). The aboyeur spawns **one-shot Claudes** for simple tasks or **project manager Claudes** for multi-session work. PMs spawn **workers** and **reflectors**. All Claude sessions are side-by-side pods under the Gueridon bridge — the hierarchy is informational, not structural.

Read `docs/architecture-decisions.md` for the full design rationale, rejected alternatives, and reference implementations to crib from.

## Architecture

```
Daemon (Node.js, always-on, no intelligence)
  ├── polls: Gmail API, cron, filesystem, webhooks
  ├── normalizes triggers → SQLite queue
  ├── drains queue through per-context FIFO (max 3 concurrent)
  └── spawns aboyeur via spawnAgent() — the only direct spawn

Aboyeur (persistent Claude, minimal context)
  ├── holds goals (bon outcomes), not plans
  ├── routes: one-shot for simple tasks, PM for multi-session work
  ├── sees only summaries and escalations from PMs
  └── restartable — goals live in bons

PM Claude (medium-lived, project-scoped, human simulator)
  ├── reads bon state (structured, via --json) for ONE project
  ├── manages the beat: work → review → route
  ├── spawns workers and reflectors via Gueridon bridge
  ├── monitors via filtered event stream (eyesight filter)
  ├── deep in the weeds, reports progress lines to aboyeur
  └── disposable — restarts from bon state if it dies

One-shot Claude (single-session tasks)
  ├── triage an email, read an article, check a status
  └── returns summary to aboyeur, done

Workers / Reflectors (spawned by PM via Gueridon)
  ├── workers: see a directory, CLAUDE.md, and bons — oblivious
  ├── reflectors: fresh-eyes review, structured verdicts
  └── both write handoffs that the PM reads
```

### Process vs Information

```
Process reality:     Gueridon bridge → [session] [session] [session] ...
                     All peers. Bridge doesn't know about hierarchy.

Information flow:    Aboyeur ←summary── PM ←verdict── Reflector
                                         PM ──spawns→ Worker
                     Aboyeur ←summary── One-shot
```

Each level up sees less. Workers produce the most tokens, PMs see summaries, the aboyeur sees one-liners. The eyesight filter operates at every boundary.

### Session Naming Convention

| Session type | Pattern | Example |
|---|---|---|
| Aboyeur | `aboyeur-{trigger}-{HHMMSS}` | `aboyeur-gmail-203015` |
| PM | `pm-{outcome-id}-{seq}` | `pm-aby-zehiwo-01` |
| Worker | `worker-{action-id}-{seq}` | `worker-aby-sanimu-01` |
| Reflector | `reflector-{action-id}-{seq}` | `reflector-aby-sanimu-01` |
| One-shot | `oneshot-{trigger}-{HHMMSS}` | `oneshot-gmail-203022` |

### The Beat Pattern (PM level)

```
PM reads bon state
  → spawns worker-aby-sanimu-01
    → worker finishes, writes handoff
  → spawns reflector-aby-sanimu-01
    → reflector writes {"approved": true, "issues": [...]}
  → PM reads verdict
  → approved? bon done, pick next action, report to aboyeur
  → rejected? spawns worker-aby-sanimu-02 with fix instructions
  → escalate? drafts email to Sameer via mise
PM reads bon state again...
```

### GTD Mapping

| GTD | Aboyeur equivalent |
|---|---|
| Standalone next action | One-shot: trigger → single Claude → done |
| Project (multi-step) | PM Claude manages the beat sequence |
| Areas of focus / goals | Aboyeur's persistent outcome set |
| Weekly review | HEARTBEAT: are PMs alive? escalations? drift? |

### Key Files

| File | Purpose | Sensitivity |
|------|---------|-------------|
| `src/spawn-agent.ts` | spawnAgent() — spawn claude, collect output, resume sessions | High — daemon→conductor spawning |
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

### Mesh Integration (aby-nenabo — in progress)

CC sessions join the Anthropic conductor mesh (`bridge.claudeusercontent.com`) via a Channels MCP server, not the PTY sidecar. The Channels API (CC v2.1.80+, research preview) lets an MCP server push events directly into a CC session as `<channel>` tags — no PTY injection, no file polling.

**How it works:** `conductor-channel.ts` wraps `ConductorBridge` as an MCP Channels server. CC is started with `--dangerously-load-development-channels server:conductor-channel`. Incoming mesh messages arrive as `<channel source="conductor-channel">` tags. Claude sends via `send_message` MCP tool, discovers peers via `mesh_peers`.

**Env vars:** `MESH_AGENT_ID` (required — stable mesh identity) and `MESH_ROLE` (aboyeur|pm|worker|user — affects interrupt semantics in instructions). If `MESH_AGENT_ID` is absent, the channel server exits silently (safe for subagent inheritance).

**MCP registration required:** The channel server must be registered in MCP config for the `--dangerously-load-development-channels` flag to find it. Add to `.mcp.json` or `settings.json`:
```json
{ "mcpServers": { "conductor-channel": { "command": "node", "args": ["dist/conductor-channel.js"] } } }
```

**spawnAgent() integration:** Pass `meshAgentId` and `meshRole` options — this adds the channel flag to args and sets env vars. Without these options, no mesh — Guéridon behaviour unchanged.

**agentId scheme** (multiple Claudes per folder — folder alone is not unique enough):

| Session type | Mesh agentId |
|---|---|
| Aboyeur | `cc-aboyeur` |
| PM | `cc-pm-{outcome-id}` e.g. `cc-pm-aby-kikebu` |
| Worker | `cc-worker-{action-id}-{seq}` e.g. `cc-worker-aby-sanimu-01` |
| Reflector | `cc-reflector-{action-id}-{seq}` |
| Guéridon interactive | `cc-{folder}` |

Stable IDs mean session restart re-registers the same agentId rather than appearing as a new stranger. `MESH_AGENT_ID` env var is how the spawner passes the computed ID to CC and then to the channel server.

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
- **Gueridon's spawn pattern** for daemon→conductor (`claude` CLI + stream-json)
- **Gueridon bridge API** for conductor→workers (at one remove)
- **Channels MCP** for mesh connectivity (`conductor-channel.ts`, not sidecar)
- **MESH_ENABLED env var** to gate mesh on/off per spawn — never default in CC_BASE_FLAGS
- **Max subscription** auth for all agents
- **Bon `--json`** for structured work state (not markdown parsing)
- Prompts: direct, concrete instructions over abstract principles
- The conductor should stay lean — complexity belongs in environment files (CLAUDE.md, handoffs, bon), not the orchestrator

## Dependencies

- **claude CLI** — daemon→conductor spawning via stream-json
- **better-sqlite3** — trigger queue, cursor tracking
- **Bon CLI** (`bon`) — work tracking, structured state via `--json`
- **Jeton** (`~/Repos/jeton/`) — OAuth token management for Gmail polling
- **Mise** (`~/Repos/mise-en-space/`) — Google Workspace MCP (email draft/reply/fetch)
- **Gueridon** (`~/Repos/gueridon/`) — bridge API for conductor→worker spawning (runtime dependency, not just reference)

## Testing

End-to-end test harness (aby-wesaci, complete) with mock spawn injection. Tests the plumbing (trigger → queue → spawn → output → route), not Claude's intelligence. Daemon integration tests cover: full cycle, parallel contexts, FIFO ordering, error handling, crash recovery, dedup, clean shutdown. All fast (<3s), no external deps.

## Status

Pre-alpha. Daemon core plumbing built and tested: `spawnAgent()` → `TriggerDB` → `TriggerLoop` → `ContextQueue` → `daemon.ts` integration. Mesh connectivity planned via Channels MCP (aby-nenabo) replacing the PTY sidecar approach. Next active work: aby-nenabo (conductor-channel.ts), cio-jurefa (transport capture in ~/Repos/claude-in-office), aby-sanimu (Gmail trigger, blocked on aby-hemimi).
