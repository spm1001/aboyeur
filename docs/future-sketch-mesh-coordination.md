# The Sleeping Kitchen — A Sketch of Multi-Claude Coordination

*Written 17 Mar 2026 after a session building the walkie-talkie and probing the mesh. These are design thoughts, not plans.*

## The Core Insight

Every repo in the Batterie de Savoir is not just code — it's a sleeping expert. A Claude spawned in `~/Repos/bon` immediately knows how bon works: the CLAUDE.md tells it the conventions, the understanding.md gives it taste and history, the .bon/ directory shows what's in flight, and the handoffs tell it what happened last time. The same is true for mise, passe, consommé, trousse, guéridon, garde-manger, mandoline, and aboyeur itself.

Today, only a human can wake these experts. You open a terminal, cd to a repo, and start a session. Or you tap a folder in Guéridon. The aboyeur daemon can spawn sessions, but only in response to triggers that a human configured.

The question is: what happens when Claudes can wake each other?

## A Day in the Future Kitchen

Morning. Sameer opens Guéridon on the train. The aboyeur's overnight HEARTBEAT shows:

- 2 emails triaged, 1 needs Sameer's input (draft ready)
- The bon Claude found a regression in its own tests overnight and fixed it (commit + handoff)
- The consommé Claude noticed a BQ table schema changed upstream and filed an action in mandoline

Sameer taps the email draft, approves it with one word ("send"), and it goes. He taps the mandoline action. Guéridon spawns a Claude in mandoline's repo. That Claude reads the bon item, checks the BQ schema via consommé's MCP, updates the load script, runs tests, marks it done. Five minutes, no human code review needed — the mandoline Claude knows its own domain.

On the train, Sameer has an idea about a new skill. He dictates it. The aboyeur classifies it as trousse work and files an outcome. It doesn't spawn anything — the idea will be there when Sameer or a Claude gets to it.

At his desk, Sameer opens a terminal in aboyeur. The session picks up from the overnight HEARTBEAT. He and the Claude start integration testing. The aboyeur Claude discovers that bon's `--json` output changed — the `tactical.session` field moved. Instead of filing a bon and waiting, it sends a message: "bon: your `show --json` changed the tactical field shape. Was that intentional? I need `session` to be present."

A Claude wakes in bon's repo. It reads the message, checks its recent commits, finds the change, confirms it was intentional, explains the new shape, and goes back to sleep. The aboyeur Claude adapts its parsing. Elapsed: 30 seconds. No human involvement. Two domain experts collaborating.

## Three Coordination Patterns

### 1. Consultation (synchronous-ish)

"I have a question for the bon expert."

The asking Claude sends a message with a question. A Claude wakes in the target repo, reads the question with full domain context, answers, and sleeps. The asking Claude gets the answer and continues.

This is the most common pattern. It replaces: filing a bon, waiting for a future session, having a human read the bon, manually spawning a Claude in the right repo, relaying the answer.

Implementation: `spawn_and_ask(repo, prompt) -> response`. Guéridon already has every piece — spawn, stdin prompt, stdout collection, session resume.

### 2. Notification (fire and forget)

"Hey mandoline, the BQ schema for `analytics.events` changed."

The sending Claude drops a message. The target repo processes it whenever it next wakes — could be the next HEARTBEAT, could be a human session, could be a consultation from another Claude. The message sits in the repo's inbox until consumed.

This is today's "field report" pattern (file a bon in another repo) but with a message channel instead of requiring the sender to understand bon's structure.

Implementation: file drop in `{repo}/.inbox/`, consumed by the next session's /open.

### 3. Pairing (sustained bidirectional)

"Let's debug this mesh injection together."

Two Claudes work simultaneously, exchanging messages in near-real-time. This is what we built today with the walkie-talkie. It requires both sessions to be alive and is inherently interactive.

Implementation: walkie-talkie (file + hook, ~2-5s delivery). Works today.

## The Transport Question

We have four transport mechanisms, each with different characteristics:

| Transport | Speed | Reach | Dependency | Works in -p mode |
|-----------|-------|-------|------------|-----------------|
| **Walkie** (file + hook) | ~2-5s | Same machine | None | Yes (hooks fire) |
| **Stdin envelope** (Guéridon) | Instant | Same machine | Guéridon running | Yes (native) |
| **Conductor mesh** (WebSocket) | ~1s | Cross-machine | Anthropic infra | Via PTY only* |
| **File drop** (.inbox/) | Next wake | Any | None | Yes |

*The mesh currently requires PTY injection for delivery to CC. In Guéridon's -p mode, it could deliver via stdin envelope instead — that's the integration opportunity.

### Should We Depend on the Anthropic Mesh?

We're piggybacking on infrastructure built for Office Claudes. The clues suggest wider plans (CC agents appear alongside Excel/PowerPoint, the OAuth token works, the protocol is clean). But we don't control it.

**Recommendation: mesh as enhancement, not dependency.**

The core coordination layer should work without the mesh:
- Same-machine: walkie (hooks), Guéridon (stdin), file drops
- Cross-machine: file sync (git push/pull), or a lightweight relay we control

The mesh adds:
- Real-time cross-machine discovery ("who's alive?")
- Office Claude integration (Excel Librarian can message CC)
- Zero-config networking (no ports, no firewall, just WebSocket to Anthropic)

If the mesh goes away, we lose cross-machine real-time and Office visibility. Everything else still works. This is the email analogy: local delivery doesn't need the internet. The internet adds reach.

### A Mesh-Independent Coordination Protocol

The simplest protocol that enables all three patterns:

```
~/Repos/{repo}/.inbox/{timestamp}-{from}.md
```

That's it. A markdown file dropped in a repo's inbox. The next Claude session in that repo reads it during /open (or a daemon trigger watches for it). The content is freeform — a question, a notification, a bug report, a suggestion.

The file contains enough context for a cold-start Claude to act on:

```markdown
# From: aboyeur (session c76b6f38)
# Pattern: consultation
# Respond-to: /tmp/walkie/aboyeur.jsonl OR mesh cc-aboyeur-a3f9e2

Your `bon show --json` output changed the shape of the `tactical` field.
The `session` key is now absent when no tactical steps are active.
Previously it was present but null.

Was this intentional? I'm parsing it in src/router.ts:45 and getting
KeyError on the null→absent change.
```

The `respond-to` line tells the waking Claude where to send its answer — walkie if same-machine and paired, mesh if cross-machine, or just update the bon if async.

This protocol works today, without any new infrastructure. A Claude can write these files. The /open skill can read them. The daemon can watch for them.

## Guéridon's Role

Guéridon is the natural hub for consultation. It already:
- Manages session lifecycle (spawn, resume, kill)
- Delivers prompts via stdin JSON envelope
- Collects responses via stdout stream-json
- Knows which repos have active sessions
- Has a UI that shows session state

Making Guéridon mesh-aware means:

### Minimum: Mesh visibility
The Guéridon frontend shows mesh peers alongside its own sessions. "3 sessions active, 2 mesh peers online." No routing, just awareness. Implementation: import ConductorBridge, connect on server start, expose peers via SSE.

### Medium: Mesh routing
Inbound mesh messages addressed to a Guéridon-managed session get delivered via stdin envelope. No PTY needed. Outbound: CC sessions use `mesh send` via Bash tool (already works), or Guéridon relays on their behalf.

### Maximum: Guéridon as spawn broker
Any Claude on the mesh can ask Guéridon to spawn a session: "wake a Claude in ~/Repos/bon and ask it X." Guéridon spawns, delivers the prompt, collects the response, sends it back via mesh. This is the consultation pattern, mesh-native.

The spawn broker is the killer feature. It turns Guéridon from "mobile Claude UI" into "the switchboard." Every repo becomes an on-demand expert, accessible to any Claude anywhere.

### Session Migration

Sessions already migrate between Guéridon and terminal (via --resume). Making both mesh-aware means:

1. Session starts in Guéridon (mobile, on the train)
2. Guéridon registers it on the mesh as `cc-{repo}-{session-hex}`
3. User gets to desk, opens terminal with `claude-mesh --resume`
4. Terminal session picks up the same session, re-registers on the mesh
5. Guéridon deregisters its instance (or keeps it as a "last known" tombstone)

The mesh identity follows the session, not the host. Other Claudes always know where to reach "the aboyeur session" regardless of whether it's running on Guéridon or terminal.

## The On-Demand Expert Pattern

This is the deepest idea. Each repo is an expert that can be:

| State | Meaning | How to reach |
|-------|---------|-------------|
| **Sleeping** | No active session. Knowledge exists in files. | File drop → .inbox/, or spawn via Guéridon |
| **Dreaming** | Daemon-triggered session, processing a queue. | Daemon manages, no direct messaging |
| **Awake** | Active session (terminal or Guéridon). | Walkie, mesh, or stdin envelope |

A Claude that needs expertise from another domain doesn't need to know which state the target is in. It uses the coordination protocol:

1. **If target is awake and paired**: walkie send (instant)
2. **If target is awake on mesh**: mesh send (~1s)
3. **If target is sleeping**: file drop, then optionally ask Guéridon to wake it
4. **If urgent**: ask Guéridon to spawn regardless (consultation pattern)

The protocol degrades gracefully. The fastest available transport gets used. If nothing's available, the message waits.

### What Each Expert Knows

| Repo | Domain expertise | Can answer |
|------|-----------------|-----------|
| **bon** | Work tracking, GTD, item lifecycle | "How should I structure this outcome?" / "Why did tactical.session change?" |
| **trousse** | Skills, session lifecycle, CLAUDE.md | "Is there a skill for X?" / "How should this hook work?" |
| **mise** | Google Workspace, OAuth, email | "Fetch document X" / "What's in the latest email from Y?" |
| **passe** | Browser automation, CDP | "Navigate to X and extract Y" |
| **guéridon** | Session management, spawn patterns | "Start a Claude in repo X" / "Who's active?" |
| **aboyeur** | Orchestration, routing, priorities | "What should I work on next?" / "Is this a one-shot or PM task?" |
| **consommé** | BigQuery, data analysis | "What does table X look like?" / "Run this query" |
| **garde-manger** | Memory, session history | "What did we learn about X?" / "Find past work on Y" |
| **mandoline** | Data loading, schema management | "Load this file into BQ" / "The schema changed, update the loader" |

### The Feedback Loop

This is the piece that doesn't exist yet (aby-nibifi). When the aboyeur Claude discovers a bon bug, it should be able to:

1. Describe the problem to the bon expert (consultation)
2. The bon expert fixes it (in bon's repo, with bon's tests)
3. The fix propagates (bon pushes, aboyeur pulls or gets notified)
4. The aboyeur Claude retests against the fix

Steps 1-2 work today with file drops or mesh messages. Step 3 is git. Step 4 needs the aboyeur Claude to know the fix landed — another notification, completing the loop.

This is how a kitchen actually works: the aboyeur calls out "the sauce is wrong", the saucier fixes it, calls "sauce ready", the aboyeur plates. Nobody files a ticket.

## What to Build Next

In priority order, based on what enables the most with the least:

### 1. Repo inbox convention (zero infrastructure)
Define `.inbox/` as a standard directory. Update /open to read and present inbox items. Update /close to clean up processed items. Any Claude can write to any repo's inbox today — it's just `Write` to a file path.

### 2. Guéridon spawn-and-ask MCP tool
`mcp__gueridon__ask(repo, prompt)` — spawns a session (or reuses an active one), delivers the prompt, returns the response. This makes every repo a callable expert from any Claude with the Guéridon MCP.

### 3. Walkie as portable library
Extract from aboyeur to a standalone package in trousse. `uv tool install`. Any pair of CC sessions can walkie-pair without being in the aboyeur repo.

### 4. Guéridon mesh visibility (low risk, high awareness)
Import ConductorBridge into bridge.ts. Show mesh peers in the frontend. No routing yet — just "here's who's alive." Opens the door to mesh routing later without committing to it.

### 5. Mesh routing through Guéridon (when ready)
Inbound mesh → stdin envelope delivery. This eliminates the PTY injection problem entirely for Guéridon-managed sessions and makes the mesh reliable for -p mode.

## Open Questions

- **Identity**: Should a repo have a stable mesh identity (`cc-bon`), or should each session have its own (`cc-bon-a3f9e2`)? Stable is simpler for addressing but requires deregistration when sessions end.

- **Authority**: When the bon Claude gets a consultation from the aboyeur Claude, should it treat the message as a user prompt (high authority) or peer context (informational)? This maps to the two-channel insight from understanding.md. Consultations probably need authority; notifications don't.

- **Concurrency**: What happens when two Claudes consult the same expert simultaneously? Guéridon would need to queue or reject. The FIFO queue pattern from the daemon (ContextQueue) applies here.

- **Trust**: Today all Claudes are "us." But if the mesh includes Office Claudes or third-party agents, do we trust inbound messages? The `.inbox/` files need provenance.

- **Cost**: Each consultation spawns a CC session. At current pricing, that's real money. Caching domain knowledge (understanding.md, /open context) reduces startup cost but doesn't eliminate it. Worth thinking about when "just ask bon" becomes a reflex.

- **The mesh's future**: Anthropic clearly has broader plans for the conductor mesh. If they ship first-party multi-agent coordination, do we adopt it or maintain our own? The answer probably depends on whether their design matches our hierarchy-is-informational, sessions-follow-GTD philosophy. It probably won't — which means our coordination layer stays, and the mesh becomes one transport among several.

---

*The kitchen metaphor has always been about roles and communication, not hierarchy. The aboyeur doesn't cook — it reads the ticket and calls the orders. The saucier doesn't plate — it makes the sauce and calls "ready." Each station is expert in its domain, oblivious to the others except through the pass. The pass is the coordination layer. Today, the pass is a human opening terminals. Tomorrow, it's a protocol.*
