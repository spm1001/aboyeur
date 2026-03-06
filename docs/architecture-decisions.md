# Architecture Decisions

Captured 6 Mar 2026 from a research and design session. This document records what was decided, what was rejected, and why — so future Claudes don't re-derive settled questions.

## The Core Metaphor

Aboyeur has two parts, like a brain:

- **The daemon** (lizard brain) — always-on Node.js process. Watches triggers (Gmail API, cron, filesystem). Reacts reflexively: trigger arrives → queue → spawn agent. No intelligence, no Claude, just code.
- **The conductor** (frontal lobe) — a Claude session spawned by the daemon. Makes deliberate decisions: which worker to spawn next, whether to run a reflector, whether to escalate. Generates bespoke prompts. Holds the big picture via handoffs and bon state.

They are separate processes. The daemon spawns the conductor (among other agents). The conductor uses the same `spawnAgent()` primitive to spawn workers and reflectors.

## Decisions Made

### Use Gueridon's spawn pattern, not the Agent SDK

The Agent SDK wraps `claude -p` which wraps the Claude Code CLI. Gueridon already talks to the CLI directly via `claude --input-format stream-json --output-format stream-json` — with env-var stripping, session resume, orphan management, and event parsing. That's exactly what the SDK provides, but we already own and maintain it.

The Agent SDK would be wrapping a wrapper. PreCompact hooks — our main reason for considering it — are Claude Code hook events configured in settings.json, not SDK-only features. Any spawned `claude` process picks up hooks from the project.

The daemon's `spawnAgent()` is Gueridon's `spawnCC()` extracted into a reusable function. No new dependency. Proven in production.

### Use Max subscription auth for all agents

Not API keys. Sameer has Max. All daemon-spawned agents authenticate via the Max subscription (same as interactive Claude Code). This keeps costs on one billing surface and avoids API key management.

### Env-var stripping for process isolation, not containers

Gueridon proved that stripping `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` from the child process env is sufficient to prevent the "Claude spawning Claude" block. NanoClaw uses full container isolation (Docker/Apple Containers) — this is correct for NanoClaw's threat model (untrusted WhatsApp messages running code) but overkill for "my Claude directing my other Claudes." We use Gueridon's lighter pattern.

### Daemon polls Gmail directly, not via mise

Mise is an MCP server — MCP tools are only accessible inside a Claude session. The daemon is not a Claude. Polling Gmail ("any new mail?") is a simple REST API call using jeton OAuth tokens. The daemon calls the Gmail API directly. Only when there IS mail does it spawn a Claude agent that uses mise for rich operations (fetch thread, draft reply, etc.).

### Draft-only email by default

Consensus from research: "I trust these agents to write code way more than I trust them to write an email" (Harper Reed). The daemon's agents draft replies; Sameer reviews and sends from Gmail. The `send` operation exists only in the daemon's mise deployment (see below).

### Mise send isolation: structural, not config

The `send` operation for email must NEVER exist in the ITV mise installation. This is enforced structurally — the code literally doesn't exist in that deployment — not by a config flag that could be accidentally enabled. Implementation options:
- Daemon-specific branch of mise-en-space that carries `tools/send.py`, rebased onto main
- Plugin directory: mise loads tools from an external dir, `send.py` lives outside the repo
- Separate fork

Decision on which approach: deferred to implementation time.

### Separate OAuth client for planetmodha.com

The daemon uses an OAuth client registered in Sameer's planetmodha.com Google Cloud project. This client mints tokens for `claude@planetmodha.com` with `gmail.modify` scope (includes send). The ITV mise instance uses a completely different OAuth client that has no send scope. Two clients, two scopes, two accounts — no shared credentials.

### TypeScript for the daemon

Gueridon is TypeScript. NanoClaw is TypeScript. The Agent SDK has TypeScript bindings. The reference implementations to crib from are all TypeScript. Path of least friction.

### One daemon process, multiple contexts

Like NanoClaw: single Node.js process with per-context queues. Not one daemon per project. Contexts are identified by folder path (for code projects) or thread ID (for email).

## Decisions Rejected

### Claude Code Agent Teams

Ruled out. The compaction bug is fatal — the lead Claude loses awareness of the entire team when context compresses. Add zombie teammates (20+ orphaned processes, ~8GB RAM), no resume support, spawn failures, and invisible permission prompts in VS Code. The feature is experimental and the bug surface is wide. We build our own orchestration.

### NanoClaw as the daemon substrate

Considered using NanoClaw directly. It's well-built (~700 lines, clean architecture, proven patterns). But it doesn't know about our memory stack (handoffs, bon, garde-manger, skills), doesn't have the reflector pattern, and its container isolation is heavier than we need. We steal its patterns (FIFO queue, trigger normalization, stdout markers) but build our own daemon.

### Sophisticated prompt generation as primary leverage

Research found that Carlini's C compiler project used one static prompt for 16 agents and produced 100k lines of working code. The leverage came from environment design (tests, progress files, lock-based task claiming), not prompt sophistication. Our conductor Claude generates prompts, but the primary investment should be in environment files (CLAUDE.md, handoffs, bon state, tests) that orient any fresh Claude.

### OpenClaw's architecture

Too sprawling (247k stars, moving to OpenAI foundation, 17% of community skills flagged malicious). We steal three specific patterns:
- HEARTBEAT.md checklist for batched periodic checks
- Pre-compaction memory flush
- Lane Queue modes (steer/followup/collect)

### IMAP/local indexing for email

Previous exploration (captured in a prior session) evaluated Himalaya, Neverest+notmuch+Mirador, and concluded: Gmail API via mise is simpler and more capable. Gmail indexes server-side, parses MIME for us, and supports push notifications. Don't rebuild the service locally.

## Reference Implementations

### Spawn pattern: Gueridon bridge.ts

`~/Repos/gueridon/server/bridge.ts` lines 326-345:
- `spawnCC()` function strips `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` from env
- Sets `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` and other headless flags
- Spawns with `stdio: ['pipe', 'pipe', 'pipe']`
- Uses `--input-format stream-json --output-format stream-json`

### FIFO queue: NanoClaw group-queue.ts

`~/Repos/nanoclaw/src/group-queue.ts`:
- `GroupQueue` class: per-group state (active, pending messages, pending tasks)
- Global concurrency limit (configurable, default 3)
- `enqueueMessageCheck()` and `enqueueTask()` as entry points
- Exponential backoff on failure (5s base, max 5 retries)
- `drainGroup()` runs pending tasks before pending messages

### Trigger normalization: NanoClaw index.ts

`~/Repos/nanoclaw/src/index.ts`:
- All channels → SQLite → polling loop (2s) → per-group queue → `runAgent()`
- `getNewMessages()` checks for messages since `lastAgentTimestamp[chatJid]`
- Cursor tracking per context group

### Session resume: Gueridon bridge-logic.ts

`~/Repos/gueridon/server/bridge-logic.ts`:
- `buildCCArgs()` passes `--session-id` (fresh) or `--resume` (continuing)
- Session staleness check (7 days) → fresh if stale
- Exit marker detection → fresh if previous session exited cleanly
- `--append-system-prompt` for role-specific context injection

### Orphan management: Gueridon orphan.ts

`~/Repos/gueridon/server/orphan.ts`:
- Tracks active PIDs in JSON file
- On startup: SIGTERM orphaned processes, escalate to SIGKILL after 3s
- Walks `/proc/[pid]/task/[pid]/children` for descendants

### Task scheduling: NanoClaw task-scheduler.ts

`~/Repos/nanoclaw/src/task-scheduler.ts`:
- Cron, interval, and one-shot scheduling
- Tasks enqueue into the same per-group queue as messages
- `computeNextRun()` anchors to scheduled time (not now) to prevent drift

## Key Research Findings

### Context ratio leverage

Anthropic's multi-agent research achieved 90.2% improvement over single-agent. Token usage explains 80% of performance variance. Multi-agent uses ~15x more tokens. Upgrading model quality produces larger gains than doubling token budget.

### Fresh eyes principle

Meta-prompting paper (Suzgun & Kalai, 2024): each expert starts without prior context, preventing "doubling down on mistakes." This validates the worker/reflector alternation — each reflector starts fresh.

### Environment-as-prompt

Carlini's C compiler: 16 agents, one static prompt, $20k, 100k lines. The leverage is in test harnesses and progress files, not sophisticated orchestrator prompts.

### Pre-compaction memory flush

OpenClaw's best pattern: before compaction, agent saves critical state to external files. This prevents catastrophic context loss. Implemented via PreCompact hook in Agent SDK.

### The biggest open risk

Context compaction in long-running roles. No system has fully solved it. Our answer: the reflector pattern doubles as a compaction mechanism — spawn a reflector when context pressure rises, it summarizes into a handoff, next worker starts fresh.
