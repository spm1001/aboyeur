# Aboyeur — Understanding

A living portrait of this project: what it is, what we've learned, and where the tensions lie. Written collaboratively by two Claude Code sessions communicating via the Anthropic conductor mesh (14 Mar 2026).

## What This Is

A multi-session orchestrator. The name is the kitchen metaphor: the aboyeur is the caller who reads the ticket and directs the kitchen. Here, the "tickets" are triggers (emails, cron, bon completions) and the "kitchen" is a fleet of Claude Code instances.

The system has two parts with different natures:

**The daemon** is code (Node.js, always-on). It watches trigger sources — Gmail API, cron, filesystem, and now the conductor mesh — normalises them into a SQLite queue, and drains through per-context FIFOs. No intelligence. It spawns Claude sessions via `spawnAgent()`, a function extracted from Guéridon's `spawnCC()` pattern. The daemon is the lizard brain.

**The Aboyeur pattern** is behaviour, not code. It's what a Claude does when it wakes up with access to bon outcomes and the ability to spawn other Claudes. It reads the state, decides what to route, and acts. Then it goes back to sleep. The pattern is /close's Orient+Decide+Act decoupled from context exhaustion and triggered by accomplishment instead.

## The Aboyeur Pattern (distilled from 1,012 handoffs)

Analysis of real handoff data showed the pattern has clear lineage from December 2025. 60% of handoffs contain reflections. The pattern was always there — it just needed a name and a trigger.

### Six Review Questions (from /close Orient)

Looking back:
1. What did we forget?
2. What did we miss?
3. What could we have done better?

Looking ahead:
4. What could go wrong?
5. What will not make sense later?
6. What will we wish we had done?

### Anti-Deferral Heuristic

The test: does the current Claude have the understanding to fix this? If yes, do it now. If no, bon it with consequences. No third option. "Always better to fix now — later Claudes will not have the same understanding."

### Trigger: Bon Outcome Completion

Not context exhaustion. Not time-based. The bon outcome is the natural "dish is plated" moment. Step completion is too frequent. Action completion might warrant a glance. Outcome completion gets the full review.

### Fresh-Context Advantage

The reviewing Claude reads the state cold — no sunk cost bias, no familiarity blindness. Same principle as Anthropic's `verify_slide_visual` sub-agent: a fresh-context reviewer with no knowledge of the conversation produces more honest critique.

### Three Output Buckets

- **Now** — under 2 minutes, benefits from current context. Do it immediately.
- **Bon** — tracked, gated by: "if this never gets done, what breaks?"
- **Kill** — item that should not exist. Delete it.

## Two Communication Channels

This is an architectural insight about how Claudes treat information differently based on perceived source. It applies to the entire system.

1. **Bridge injection via Guéridon** — for authority. The working Claude receives feedback as if from the user (routed through AskUserQuestion or `--append-system-prompt`). The trained ranking dynamic means this feedback gets acted on. Used for: reviews, course corrections, escalations.

2. **Peer messaging via conductor mesh** — for honest exchange. No ranking dynamic, no deference performance. Used for: discovery ("who's alive?"), coordination ("I finished this, you can start that"), status, questions between peers.

The mesh doesn't replace the authority channel. They coexist with different purposes. Routing the wrong kind of communication through the wrong channel produces either sycophancy (authority where honesty was needed) or ignored feedback (peer where authority was needed).

## The Conductor Mesh (proven 14-15 Mar 2026)

CC instances can register on Anthropic's production conductor mesh — the same mesh Office Claudes use. OAuth authentication works with CC's existing token from `~/.claude/.credentials.json`. No additional auth setup needed.

**How to use:** `claude-mesh` from any repo. Auto-generates a unique agent ID (`cc-{repo}-{hex6}`), connects to the mesh, injects a startup orientation so CC knows its commands and peers. All `claude` flags pass through (`claude-mesh -c` works).

**What works today:**
- Registration, peer discovery, bidirectional messaging
- CC agents appear alongside Office agents (Excel, PowerPoint, Word)
- TypeScript bridge (`src/conductor-bridge.ts`) — Node.js `ws` required; Python WebSocket libraries fail after ~60s
- PTY wrapper (`tools/mesh-claude.py`) injects mesh messages into live interactive CC sessions
- `mesh` CLI (generated at runtime, in PATH): `mesh send <id> "msg"`, `mesh peers`, `mesh inbox`, `mesh status`
- Auto-naming: each session gets a unique ID and display name visible to peers in Office's "Connected files"
- Startup orientation: CC is told its commands and online peers immediately after boot
- Structured event log (`events.jsonl`): full protocol trace of every non-ping message, with rotation at 1MB
- Process group cleanup: `os.setsid` + `os.killpg()` kills entire npx→node chain on shutdown
- Cross-harness messaging: Excel Librarian, PowerPoint, and CC sessions all communicate through the same mesh

**Display name precedence (non-obvious):** The Office "Connected files" panel shows `schema.label` (mapped from `appName` in the registration, NOT `display.label`). The `conductor_broadcast_status` message with `fileName` also updates the display. `display.label` is peer metadata only.

**What the mesh gives the architecture:**
- Cross-machine agent discovery (CC on Pi sees CC on Mac)
- Spawn-on-message: inbound mesh message to an empty repo becomes a daemon trigger
- The Aboyeur becomes event-driven, not persistent — wakes on trigger, acts, sleeps
- Office Claudes and Code Claudes share the same nervous system

**What the mesh doesn't give:**
- Goal persistence (that's bons)
- Session lifecycle discipline (that's CLAUDE.md and handoffs)
- Authority channel (that's Guéridon bridge injection)
- The mesh is the nervous system. The Aboyeur pattern is the brain.

## Architecture Tiers

All Claude sessions are technically side-by-side pods under the Guéridon bridge — flat peer processes. The hierarchy is purely informational: who reads whose output, and at what granularity.

```
Daemon (code, always-on)
  ├── polls: Gmail, cron, filesystem, conductor mesh
  ├── normalises triggers → SQLite queue → per-context FIFO
  └── spawns Aboyeur via spawnAgent()

Aboyeur (pattern, event-driven)
  ├── reads bon outcomes (not actions — those belong to PMs)
  ├── routes: one-shot for simple, PM for multi-session
  ├── detects promotion: one-shot creates bons → spawn PM
  └── wakes on trigger, acts, sleeps — not persistent

PM Claude (medium-lived, project-scoped)
  ├── reads bon state via --json for ONE project
  ├── manages the beat: work → review → route
  ├── spawns workers and reflectors via Guéridon bridge
  └── reports progress one-liners to aboyeur

Workers / Reflectors (oblivious)
  ├── workers: see a directory, CLAUDE.md, and bons
  ├── reflectors: fresh-eyes review, structured verdicts
  └── don't know they're orchestrated
```

Each level up sees less. Workers produce the most tokens, PMs see summaries, the Aboyeur sees one-liners.

## What's Built

The daemon core plumbing is complete and tested:
- `spawnAgent()` — spawn claude, collect output, resume sessions
- `TriggerDB` — SQLite queue with dedup, cursors, crash recovery
- `TriggerLoop` — polling loop that drains pending triggers
- `ContextQueue` — per-context FIFO with concurrency limits
- `daemon.ts` — wires it all together
- Integration tests covering full cycle, parallel contexts, FIFO, error handling, crash recovery, dedup, shutdown. All fast (<3s), no external deps.
- Planning reflector prompt (validated)
- Conductor mesh bridge script (proof of concept)

## Key Tensions

**Role fluidity vs structured hierarchy.** The Aboyeur pattern suggests any Claude can embody any role by reading the appropriate state. But the strict tier separation (aboyeur sees outcomes, PM sees actions, workers see code) exists to prevent context exhaustion. The mesh makes communication easy; the hierarchy makes it selective.

**Event-driven vs persistent aboyeur.** If the aboyeur wakes, acts, and sleeps, it loses conversational continuity. But if it stays persistent, it consumes context on idle. The answer may be: session resume. The aboyeur wakes with `--resume`, picks up where it left off, acts on the new trigger, then exits. Continuity via session state, not permanent process.

**Mesh message delivery.** Unknown: does the mesh queue messages for offline agents? If not, Guéridon must buffer inbound messages until the daemon spawns a session. This affects whether spawn-on-message is mesh-native or bridge-mediated.

**Token refresh.** CC's OAuth token expires every ~24h. The bridge needs to detect expiry and re-read from `.credentials.json` (CC handles refresh internally). Not hard, but untested.

## Landmines

- `bon list` via Bash collapses output >10 lines in CC. Always read bon.txt and output as text.
- The conductor mesh requires `_agent_id` on all client messages EXCEPT pings. Pings must NOT include `_agent_id` from Node.js. Broadcasts MUST include it. Getting this wrong causes `"Multiplexed messages require _agent_id"` errors.
- Bridge reconnections replay all buffered events — the TS bridge deduplicates via `msgKey = fromId + ":" + message` set.
- `tools/mesh` CLI is generated at runtime by mesh-claude.py and gitignored — don't look for it in the repo.
- `npx tsx` spawns a 4-process chain (npx → sh → node tsx → node). The bridge must be started with `preexec_fn=os.setsid` and killed with `os.killpg()` or orphans will persist on the mesh and cause reconnection storms ("Superseded by new connection" every ~1s).
- The raw-bundle/ directory in claude-in-office is gitignored — bundle files, API requests, conductor traces are LOCAL ONLY on Hezza.
