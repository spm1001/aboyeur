# Aboyeur — Project Context

Multi-session orchestrator with two parts: a **daemon** (always-on trigger watcher, just code) and a **conductor** (Claude session that directs workers and reflectors). The daemon is the lizard brain — reflexive, no intelligence. The conductor is the frontal lobe — deliberate, reflective, context-rich.

Read `docs/architecture-decisions.md` for the full design rationale, rejected alternatives, and reference implementations to crib from.

## Architecture

```
Daemon (Node.js, always-on)
  ├── polls: Gmail API, cron, filesystem, webhooks
  ├── normalizes triggers → SQLite queue
  ├── drains queue through per-context FIFO (max 3 concurrent)
  └── spawns agents via spawnAgent() (Agent SDK + env-var stripping)

Conductor (Claude session, spawned by daemon)
  ├── reads handoffs and bon state
  ├── decides: spawn worker, spawn reflector, escalate to human
  ├── generates prompts for workers (environment-as-prompt philosophy)
  └── holds big picture via memory stack (handoffs, garde, bon)

Workers and Reflectors (Claude sessions, spawned by conductor or daemon)
  ├── workers: do the work, write handoffs
  └── reflectors: review with fresh eyes, write handoffs, fix modest issues
```

### Key Files

| File | Purpose | Sensitivity |
|------|---------|-------------|
| `docs/architecture-decisions.md` | Design decisions and rejected alternatives | High — prevents re-derivation |
| `shared/prompts/reflector-open.md` | Reflector instructions (code/work review) | High — sycophancy risk if weakened |
| `shared/prompts/planning-reflector.md` | Planning reflector (architecture review) | High — catches assumption errors |
| `shared/prompts/worker-open.md` | Worker instructions | Medium |
| `conductor.sh` | Legacy shell conductor (being replaced by conductor.ts) | Deprecated — see aby-pinida |
| `adapters/` | Legacy adapters for Pi/CC | Deprecated |

### Reference Implementations (crib from these)

| Pattern | Where to look |
|---------|---------------|
| Spawn + env-var stripping | `~/Repos/gueridon/server/bridge.ts:326-345` (THE primary reference) |
| Session resume logic | `~/Repos/gueridon/server/bridge-logic.ts` (buildCCArgs, resolveSessionForFolder) |
| Orphan process management | `~/Repos/gueridon/server/orphan.ts` |
| Event parsing | `~/Repos/gueridon/server/state-builder.ts` |
| FIFO queue + concurrency | `~/Repos/nanoclaw/src/group-queue.ts` |
| Trigger normalization | `~/Repos/nanoclaw/src/index.ts` |
| Stdout marker protocol | `~/Repos/nanoclaw/src/container-runner.ts:29-31` |

## Conventions

- **TypeScript** for all new code (daemon, conductor, spawnAgent)
- **Gueridon's spawn pattern** for Claude sessions (`claude` CLI + stream-json, NOT the Agent SDK)
- **Max subscription** auth for all agents
- Shell: `set -euo pipefail` (for any remaining shell scripts)
- Prompts: direct, concrete instructions over abstract principles
- The conductor should stay lean — complexity belongs in environment files (CLAUDE.md, handoffs, bon), not the orchestrator

## Dependencies

- **claude CLI** — session spawning via stream-json (Gueridon's pattern, no SDK wrapper)
- **better-sqlite3** — trigger queue, cursor tracking
- **Bon CLI** (`bon`) — work tracking, stuck detection
- **Jeton** (`~/Repos/jeton/`) — OAuth token management for Gmail polling
- **Mise** (`~/Repos/mise-en-space/`) — Google Workspace MCP (email draft/reply/fetch)
- **Gueridon patterns** (`~/Repos/gueridon/`) — env-var stripping, orphan management (reference only, not a dependency)

## Testing

End-to-end test harness (aby-wesaci) with mock Agent SDK. Test the plumbing (trigger → queue → spawn → output → route), not the Claude's intelligence. Carlini's insight: environment-as-prompt means tests matter more than prompt sophistication.

## Status

Pre-alpha. Legacy shell conductor works with Pi adapter. New architecture (daemon + conductor Claude + Agent SDK) is planned — see bon items. Planning reflector prompt is written and validated.
