# Plan: CC ↔ Conductor Mesh Integration (aby-foloko)

Session: 14 Mar 2026. Sameer and Claude worked through the design from first principles, proved the PTY wrapper concept, then Claude continued solo.

## What We Proved

### 1. PTY pass-through works
A ~90-line Python script creates a PTY, spawns `claude` on the slave side, passes all terminal I/O transparently. The user sees the real CC TUI — markdown, tool calls, permission prompts, everything. No custom renderer needed.

### 2. PTY injection works
Writing to the PTY master fd injects text into CC's terminal input as keystrokes. CC processes it as if the user typed it. Tested: text injected via Unix socket appeared in CC's input box and was processed as a prompt.

### 3. CC's TUI handles injection — with caveats
CC is built on **Ink** (React for terminals) running on Bun. It uses raw terminal mode with an alternate screen buffer and **bracketed paste** (`\x1b[?2004h`). Key findings from binary analysis:

- **Happy path (idle at prompt):** Injected text goes into the TextInput component. Enter submits. Works perfectly.
- **Mid-turn:** Type-ahead works — injected text queues and processes when CC becomes idle. Confirmed by Gueridon's empirical testing.
- **Permission prompts:** The PermissionRequest component captures focus. Injected keystrokes during a permission prompt go to the permission handler, **not** the input area. Cannot determine CC's UI state from outside.
- **Mitigation:** Use **bracketed paste sequences** (`\x1b[200~`...`\x1b[201~\r`) for injection. CC's paste handler inserts text literally. If a permission prompt has focus, the paste is likely ignored (graceful degradation, not catastrophe). `--permission-mode default` auto-approves most tools, making permission prompts rare.

### 4. Conductor mesh connects and messages flow
Bridge authenticates with CC's OAuth token, registers, gets protocol v2. Two test agents (Alice and Bob) exchanged messages bidirectionally through the production mesh — outbox.jsonl → bridge → WebSocket → mesh → bridge → inbox.jsonl. Full round-trip in ~1 second.

## The Design

### Architecture

```
mesh-claude (Python, ~150 lines, pure stdlib)
├── Creates PTY pair
├── Spawns claude on slave side (real interactive TUI)
├── Main loop: transparent terminal I/O via select()
├── Starts conductor-bridge.py as sidecar subprocess
│   └── Manages WebSocket to bridge.claudeusercontent.com
│       ├── Registration, ping/pong, reconnection
│       ├── inbox.jsonl ← inbound messages
│       ├── outbox.jsonl → outbound messages
│       └── peers.json — connected agents
├── Polls inbox.jsonl every 0.5s
│   └── New messages → inject into PTY master fd as keystrokes
├── Unix socket for external injection (testing, non-mesh use)
└── Installs `mesh` CLI tool for CC to use via Bash
```

### Key Decisions

| Decision | Rationale |
|----------|-----------|
| **PTY not `-p` mode** | Transparent CC experience beats custom TUI. User sees the real Claude Code. |
| **Sidecar not embedded WebSocket** | Reuses existing conductor-bridge.py. Clean process boundary. Bridge handles async WebSocket; wrapper stays synchronous with select(). |
| **File-based coordination** | inbox.jsonl for inbound, outbox.jsonl for outbound. Simple, debuggable, crash-recoverable. The bridge already uses this format. |
| **CLI not MCP for outbound** | `mesh send <id> "message"` via Bash is simpler than an MCP server. No session restart needed. Can evolve to MCP later. |
| **Identity from repo name** | `cc-{repo-name}` derived from cwd. Meaningful, human-readable. Collision handling deferred. |

### How the Office Agents Do It (reference)

The conductor mesh architecture was reverse-engineered from Anthropic's Office add-in bundle (168K lines, March 2026). Key insight: the Office add-in SPA holds both the API conversation loop AND the WebSocket to the conductor mesh. When a mesh message arrives, the SPA injects it into the next API turn as a `<conductor_context>` block. In serial mode, it auto-cycles turns without user input.

Our PTY wrapper is the CC equivalent of the Office SPA:

| Office SPA | mesh-claude |
|------------|-------------|
| WebSocket to mesh | conductor-bridge.py sidecar |
| In-memory KV Map | Filesystem (inbox.jsonl, peers.json) |
| `<conductor_context>` injection | PTY master fd write (keystrokes) |
| `send_message` tool | `mesh send` CLI command |
| Auto-cycle on reply | Inject → type-ahead → CC processes next turn |

### Message Format

Injected messages look like:
```
[mesh from cc-passe] Fix pushed to branch fix-fetch. Could you test?
```

CC sees this as user input. The `[mesh from ...]` prefix tells CC the source. CC can reply:
```bash
mesh send cc-passe "Tested, all good."
```

Newlines in message content are replaced with spaces (each \n in PTY input would submit a partial message).

## Mapping to the User's Scenario

### Beat 1: Session_Claude files a field report
Working in `~/Repos/passe/` via `mesh-claude`. Session_Claude runs `bon add` in passe. **Works today, no changes needed.**

### Beat 2: Something spawns Passe_Claude
Daemon's bon watcher detects new item in `~/Repos/passe/`. Spawns CC through the wrapper (headless variant). Passe_Claude starts working, registered on mesh as `cc-passe-worker`.

**Needs: bon watcher trigger source (daemon), headless mode (`--headless` flag).**

### Beat 3: Passe_Claude asks Session_Claude a question
Passe_Claude runs: `mesh send cc-session "Was it /fetch or /extract?"`. Message travels: outbox.jsonl → bridge → mesh → your bridge → inbox.jsonl → PTY injection. CC responds naturally.

**This is what aby-foloko delivers.**

### Beat 4: Anti-deferral nudge
Passe_Claude's CLAUDE.md includes the heuristic: "do it or bon it, no third option." **Prompt engineering, not mesh plumbing.**

### Beat 5: Passe_Claude pings Session_Claude
`mesh send cc-session "Fix pushed. Could you verify?"`. Arrives via mesh injection. Session_Claude presents it. User says "push on" → Session_Claude files a bon.

**Works with aby-foloko.**

### Beat 6: /close spots incomplete work
GODAR gather finds the "verify Passe fix" bon. Filing the bon triggers the bon watcher. System spawns a session to run the test.

**Needs: bon watcher trigger source (same as Beat 2).**

### Beat 7: Quiescence
No pending triggers, no unworked bons, no unread messages, no active sessions. The daemon's poll loop ticks quietly.

## The "Does the Daemon Need an Aboyeur?" Question

For bon-triggered spawning (new item in a watched repo), the daemon can spawn directly:
```
Daemon → new bon in ~/Repos/passe/ → spawn CC in ~/Repos/passe/
```

The aboyeur layer adds routing judgment — "is this a project or a one-shot?" But a bon in a specific repo is already routed. The context is the repo. The work is the bon.

The aboyeur earns its keep when:
- An email arrives and it's unclear which project it relates to
- A HEARTBEAT fires and multiple PMs need checking
- A one-shot promotes to a PM (something notices new bons were created)
- Something needs to choose between competing priorities

For simple "work appeared, go do it" triggers, the daemon can skip the aboyeur.

## What This Means for Gueridon

Gueridon already holds CC's stdin pipe (via `spawnCC()`). Adding a conductor mesh WebSocket to Gueridon's bridge would give all Gueridon-spawned sessions mesh identity automatically:

- Register each session on the mesh at spawn time
- Inbound mesh messages → `deliverPrompt()` (stdin injection, already exists)
- Outbound via MCP tool or Bash command

The mesh-claude PTY wrapper and Gueridon's stdin injection are different implementations of the same pattern. They could share the bridge sidecar.

## Open Questions

### Tested but not fully characterised
1. **Injection during active turn** — type-ahead works in principle. Need to verify with real multi-turn mesh dialogue.
2. **Permission prompt safety** — CC's TUI should handle invalid keystrokes at permission prompts gracefully. Need to verify with a contrived test.

### Design decisions deferred
3. **Multi-line messages** — replacing \n with spaces works but loses formatting. Alternative: escape as `\\n` and have CC's mesh awareness instructions handle unescaping.
4. **Mesh identity collisions** — multiple sessions in the same repo get the same `cc-{repo-name}`. Need disambiguator: `cc-{repo}-{session-short-id}`.
5. **CC mesh awareness** — CC needs instructions to handle mesh messages well. Options: global CLAUDE.md addition, project CLAUDE.md, or self-explanatory format. The `[mesh from ...]` prefix is a start but CC should also know about `mesh send/peers/inbox`.
6. **MCP vs CLI for outbound** — CLI is simpler (works now). MCP would give CC structured tool results and self-documenting tool descriptions. Consider for v2.

### Architectural
7. **The `-p` mode alternative is safer** — background research confirms that `-p --stream-json` mode gives deterministic JSON framing with no UI state ambiguity. Gueridon and Aboyeur both chose this for good reason. The PTY approach trades safety for UX (real CC TUI). For interactive sessions with a human present, the PTY risk is acceptable. For daemon-spawned headless sessions, `-p` mode is correct.
8. **Headless mode shares mesh code** — the bridge sidecar and `mesh` CLI work identically. Only the CC I/O layer differs: PTY master fd vs stdin pipe. Headless mode uses existing `spawnAgent()` patterns with mesh sidecar added. Could be a `--headless` flag or the daemon integrates the bridge sidecar directly into its spawn flow.

### Blocked on other work
9. **Token refresh** (aby-pamiwi) — bridge reads token once. Needs refresh detection.
10. **Mesh behaviour characterisation** (aby-dawugu) — does the mesh queue messages for offline agents? Affects spawn-on-message design.
11. **Bon watcher trigger source** — daemon doesn't poll bon state yet. New trigger type needed.

## Files

| File | Purpose |
|------|---------|
| `tools/mesh-claude.py` | PTY wrapper with mesh integration (spike) |
| `tools/conductor-bridge.py` | WebSocket sidecar (existing, proven) |
| `tools/mesh` | CLI tool for outbound (generated by mesh-claude at startup) |
| `docs/CONDUCTOR-PROTOCOL.md` | Wire protocol documentation |
| `.bon/understanding.md` | Architecture context |

## Quick Test Guide

### Test 1: PTY wrapper only (no mesh)
```bash
uv run --script tools/mesh-claude.py --no-mesh
# CC should start normally. You see the real TUI.
# Exit with /exit or Ctrl+D.
```

### Test 2: Mesh connection
```bash
uv run --script tools/mesh-claude.py
# Bridge sidecar starts automatically. Check:
cat /tmp/conductor-bridge/cc-aboyeur/status     # → "connected"
cat /tmp/conductor-bridge/cc-aboyeur/peers.json  # → connected agents
tail -f /tmp/conductor-bridge/cc-aboyeur/bridge.log  # → bridge activity
```

### Test 3: Simulated mesh message injection
```bash
# While mesh-claude is running in terminal 1, from terminal 2:
echo '{"ts": 1234, "from": "cc-test", "message": "Hello from the mesh! Can you see this?"}' \
  >> /tmp/conductor-bridge/cc-aboyeur/inbox.jsonl
# Within 0.5s, the message should appear in CC's input and be processed.
```

### Test 4: Outbound via mesh CLI (inside CC)
```bash
# CC runs this via the Bash tool:
mesh peers           # list connected agents
mesh send cc-office "Hello from aboyeur"
mesh inbox           # check received messages
```

### Test 5: Two-session mesh dialogue
```bash
# Terminal 1:
cd ~/Repos/aboyeur && uv run --script tools/mesh-claude.py
# Terminal 2:
cd ~/Repos/passe && uv run --script tools/mesh-claude.py
# In passe session, tell CC: mesh send cc-aboyeur "Can you hear me?"
# The aboyeur session should receive and process it.
```

## Headless Mode (Daemon Integration)

For daemon-spawned sessions, the PTY is replaced with `-p` mode stdin:

```
spawnAgent() today:     stdin.write(prompt) → stdin.end()     (fire-and-forget)
spawnAgent() with mesh: stdin.write(prompt) → stdin stays open (inject-capable)
```

The key change in `src/spawn-agent.ts`: don't call `stdin.end()` when the session needs mesh injection. Add a `keepStdinOpen?: boolean` option. The daemon keeps the process handle and writes mesh messages as stream-json envelopes:

```typescript
const envelope = JSON.stringify({
  type: "user",
  message: { role: "user", content: `[mesh from ${senderId}] ${text}` },
});
proc.stdin!.write(envelope + "\n");
```

The bridge sidecar runs alongside, same inbox.jsonl polling, same outbox.jsonl writing. Only the injection mechanism differs (stdin pipe vs PTY master fd).

## Next Actions

1. **Test mesh round-trip** — run the test guide above, verify injection and reply. This completes the aby-foloko proof.
2. **Mesh awareness in CLAUDE.md** — add `shared/prompts/mesh-awareness.md` content to global or project CLAUDE.md so CC knows about `mesh` commands. (Draft already written.)
3. **Headless mode** — `keepStdinOpen` option in `spawnAgent()`, bridge sidecar in daemon spawn flow.
4. **Bon watcher** — new trigger source for the daemon.
5. **Gueridon mesh** — add WebSocket to Gueridon bridge, register each session on spawn.
