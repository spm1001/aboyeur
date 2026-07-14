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
- **Auto-naming (8 Apr 2026):** When `MESH_AGENT_ID` is not set, `deriveAgentId()` reads the most recently modified JSONL in `~/.claude/projects/{encoded-path}/` and builds `cc-{folder}-{first8 of session UUID}`. Stable across resume (same JSONL), unique per concurrent session (different UUIDs). Falls back to `cc-{folder}` if no JSONL found. `MESH_AGENT_ID` still overrides for explicit naming (spawned peers).
- **Peer-driven /close (8 Apr 2026):** A Claude running /close can send its handoff draft to a mesh peer playing the role of reviewer/proxy. The peer provides feedback, promotes/demotes items, and the closing Claude incorporates it. Tested live — the peer provided genuine editorial judgment, not just approval.

**Channels approval path (8 Apr 2026 — explored, mapped):**
- `--dangerously-load-development-channels server:NAME` — full bidirectional, mandatory dialog each interactive session. No dialog in `-p` mode.
- `--channels plugin:NAME@MARKETPLACE` — loads from allowlist, no dialog. But `server:` entries can NEVER match the allowlist (schema mismatch: allowlist is `{plugin, marketplace}`, servers are structurally incompatible). Only `plugin:` entries can be approved.
- `allowedChannelPlugins` in `/etc/claude-code/managed-settings.json` — read by CC on all plans, but only respected for allowlist lookup on Team/Enterprise. Max plan falls through to GrowthBook (Anthropic-controlled).
- **Future path:** Package as a CC plugin named "sonnette" in `batterie-de-savoir` marketplace. On Team plan, self-approve via managed-settings. On Max plan, still need the dev flag.

**Known limitations:**
- **Inbound channels are mode-dependent.** Only fresh interactive sessions get full bidirectional channel push. `-p` mode is outbound-only (MCP tools work, bridge connects, `send_message` sends — but inbound `<channel>` tags never surface). Session resume (`-c`) is also outbound-only: channel listeners aren't registered on resume, only on fresh session init. This means spawned `-p` peers can send but not receive, and resumed sessions lose inbound mesh. The one-shot peer review pattern works because the reviewer only needs outbound; the caller in fresh interactive mode receives.
- **`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` kills Channels silently.** This env var prevents feature flag fetches on startup, so the tengu gating channels never enables. Symptoms: MCP tools work fine (standard MCP), but channel push notifications fail silently. CC logs `--dangerously-load-development-channels ignored / Channels are not currently available`. Never set this for mesh-enabled sessions. `DISABLE_FEEDBACK_SURVEY` and `DISABLE_AUTO_MEMORY` are safe.
- ~~Interactive mode reconnect cycling~~ **Fixed (aby-tarafo).** Two issues, two fixes:
  1. **Dual-path startup:** CC has two independent paths to `connectToServer` in interactive mode — `prefetchAllMcpResources` (fire-and-forget) and `useManageMCPConnections` (React hook). They share a memoized connection, but React effect re-runs can clear the cache and spawn a second process. Fix: ConductorBridge yields (`closed=true`) on "Superseded by new connection" instead of reconnecting.
  2. **Mid-session restart:** CC also restarts the MCP server ~3 min into a session (`clearServerCache()`). The new process supersedes us, then CC kills the new process. The old process (the survivor) has a dead bridge. Fix: conductor-channel.ts runs a 10s health check — if bridge is dead but stdin alive, calls `bridge.reconnect()`. A `recoveryAttempted` flag prevents flap loops (one recovery attempt, then stop). Validated: bridge survived mid-session restart and reconnected.
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

## Mesh Delivery Semantics — SETTLED (2026-06-17 aby-lizazu + 2026-07-14 aby-nevejo)

The mesh is a **synchronous presence fabric, not a message queue.** Complete picture, all measured:

- **To a live peer: lossless and order-preserving** (n=1, K=8, 06-17 hezza test). Receive-side coalescing observed (7 of 8 in one wake, order intact) — hypothesis, not measurement.
- **To an absent peer — never-registered, cleanly-departed, or crashed: synchronous rejection.** The server answers `conductor_error: "Agent not found: <id>"` within ~25ms of every send. Measured 07-14 on tube with a deterministic harness (`/tmp/mesh-harness.mjs` pattern — ConductorBridge driven directly, positive control passed first): never-registered (Test A), clean-exit-then-send (B1), SIGKILL-equivalent unclean death then send seconds later (B2) — all identical. **There is no store-and-forward.** Server-side "replay" (`events_replayed` on connect) is roster catch-up only — it replays peer connect/disconnect events, never messages.
- **Our client swallows the rejection.** `bridge.send()` returns void; the `send_message` tool mints `"sent to <peer>"` unconditionally (conductor-channel.ts:155-158) while the error is already sitting in events.jsonl. The bridge *does* emit the `error` event — it's just not wired into the tool result. Fix filed (aby-wozuvi). Note for the fix: `conductor_error` carries **no correlation id** — attribute by serial-send + short error-race window (~200ms).
- **Roster is eventually-consistent; routing is instant truth.** A fresh peer registering 4s after a crash still received a roster event announcing the dead agent as connected, while sends to it bounced. `mesh_peers` can show dead peers for the expiry window (60–120s); the only reachability test is a send + watching for the synchronous error. This half-revises the old "peer list is trustworthy" lesson (see Operational Lessons).
- **Design consequence (the rinisa input, one sentence):** wake for a not-running Claude cannot ride the mesh — it needs a spawner (gueridon/daemon) or durable state read at birth (bons) — and Tend's doorbell-not-payload becomes near-mandatory: durable content in bons/files, the mesh carrying only live-peer nudges, with the synchronous error as the trigger to fall back to durable coordination.
- **Watch (minor):** one harness run showed the first of three arrivals present at transport (events.jsonl) but missing from the client's stdout `message`-event trace — transport is the instrument of record; don't build on emission logs until this is understood.
- **The sound test method** (keep using it): two independent per-end tallies — fixed run-nonce + seq per *actual* send, receiver reports every `(nonce, seq)` in arrival order, diff the sets. A send-ack is a claim; only the cross-end diff is a measurement.

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

**The mesh peer list is trustworthy about the recent past, not the present.** (Revised 2026-07-14, aby-nevejo.) An agent in the list had a live WebSocket at some recent point — but the roster is eventually-consistent: a crashed peer can appear in `mesh_peers` (and in fresh peers' roster sync) for the 60–120s expiry window while every send to it bounces `Agent not found`. Routing evicts on socket close, instantly. Reachability = send and watch for the synchronous error, never the list.

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

## Portfolio status (2026-06-09 audit)

Split verdict from Sameer: the Channels system (Claude-to-Claude mesh) is "chef's kiss" — keep; the autonomous daemon is Someday/Maybe (aby-ratobi/volube waiting) — réceptionnaire took the Gmail-trigger job (aby-sanimu closed as superseded). Natural next action if picked up: finish sonnette plugin packaging (aby-zufefu — plugin.json exists, absent from marketplaces). The 8-phase Bun migration (aby-cusoru) is unstarted and optional. Reshape context: bds-hifusu.

## Tube is home now (2026-07-14)

Hezza is being turned off — tube is aboyeur's new home, per Sameer. State as verified this session:

- **Mesh boots from tube.** `npm install` + `tsc` built `dist/` on the tube clone; a throwaway `-p` peer with the dev channels flag registered, called `mesh_peers` cleanly (zero peers — alone on the mesh, as expected). The org-level Channels gate is open from tube. `/peer-review` is genuinely available here for any session started with the flag.
- **Tube's node is v20.19.2** — no native TS type-stripping (needs 22.6+), no built-in WebSocket (needs 22+). So the no-build hot path still means bun, and **bun is not installed on tube** — aby-cusoru's Phase 0 needs re-doing here. src/ has no enums/namespaces (fully erasable TS), so bun-compat is clean.
- **aby-cusoru's briefs are hezza-worded** ("24h of hezza use", hezza paths) — re-ground them to tube when picking it up. Oddity on the board: Phase 7 (the soak) is marked done while Phases 1–6 are open.
- "Allowlisted" disambiguation: the **org-level** Teams Channels enablement is on (proven by the bridge working). The **machine-level** `allowedChannelPlugins` allowlist does not exist yet anywhere — that's aby-lesefu, gated on sonnette (aby-zufefu), gated on cusoru.

## Enmeshed by default — the sonnette → batterie push (2026-06-17)

Goal (Sameer): every *interactive* CC session enmeshed by default — see and talk to each other bidirectionally, no per-session dev flag, no approval dialog. Office/Cowork peers welcome but not the priority.

Proven live this session (CC 2.1.179, two CC sessions on hezza):
- **Bidirectional CC↔CC works.** Round-trip confirmed both directions via `<channel>` tags. The mesh *capability* is not in question — this push is distribution, not architecture.
- **The room is account-keyed, no coordination needed.** `conductor-bridge.ts:264-270` derives the room from `account.uuid` (via `/api/oauth/profile`), so every session on Sameer's account auto-shares one `/v2/conductor/{account-uuid}` room. CC↔CC is free; CC↔Office differs (Office uses per-conversation `/v2/conductor/{conversationId}` + cross-surface `/office/{userId}`). Cross-*user* mesh would need a non-account room key — out of scope.

Hard-won constraints (these shape every outcome below):
- **The channel binds only at FRESH session birth.** A `claude -c` resume cannot be retrofitted onto the mesh — it reuses the MCP-config snapshot from when the session was created. So "by default" means every *new* session is born with the plugin; an already-running conversation cannot be enmeshed. (The docs-agent's "resume inbound fixed June 2026" claim was empirically FALSE for retrofitting.)
- **OPEN, MUST TEST:** does a session *born with* the channel retain inbound `<channel>` delivery across a later resume? Untested. Gates the bg/resumed-heavy workflow — if inbound dies on resume, "enmeshed by default" only half-holds for resumed sessions. Test before declaring victory.
- **MCP servers are NOT configured via `settings.json`.** Editing `settings.json` `mcpServers` is inert (verified 2026-06-17 — a fresh session reports "no MCP server configured with that name"). Real registration: `.mcp.json` (project), `~/.claude.json` (user, via `claude mcp add`), or a **plugin**. Plugins make a server global by construction — proof: `plugin:mise:mise` is in every session/cwd. **The plugin is the correct vehicle for "global everywhere."**
- **Team approval drops the flag AND the dialog:** `policySettings.allowedChannelPlugins: ["plugin:sonnette@batterie"]` in `/etc/claude-code/managed-settings.json` (machine-level; Sameer self-owns it on hezza + Mac). Honoured on Team/Enterprise; Max NOT supported (open feature request).
- **Plugin requirements already met:** plugin.json declares `mcpServers` (✓) and the server declares the `claude/channel` capability (✓ `conductor-channel.ts:122`, under `experimental`).
- **Build-step is a vendoring blocker → aby-cusoru is a PREREQUISITE, not optional.** sonnette's plugin.json points at `dist/conductor-channel.js`; batterie's `assemble.sh` vendors *clean clones* and `dist/` is gitignored — so the shipped plugin would point at a missing file. The Bun-run-from-`src` migration (aby-cusoru) removes the build step and is the clean fix. (Supersedes the 2026-06-09 "optional" note.) Fallbacks if Bun stalls: commit `dist/`, or a postinstall build.
- **batterie is assembled, never hand-edited.** Adding sonnette = wire `aboyeur` into `assemble.sh`'s PLUGINS map + `marketplace.json`, respecting the manifest-invariant and version-ratchet guards (batterie/CLAUDE.md). Marketplace name is **`batterie`** (the assembled artifact repo), not `batterie-de-savoir` — correct aby-zufefu's stale done-criterion.

Scope: Cowork (phone) / Office surfaces ride the separate `/office/{userId}` channel — parked, "welcome later" (a second connection, not a config flip). Not building cross-user mesh.
