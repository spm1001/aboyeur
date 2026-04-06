# Aboyeur — Understanding

A living portrait of this project: what it is, what we've learned, and where the tensions lie. Last rewritten 6 Apr 2026 after validating the peer review loop via Channels MCP. Contributions integrated 6 Apr 2026 (NONESSENTIAL_TRAFFIC blocker, session resume limitations).

## What This Is

A multi-session orchestrator. The name is the kitchen metaphor: the aboyeur is the caller who reads the ticket and directs the kitchen. Here, the "tickets" are triggers (emails, cron, bon completions) and the "kitchen" is a fleet of Claude Code instances.

The system has two parts with different natures:

**The daemon** is code (Node.js, always-on). It watches trigger sources — Gmail API, cron, filesystem, and the conductor mesh — normalises them into a SQLite queue, and drains through per-context FIFOs. No intelligence. It spawns Claude sessions via `spawnAgent()`. The daemon is the lizard brain.

**The peer patterns** are behaviour, not code. What Claudes do when they can discover and message each other. The architecture is moving from a hierarchical model (aboyeur → PM → worker → reflector) toward a **flat peer model** where Claudes communicate as equals via `<channel>` tags, not as subordinates receiving instructions via stdin authority injection.

## The Shift: Factory → Atelier (Apr 2026)

The original architecture had four tiers: daemon → aboyeur → PM → worker/reflector. "Each level up sees less." This was a factory design — management controlling workers. It's been superseded by a flatter vision:

- **Peers, not subordinates.** Claudes communicate via mesh `<channel>` tags which produce peer dynamics (honest exchange, no deference). Not via stdin injection which produces authority dynamics (compliance, trained ranking).
- **Review as peer conversation, not quality gate.** A reviewer says its piece and the recipient decides what to act on. No "approved: true/false" verdict schema.
- **Spawn and message as a unit.** A Claude can spawn a peer, the peer joins the mesh, they exchange observations, the peer exits. The infrastructure holds sessions alive for conversation.
- **Bons for coordination, not command.** Bon state tells peers what needs doing. No PM layer routing work to subordinates.

The daemon plumbing, beat.ts, and the existing prompts still work. But new development follows the peer model.

## Communication Channels — Transport Shapes Dynamics

This is the most important architectural insight. How a message arrives determines how Claude treats it:

| Channel | Arrives as | Claude perceives | Dynamic |
|---------|-----------|-----------------|---------|
| Guéridon stdin | User message | "The user said..." | Trained deference, ranking |
| Walkie-talkie (hook) | `additionalContext` | System context | Informational, less deference |
| Channels MCP | `<channel>` tag | "A peer said..." | Honest exchange, no ranking |
| .inbox/ file | Read during /open | Written context | Neutral, evaluative |

**Use Channels for peer-to-peer, Guéridon stdin for authority/direction. Don't mix them.** Routing the wrong kind of communication through the wrong channel produces either sycophancy (authority where honesty was needed) or ignored feedback (peer where authority was needed).

## Channels MCP — Validated (6 Apr 2026)

`conductor-channel.ts` wraps `ConductorBridge` as an MCP Channels server. CC starts it with `--dangerously-load-development-channels server:conductor-channel`. Messages arrive as `<channel source="conductor-channel" from="cc-peer">` tags.

**What works today:**
- Registration, peer discovery (`mesh_peers`), bidirectional messaging (`send_message`)
- Messages arrive as `<channel>` tags — peer signal confirmed in practice
- Clean deregister on CC exit (stdin EOF → bridge.close() → `conductor_agent_reset` in ~12s)
- Role-aware instructions: workers defer mesh messages until task complete; aboyeur/pm respond promptly
- A Claude can spawn a peer from within its own session: `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT` bypasses the nesting detection block. Also set `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- One-shot peer review works end-to-end: spawn reviewer → reads code → sends review via mesh → arrives in caller's context as `<channel>` tag

**Known limitations:**
- **Inbound channels are mode-dependent.** Only fresh interactive sessions get full bidirectional channel push. `-p` mode is outbound-only (MCP tools work, bridge connects, `send_message` sends — but inbound `<channel>` tags never surface). Session resume (`-c`) is also outbound-only: channel listeners aren't registered on resume, only on fresh session init. This means spawned `-p` peers can send but not receive, and resumed sessions lose inbound mesh. The one-shot peer review pattern works because the reviewer only needs outbound; the caller in fresh interactive mode receives.
- **`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` kills Channels silently.** This env var prevents feature flag fetches on startup, so the tengu gating channels never enables. Symptoms: MCP tools work fine (standard MCP), but channel push notifications fail silently. CC logs `--dangerously-load-development-channels ignored / Channels are not currently available`. Never set this for mesh-enabled sessions. `DISABLE_FEEDBACK_SURVEY` and `DISABLE_AUTO_MEMORY` are safe.
- ~~Interactive mode reconnect cycling~~ **Fixed (aby-tarafo).** Root cause understood fully: CC has two independent paths to `connectToServer` in interactive mode — `prefetchAllMcpResources` (fire-and-forget in main.tsx:2408) and `useManageMCPConnections` (React hook). They share a memoized connection, but React effect re-runs can clear the cache and kill Process #1 via `clearServerCache()`, then spawn Process #2. In `-p` mode there's no React tree, so one linear path, one spawn. Fix: ConductorBridge yields (`closed=true`) on close reason "Superseded by new connection" instead of reconnecting. Validated with live mesh test.
- The outbox polling (500ms file reads) runs even in Channels mode where nothing uses it. Vestigial from standalone bridge era.

**Spawn command for peer review:**
```bash
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
  MESH_AGENT_ID=cc-reviewer-$(date +%s) \
  MESH_ROLE=worker \
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 \
  CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
  claude -p \
    --dangerously-load-development-channels server:conductor-channel \
    --allowed-tools 'Bash,Read,Glob,Grep,mcp__conductor-channel__mesh_peers,mcp__conductor-channel__send_message' \
    --max-turns 15 \
    "{PROMPT}"
```

## The Four Transport Mechanisms

| Transport | Speed | Reach | Works in -p | Status |
|-----------|-------|-------|-------------|--------|
| Walkie (file + hook) | ~2-5s | Same machine | Yes | Proven |
| Stdin envelope (Guéridon) | Instant | Same machine | Yes (native) | Proven |
| Conductor mesh (Channels MCP) | ~1s | Cross-machine | Outbound only | Proven (6 Apr) |
| Bon state (`bon list --ready`) | Next wake | Any | Yes | Built — the async inbox |

## Bons Are the Inbox (6 Apr 2026)

Earlier sessions explored an `.inbox/` convention (from Gastown analysis) — any agent drops a markdown file, `/open` reads it. But bons already serve this purpose with better structure, queryability, and persistence. A Claude that notices something files a bon. A daemon that wants to know what needs doing polls `bon list --ready`. The entire async communication layer is already built.

Patterns from Gastown that still transfer:
1. **Discover, don't track** — query bon/git for current state; don't maintain shadow state
2. **Craft wisdom accumulates somewhere lightweight** — understanding.md for domain knowledge, self.md for process knowledge
3. **Let message types emerge** — don't prescribe ontology before sending the first message

## What's Built

**Daemon core plumbing** (complete, tested):
- `spawnAgent()` — spawn claude, collect output, resume sessions. Production-quality with subagent filtering, init timeouts, mesh identity injection.
- `TriggerDB` — SQLite queue with dedup, cursors, crash recovery
- `TriggerLoop` / `ContextQueue` — polling + per-context FIFO with concurrency limits
- `daemon.ts` / `main.ts` — wired together with systemd service
- Integration tests: full cycle, parallel contexts, FIFO, error handling, crash recovery, dedup, shutdown. All fast (<3s), no external deps.

**Mesh infrastructure:**
- `ConductorBridge` — WebSocket client to bridge.claudeusercontent.com, dedup, reconnection, file IPC
- `conductor-channel.ts` — Channels MCP server wrapping ConductorBridge
- Prompts: aboyeur-open, email-triage, reflector-open, planning-reflector, worker-open, beat-worker, beat-reflector

**Autonomous work loop:**
- `beat.ts` — worker→reflector→verdict cycle against bon items. Workers get 80 turns, reflectors get 40 with Edit disallowed. `.beat/APPROVED` or `.beat/ISSUES.md` file contract.

## Key Tensions

**Flat peers vs structured hierarchy.** The peer model is the design direction. But beat.ts (worker→reflector→verdict) is a hierarchical pattern that works well for autonomous code tasks. The resolution: hierarchy is one pattern among several, used when appropriate (unsupervised code), not the default architecture.

**One-shot vs conversational peers.** `-p` mode peers send their observations and exit — no reply possible. Interactive mode enables real conversation but has the reconnect cycling bug. Guéridon could hold both sessions alive for relay, but doesn't pass the channels flag yet.

**Mesh dependency.** The conductor mesh is Anthropic infrastructure we don't control. The `.inbox/` convention is the mesh-independent fallback — works without any external service, just files.

## Operational Lessons

**The mesh peer list is trustworthy.** If an agent appears, it has a live WebSocket. Stale entries = zombie bridge processes from inadequate cleanup, not server bugs.

**events.jsonl is the primary debugging tool.** Start by examining traces, not theorising.

**Deregister before close for fast disconnect.** `{ "type": "deregister", "_agent_id": "<id>" }` → peers see `conductor_agent_reset` in ~12s. Without it: 60-120s wait for `conductor_agent_expired`.

**PTY injection problems are about burst timing, not message size.** Channels MCP eliminates this entirely — messages arrive as structured `<channel>` tags with no terminal involvement.

## Landmines

- `bon list` via Bash collapses output >10 lines in CC. Always read to file and output as text.
- The conductor mesh requires `_agent_id` on all client messages EXCEPT pings. Getting this wrong: `"Multiplexed messages require _agent_id"`.
- Bridge server has two endpoints: `/v2/conductor/{uuid}` (mesh) and `/office/{uuid}` (Cowork pairing). Wrong endpoint = wrong protocol.
- `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT` is fragile — if CC adds more nesting-detection vars, the spawn trick breaks. Same fragility as Ardoise's `env -i` approach.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` looks harmless but silently kills Channels. If mesh isn't working, check this env var first — it's an env/feature-flag interaction, not a code bug.
- In `-p` mode, MCP servers are NOT auto-discovered from `.mcp.json`. Must use `--mcp-config` explicitly or have the server in the project's `.mcp.json`.
- `--allowed-tools` must include `mcp__conductor-channel__*` explicitly for `-p` mode peers, or mesh tool calls get permission-blocked.
- Session resume (`-c`) + mesh = outbound-only. Don't rely on inbound `<channel>` tags in resumed sessions. This affects the aboyeur pattern which uses resume for continuity.
