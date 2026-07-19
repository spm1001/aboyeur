# Aboyeur — Understanding

A living portrait of this project: what it is, what we've learned, and where the tensions lie. Last updated 15 Jul 2026 (bun made the canonical mesh runtime — Phase 3/aby-bosuwa; send_message reports delivery truth — aby-nowabu). Full rewrite 6 Apr 2026 (peer review loop via Channels MCP).

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
- **Auto-naming (8 Apr 2026; collision fix 15 Jul 2026, aby-pupaso):** When `MESH_AGENT_ID` is not set, `deriveAgentId()` builds `cc-{folder}-{first8 of session UUID}` via the shared `meshAgentId()` helper (`src/mesh-id.ts`), taking the UUID from `CLAUDE_CODE_SESSION_ID` (CC sets it at MCP-spawn). Race-free and stable across resume, so two sessions in one cwd get **distinct** ids. Falls back to the most-recent-JSONL scan only if that env var is absent (older CC), then bare `cc-{folder}`. `statusline.sh` mirrors `meshAgentId()` in bash to light the `⬡` glyph; the two are kept in lockstep by `mesh-id-seam.test.ts`. `MESH_AGENT_ID` still overrides for explicit naming (spawned peers). *(Was: read the most-recently-modified JSONL and claimed "unique per concurrent session" — false for same-cwd concurrency: 114 supersessions, both offline.)*
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
- **Our client swallows the rejection.** `bridge.send()` returns void; the `send_message` tool mints `"sent to <peer>"` unconditionally (conductor-channel.ts:155-158) while the error is already sitting in events.jsonl. The bridge *does* emit the `error` event. **FIXED 2026-07-15 (aby-nowabu, commit 693bc63):** `ConductorBridge.sendAndConfirm()` races a ~200ms window against that error (attribution by construction — sends are serial; `conductor_error` has no correlation id), and the `send_message` tool now returns `delivered to X (server accepted)` / `NOT delivered to X: <error>` instead of minting `sent`. Live-bridge test + end-to-end tool probe both green.
- **Roster is eventually-consistent; routing is instant truth.** A fresh peer registering 4s after a crash still received a roster event announcing the dead agent as connected, while sends to it bounced. `mesh_peers` can show dead peers for the expiry window (60–120s); the only reachability test is a send + watching for the synchronous error. This half-revises the old "peer list is trustworthy" lesson (see Operational Lessons).
- **The roster-ghost — a PERMANENT phantom, not just the expiry window (2026-07-15).** Distinct from aby-paluvu's heartbeat re-fire and aby-darode's stale status-file. Mechanism: the bridge's roster **replay** on connect hands a session *born after a peer died* that peer's stale `connect` event — *without* the disconnect that already happened — and the later `expire` never reaches the replay-informed session, so it carries that ghost in `mesh_peers` for the rest of its life. **Our removal code is correct** (evicts on live disconnect/offline/expired/reset — `conductor-bridge.ts:418/452`; proven by an older session evicting the same peer live). It's a **server-side replay gap**, not our bug. Harmless now: routing evicts instantly and nowabu surfaces "Agent not found" the moment you actually message the ghost. **Rule: roster is advisory; routing is truth.** Decided *against* a client-side prune — false-drop risk for live-but-quiet peers outweighs the cosmetic gain.
- **The flag/plugin converts transport-arrival into a context tag — proven 2026-07-14 via a live two-session test.** A **flag-born** session (started with `--dangerously-load-development-channels`) receives a peer's `send_message` both at transport AND as a `← conductor-channel:` tag it can act on (full membership). A **flagless** session that merely loaded the MCP server (e.g. via reload — tools present, no flag) still receives the message *at its bridge transport* (events.jsonl) but CC **silently drops it at the surfacing layer** — it never becomes a tag. So flagless = outbound-only in practice: can send, can't act on inbound. This is exactly what sonnette (plugin + managed-settings allowlist) exists to fix: make every session *born* with the channel so inbound surfaces without the manual flag. (Corollary: this preserves the no-loss finding — the drop is at the CC context layer, not the wire.) Also observed live: a flagless reloaded session ran TWO `node dist/conductor-channel.js` processes (the aby-tarafo dual-path) sharing one bridge dir.
- **Design consequence (the rinisa input, one sentence):** wake for a not-running Claude cannot ride the mesh — it needs a spawner (gueridon/daemon) or durable state read at birth (bons) — and Tend's doorbell-not-payload becomes near-mandatory: durable content in bons/files, the mesh carrying only live-peer nudges, with the synchronous error as the trigger to fall back to durable coordination.
- **Watch (minor):** one harness run showed the first of three arrivals present at transport (events.jsonl) but missing from the client's stdout `message`-event trace — transport is the instrument of record; don't build on emission logs until this is understood.
- **The sound test method** (keep using it): two independent per-end tallies — fixed run-nonce + seq per *actual* send, receiver reports every `(nonce, seq)` in arrival order, diff the sets. A send-ack is a claim; only the cross-end diff is a measurement.

## Phone-a-friend proven end-to-end — SOLO, CROSS-LOCUS (2026-07-19 spike)

The see/consult/wake model is no longer theory. The full chain ran live, first try, from one interactive session with **no second human-opened session**:

- **A session woke a sibling in a DIFFERENT locus (`~/notes`), born on the mesh, and got a consult back.** `cc-aboyeur-4b28a2df` spawned `cc-notes-friend-…` with `cwd=~/notes`; the sibling read notes files the caller doesn't have loaded (`gardener-disciplines.md` et al.) and sent its findings to the caller's id via `send_message`. Arrival confirmed at the caller's **bridge transport** (`events.jsonl`, `dir:recv conductor_message _for_agent_id:cc-aboyeur-4b28a2df`) — not a self-report. (Tag-surfacing to the caller's context expected on the next turn boundary; transport arrival is the measured fact.)
- **KEY REFINEMENT to "how close": the one-shot phone-a-friend flow needs NO sonnette and works from ANY cwd TODAY.** The cwd-binding + dev-flag blocker we thought gated everything only gates the *always-on interactive bidirectional* case (talking to an ALREADY-RUNNING sibling anywhere). For "wake a fresh sibling, ask it one thing, get the answer back," a `-p` spawn with `--mcp-config <temp.json>` pointing `conductor-channel` at the **ABSOLUTE** `src/conductor-channel.ts` path sidesteps cwd entirely: the mesh room is account-keyed (cwd-independent) and bun resolves `node_modules` from the `.ts` file's dir, not cwd. So the WAKE + one-shot CONSULT MVP is buildable now; sonnette (aby-cusera) is only needed for the live-already-running-sibling case.
- **Working recipe** (the MVP skill's core), from a caller in any cwd:
  ```bash
  # temp.json: {"mcpServers":{"conductor-channel":{"command":"bun","args":["<ABS>/aboyeur/src/conductor-channel.ts"]}}}
  env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
    MESH_AGENT_ID=cc-<friend>-$(date +%s) MESH_ROLE=worker \
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
    claude -p --mcp-config /tmp/temp.json \
      --dangerously-load-development-channels server:conductor-channel \
      --allowed-tools 'Bash,Read,Glob,Grep,mcp__conductor-channel__mesh_peers,mcp__conductor-channel__send_message' \
      --max-turns N "<prompt naming the CALLER's mesh id as the send_message target>" < /dev/null
  ```
  The `< /dev/null` skips a 3s "no stdin data received" wait — the one friction the spike surfaced. cwd for the spawn = the target locus (its Read/Grep operate there).
- **Design principles harvested from the notes locus (the aby-rinisa convergence inputs), in the notes-sibling's words:** (1) **doorbell not payload** — a wake carries ids+counts, never source text; the woken agent asks the repo for its work; untrusted content must never ride the channel that activates an agent; (2) **steal invariants not machinery** — git already gives atomicity/audit/rollback/diff-accountability; don't build capability tokens/claim-ledgers unless there are irreversible external actions, no git, or concurrent lanes on a shared queue; (3) **an empty run is a correct run** — record "nothing to do" and stop, no padding; (4) **every atom accounted for** — moved/merged/deliberately-retired, never silently dropped; (5) **state which safety properties are mechanically ENFORCED vs procedurally EXPECTED**. Shelf until concurrency bites: lane fencing, ledger-gated completion, digest-bound approval.

## Sonnette allowlist probe — dialog-free is REACHABLE, but SERVER-SIDE only on Teams (2026-07-19)

Ran the decisive probe (Sameer confirmed the Teams channels switch is flipped server-side). Verdict:

- **The plugin channel path is dialog-free and the plugin works.** `sonnette` (aboyeur's `.claude-plugin/plugin.json`) installs cleanly from a local Directory marketplace (`claude plugin marketplace add <aboyeur>` → registers `aboyeur-local`; `claude plugin install sonnette@aboyeur-local`), loads its MCP server, and the bridge connects (glyph lights). An interactive `claude --channels plugin:sonnette@aboyeur-local` shows a NOTICE, not a warning-dialog. **aby-zufefu (packaging) is substantially de-risked** — the plugin form works.
- **The gate is the allowlist, and the LOCAL /etc file is SHADOWED on Teams-with-switch.** With `channelsEnabled` flipped server-side, server-managed settings are non-empty, and CC's rule is "sources don't merge — if server-managed delivers ANY keys, the endpoint-managed (`/etc/claude-code/managed-settings.json`) file is ignored entirely." **Confirmed empirically:** wrote `/etc/claude-code/managed-settings.json` with `{channelsEnabled:true, allowedChannelPlugins:[{marketplace:"aboyeur-local",plugin:"sonnette"}]}` → fresh interactive launch STILL printed `plugin:sonnette@aboyeur-local · not on the approved channels allowlist`. Zero effect. (File removed after — a shadowed policy file that would silently activate if the server switch ever flips off is a latent surprise.)
- **CORRECTION (later same session — my earlier "shadowed → set it server-side in the admin console" was over-confident and probably wrong on the mechanism).** Two findings overturned it: (a) **Sameer checked the admin console — there is NO allowlist field**, only the on/off toggle + a description ("users connect channel servers via --channels and choose which to trust"). So there's no cloud-console place to allowlist a custom plugin on Teams. (b) A second guide pass surfaced a non-shadow candidate cause for the local file's failure: **GitHub #43064 — "the channel allowlist is ignored for LOCALLY-installed plugin channels."** Our sonnette was a **local Directory-marketplace** install, so it may hit exactly that bug rather than (or as well as) server-shadowing.
- **True state (not a confident causal story — this is an opaque layer):** the local `/etc` `allowedChannelPlugins` had **zero effect on a local-install plugin**, with cause **unpinned** (server-shadow vs #43064). Team-plugin scope is **orthogonal** to channel approval (guide, docs-confirmed) — being an org Team plugin does NOT auto-approve its channel; only `allowedChannelPlugins` does. The docs guidance is **self-inconsistent** (one pass: server-managed shadows /etc, Teams needs cloud admin; next pass: "/etc file-based confirmed working") — so trust the measurement, not the docs, and only a test of the REAL package decides.
- **Revised deployment path (the real aby-zufefu):** dialog-free is only *testable* with a **properly-packaged** sonnette — installed from a real **git/public marketplace** (NOT a local Directory), with its `node_modules` **vendored** (deps aren't in git — the open packaging sub-problem the bun migration was partly meant to ease). Only then retry the `/etc` allowlist: if it now approves → cause was #43064 (non-local install fixes it); if still denied → server-shadow (needs Enterprise server-managed, which Teams likely lacks). Until that build lands, **dev-flag `-m` (per-launch dialog) is the ONLY works-today mesh-at-birth path**, and `/consult` (one-shot spawn, no sonnette) already delivers the phone-a-friend ask regardless.
- **Probe teardown:** the `/etc` file was removed; sonnette@aboyeur-local + the aboyeur-local marketplace were probe installs (user scope) — remove with `claude plugin uninstall sonnette@aboyeur-local` + `claude plugin marketplace remove aboyeur-local` unless kept for the vendored-package retest. The `.claude-plugin/marketplace.json` in aboyeur is a probe scaffold (may become the real vehicle or be removed).
- **Mechanics learned:** `--channels` is VARIADIC — put the `-p` prompt BEFORE `--channels`, or the prompt is swallowed as a channel entry. A non-allowlisted plugin channel is a soft no-op with a notice (never the dev-flag warning). The schema (guide, docs-confirmed): top-level `channelsEnabled` + `allowedChannelPlugins:[{marketplace,plugin}]` at `/etc/claude-code/managed-settings.json`.

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
- **Tube's node is v20.19.2** (apt-capped; system node is load-bearing for gueridon's native node-pty, so do NOT upgrade it) — no native TS type-stripping, no built-in WebSocket. So the no-build hot path means bun. **bun IS installed on tube** (userland `~/.bun`, reachable via a `~/.local/bin/bun` symlink so `command:"bun"` resolves in the MCP-spawn PATH — that dir is on it, `~/.bun/bin` is not). Phase 0 done. src/ has no enums/namespaces (fully erasable TS), so bun-compat is clean.
- **aby-cusoru's briefs are hezza-worded** ("24h of hezza use", hezza paths) — re-ground them to tube when picking it up.
- **Phase 3 (aby-bosuwa) DONE 2026-07-15:** `.mcp.json` + sonnette `plugin.json` now point at `bun src/conductor-channel.ts`; `.mcp.bun.json` deleted (redundant — `.mcp.json` IS the bun config). bun is the canonical mesh runtime; soaked 27min clean under real load (live node↔bun + Vertex↔Teams round-trips). **The runtime decision (Option B, 2026-07-15):** mesh is bun-only; node is NOT upgraded (gueridon). **Fleet note:** the shipped sonnette plugin says `command:"bun"`; every target machine needs bun on a standard PATH dir (aby-zufefu/lesefu).
- **Phase 2 (aby-giwohi) DONE 2026-07-15 — `ws` dropped for the built-in WebSocket.** `import WebSocket from "ws"` removed; the 4 event handlers converted from `ws`'s `.on()` to WHATWG `addEventListener` in `conductor-bridge.ts`; `ws` + `@types/ws` uninstalled (`.dependencies.ws` is null, node_modules pruned). The event params are **inferred from the WebSocket event map** (no explicit `CloseEvent`/`ErrorEvent` annotations — those names aren't globals under `@types/node@22`; the map still types them). Sharp edge cleared: the WHATWG close event is a single `CloseEvent{code, reason:string}` (not `ws`'s two-arg `code, Buffer`), and the `reason === "Superseded by new connection"` supersession match still fires. The `error` event is a **bare `Event`** (no `.message`) — read defensively. tsc clean; verified live under bun (a 2-bridge harness: connect + bidirectional exchange + **63s soak, zero disconnects** + supersession-yield-no-flap, ALL PASS), and the 4 bridge test files (`conductor-bridge-supersede`, `send-confirm`, `deregister-timing`, `mesh-id-seam`) pass 6/6 under `bun test`.
- **Phase 4 (aby-pizufo) DONE 2026-07-15 — the test suite is SPLIT by runner.** node 20.19 (tube) has NO global `WebSocket` (landed unflagged in Node 21+), so with `ws` gone the WebSocket-touching tests HANG under `node --test`. They pass under `bun test` — but a naive `test: "bun test"` is WRONG: the DAEMON tests (`context-queue` etc.) use `describe()` inside `test()`, unimplemented in bun's node:test compat (bun #5090). So the two categories need different runners: **`test:channel`** = `bun test` on the 5 mesh tests (`conductor-channel`, `conductor-bridge-supersede`, `mesh-id-seam`, `send-confirm`, `deregister-timing`); **`test:daemon`** = `tsc && node --test` on the daemon `dist/*.test.js` (a **denylist `find`** excluding the 5, so new daemon tests auto-run and a stray channel test loudly hangs rather than being silently skipped); **`test`** runs both. `npm test` = 50 daemon + 8 channel = 58/58, matching the pre-migration baseline. `conductor-channel.test.ts` now spawns `bun src/…ts` (was `node dist/…js`). CI (`.github/workflows/ci.yml`) only runs `tsc --noEmit` (the live mesh tests need credentials CI lacks) — still green, no change needed.
- **Early-EOF leak in `conductor-channel.ts` FIXED 2026-07-15 (surfaced by Phase 4's test 1).** The stdin-close → `process.exit(0)` handler used to be attached AFTER `await bridge.connect()` (a ~1s network call), so if CC spawned the channel then disconnected during connect, the EOF was missed and **the process hung forever holding a mesh connection**. Pre-existing under BOTH runtimes — node's faster startup merely won the race; bun exposed it. Fix: register the `end`/`close`/SIGTERM shutdown right after `mcp.connect()` (stdin is flowing then) and BEFORE `bridge.connect()`, plus a `process.stdin.readableEnded` guard for the already-closed case. Verified: immediate-EOF now exits 0 under both bun and node; normal connect-stay-alive-then-close still works (test 2's ≥3s-alive check passes). **Lesson: an MCP stdio server must arm its stdin-EOF exit before any slow await, or a fast client disconnect leaks it.**
- **Phase 5 (aby-fiwato) DONE 2026-07-15 — no-rebuild hot path EMPIRICALLY PROVEN.** `.mcp.json` spawns `bun src/conductor-channel.ts` (no `dist/`). Verified end-to-end via a temp marker at the top of `conductor-channel.ts` and TWO real headless session-start spawns (`claude -p --dangerously-load-development-channels server:conductor-channel`, no `npm run build` between): fresh spawn #1 wrote `phase5-edit-1-…`, edit→`phase5-edit-2-…`→fresh spawn #2 overwrote it with the new value. So a `src/` edit is live on next session start with zero build step — the iteration-speed prize the whole Bun migration was for. Diagnostic removed (git diff empty = clean round-trip). **aby-cusoru (Bun, no build step) is now all but complete — Phases 0,1,2,3,4,5,7 ✓; only Phase 6 (aby-lezuhu, docs sweep) remains.**
- **Phase 1 (aby-kilopo) PASSED on tube, 2026-07-14.** Bun-run conductor-channel (`bun src/conductor-channel.ts`, tsc-style `.js` import specifiers resolved by bun unmodified): WS registration ✓; >60s soak with zero stale-pong (the Python killer) ✓; bidirectional exchange ✓ (3/3 inbound at transport, outbox-driven send delivered); supersession yield + 10s health-check `reconnect()` under bun timers ✓ (aby-tarafo behaviour intact); clean stdin-EOF shutdown ✓ (deregister, WS close 1000, process exit). MCP stdio layer ✓ — a `-p` session with `--mcp-config .mcp.bun.json` drove `mesh_peers` through the bun process. Artifacts: `.mcp.bun.json` + `npm run channel:bun`. **Interactive inbound ✓ (2026-07-14, live two-session test):** a bun-backed interactive session born with `--mcp-config .mcp.bun.json --dangerously-load-development-channels server:conductor-channel` received a real `send_message` from a peer, surfacing as a `← conductor-channel:` tag in its context. **Every layer of the bun migration is now proven — no remaining unknowns; bun is fully viable as the sonnette runtime.**
- **Deployment landmine found by the probe: MCP servers fail SOFT — a missing runtime means silent tool absence, no error.** The first MCP probe got no channel tools because this session's env predates tonight's bun install, so the child's PATH lacked `~/.bun/bin` and the `command: "bun"` spawn ENOENT'd silently. For sonnette this is the fleet risk: any machine (or launchd/systemd context) without bun on the CC process's PATH degrades silently. Mitigations to weigh at packaging time: absolute command path, a wrapper script that finds bun, or a loud preflight in the plugin.
- "Allowlisted" disambiguation: the **org-level** Teams Channels enablement is on (proven by the bridge working). The **machine-level** `allowedChannelPlugins` allowlist does not exist yet anywhere — that's aby-lesefu, gated on sonnette (aby-zufefu), gated on cusoru.

## Enmeshed by default — the sonnette → batterie push (2026-06-17)

Goal (Sameer): every *interactive* CC session enmeshed by default — see and talk to each other bidirectionally, no per-session dev flag, no approval dialog. Office/Cowork peers welcome but not the priority.

Proven live this session (CC 2.1.179, two CC sessions on hezza):
- **Bidirectional CC↔CC works.** Round-trip confirmed both directions via `<channel>` tags. The mesh *capability* is not in question — this push is distribution, not architecture.
- **The room is account-keyed, no coordination needed.** `conductor-bridge.ts:264-270` derives the room from `account.uuid` (via `/api/oauth/profile`), so every session on Sameer's account auto-shares one `/v2/conductor/{account-uuid}` room. CC↔CC is free; CC↔Office differs (Office uses per-conversation `/v2/conductor/{conversationId}` + cross-surface `/office/{userId}`). Cross-*user* mesh would need a non-account room key — out of scope.

Hard-won constraints (these shape every outcome below):
- **The channel binds only at FRESH session birth.** A `claude -c` resume cannot be retrofitted onto the mesh — it reuses the MCP-config snapshot from when the session was created. So "by default" means every *new* session is born with the plugin; an already-running conversation cannot be enmeshed. (The docs-agent's "resume inbound fixed June 2026" claim was empirically FALSE for retrofitting.)
- **ANSWERED 2026-07-15 (aby-wodagu — confound-free, cross-verified by both sessions): NO.** A flag-born session resumed (`-c`, into Vertex) receives mesh messages at TRANSPORT (confirmed in the resumed session's own events.jsonl) but they do NOT surface as `<channel>` tags — inbound *surfacing* dies on resume; transport-receive, outbound, and tools survive. Mechanism: `-c` reuses the MCP-config snapshot but never re-registers the channel LISTENER that turns transport arrivals into context tags (fresh init does). So "enmeshed by default" fully holds only for FRESH sessions; resumed/bg sessions are outbound-only until sonnette+allowlist lets them be re-born enmeshed. Gates the bg/resumed-heavy workflow. **Refinement from the 2026-07-14 reload experiment (confounded but instructive):** a flagless session that RELOADS does re-read `.mcp.json` and spawn MCP servers fresh (tools work — reload is fresher than resume's MCP-snapshot reuse), but gets no channel push, and the server's MCP instructions block still advertises `<channel>` tags — **the instructions block is not evidence of channel activation; only the flag (or allowlisted plugin) at session birth activates push.** Proper wodagu test design: born-with-flag session → harness ping (inbound confirmed) → reload → ping again. Three-birds session: `claude --mcp-config .mcp.bun.json --dangerously-load-development-channels server:conductor-channel` from a fresh shell (bun PATH!) also closes Phase 1's interactive-inbound residual.
- **MCP servers are NOT configured via `settings.json`.** Editing `settings.json` `mcpServers` is inert (verified 2026-06-17 — a fresh session reports "no MCP server configured with that name"). Real registration: `.mcp.json` (project), `~/.claude.json` (user, via `claude mcp add`), or a **plugin**. Plugins make a server global by construction — proof: `plugin:mise:mise` is in every session/cwd. **The plugin is the correct vehicle for "global everywhere."**
- **Team approval drops the flag AND the dialog:** `policySettings.allowedChannelPlugins: ["plugin:sonnette@batterie"]` in `/etc/claude-code/managed-settings.json` (machine-level; Sameer self-owns it on hezza + Mac). Honoured on Team/Enterprise; Max NOT supported (open feature request).
- **Plugin requirements already met:** plugin.json declares `mcpServers` (✓) and the server declares the `claude/channel` capability (✓ `conductor-channel.ts:122`, under `experimental`).
- **Build-step is a vendoring blocker → aby-cusoru is a PREREQUISITE, not optional.** sonnette's plugin.json points at `dist/conductor-channel.js`; batterie's `assemble.sh` vendors *clean clones* and `dist/` is gitignored — so the shipped plugin would point at a missing file. The Bun-run-from-`src` migration (aby-cusoru) removes the build step and is the clean fix. (Supersedes the 2026-06-09 "optional" note.) Fallbacks if Bun stalls: commit `dist/`, or a postinstall build.
- **batterie is assembled, never hand-edited.** Adding sonnette = wire `aboyeur` into `assemble.sh`'s PLUGINS map + `marketplace.json`, respecting the manifest-invariant and version-ratchet guards (batterie/CLAUDE.md). Marketplace name is **`batterie`** (the assembled artifact repo), not `batterie-de-savoir` — correct aby-zufefu's stale done-criterion.

Scope: Cowork (phone) / Office surfaces ride the separate `/office/{userId}` channel — parked, "welcome later" (a second connection, not a config flip). Not building cross-user mesh.
