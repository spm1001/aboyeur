# Architecture Narrative: A Trigger Becomes Work

Walk-through of the Rube Goldberg scenario, end to end.

## The Setup

Sameer has been emailing back and forth about a project idea. Through conversation, a plan has emerged. A Claude helped encode it into Bons — an outcome with 9 actions. The bons live in `~/Repos/rube-goldberg/.bon/`. Sameer sends an email: "Hell yeah, let's build project Rube Goldberg."

## Layer 1: The Daemon (Lizard Brain)

The daemon is a Node.js process running as a systemd service on Tube. It has no intelligence. Every 2 seconds, its poll loop checks:

- **Gmail API** (via jeton OAuth tokens): any new mail for claude@planetmodha.com?
- **HEARTBEAT cron**: is it time for a periodic check?

The email lands. The Gmail poller calls the API, gets the thread ID, and inserts a trigger:

```
INSERT INTO triggers (source, context_group, payload)
VALUES ('gmail', 'email', '{"threadId":"abc123","subject":"Hell yeah..."}')
```

The dedup hash prevents processing the same email twice. The poll loop claims the trigger. The context queue checks: is there a slot? (Max 3 concurrent.) Yes. It dispatches.

The daemon's `resolveSpawn` callback sees `source: 'gmail'` and spawns the aboyeur via `spawnAgent()`. This is the ONLY direct spawn the daemon ever does.

## Layer 2: The Aboyeur (Receptionist)

The aboyeur is a persistent, minimal-context Claude session. It wakes up, reads the trigger payload, and makes a routing decision.

Its CLAUDE.md tells it: read `bon list --json --outcomes-only` to see your goals. Don't read actions — that's detail you don't need.

The aboyeur reads the email (via mise fetch), recognises this is a "go" signal for an existing project, and checks: do bons already exist in `~/Repos/rube-goldberg/`? Yes — an outcome with 9 actions.

**Decision: this is a project, not a one-shot.** The aboyeur spawns a PM Claude via the Gueridon bridge:

- Session name: `pm-aby-zehiwo-01`
- Working directory: `~/Repos/rube-goldberg/`
- System prompt: the PM CLAUDE.md
- Initial prompt: "Project Rube Goldberg is greenlit. Email trigger: [payload]. Manage execution."

The aboyeur logs: `"pm-aby-zehiwo: spawned, 0/9 actions done"` — that's all it holds. It goes back to waiting for the next trigger.

### What if it had been simple?

If the email were "interesting article, thoughts?", the aboyeur would spawn a one-shot instead:

- Session name: `oneshot-gmail-203015`
- Prompt: "Read this article and draft a reply with your thoughts."

The one-shot handles it, returns a summary. Aboyeur logs: `"email-203015: article shared, reply drafted"`. Done.

### What about promotion?

Sometimes a one-shot discovers complexity. The email says "can you look into X?" — the one-shot investigates, realises this is a 5-session project, and creates bons. When the one-shot finishes, the aboyeur checks: did new bons get created? If yes, it spawns a PM to take over. The one-shot's handoff becomes the PM's starting context.

## Layer 3: The PM Claude (Middle Manager)

The PM is scoped to one project. Its CLAUDE.md encodes Sameer's operational patterns:

- Read bon state via `bon list --json` — structured, not prose
- Pick next action by **context correlation**: which unblocked action shares the most context with what's already loaded?
- Manage the **beat pattern**: work → review → route
- Ask the **three questions** after each significant chunk
- Wind down at ~20-25% context remaining
- Report progress one-liners to the aboyeur

The PM reads the bons for Rube Goldberg. 9 actions, 0 done. It picks `aby-sanimu` (Gmail poll trigger) as the first action — foundational, unblocks others.

### The Beat: Work → Review → Route

**Spawn worker:**

The PM uses the Gueridon bridge API to spawn a worker:

- Session name: `worker-aby-sanimu-01`
- Working directory: `~/Repos/rube-goldberg/`
- System prompt: worker CLAUDE.md (no mention of PM or orchestration)
- Prompt: "Work on aby-sanimu. Run `bon show aby-sanimu` for the brief."

The worker sees a normal project. CLAUDE.md, bons, source code. It does the work, writes a handoff, finishes.

**The PM doesn't read the worker's full session.** An eyesight filter distils the Gueridon event stream into a summary deposit:

```json
{
  "session": "worker-aby-sanimu-01",
  "status": "completed",
  "duration_minutes": 12,
  "handoff": "~/.claude/handoffs/.../worker-aby-sanimu-01.md",
  "key_outputs": ["src/gmail-trigger.ts created", "3 tests passing"],
  "errors": 0
}
```

The PM reads this — a few lines, not a transcript.

**Spawn reflector:**

The PM spawns a reflector for fresh-eyes review:

- Session name: `reflector-aby-sanimu-01`
- Working directory: `~/Repos/rube-goldberg/`
- System prompt: reflector-open.md
- Prompt: "Review the work in the latest handoff for aby-sanimu."

The reflector reviews the code, checks the tests, writes a structured verdict:

```json
{
  "approved": true,
  "issues": ["Missing error handling for token refresh"],
  "confidence": "high",
  "recommendation": "approve with minor fix"
}
```

**Route:**

The PM reads the verdict. Approved with a minor issue. It could:
- Spawn `worker-aby-sanimu-02` with "fix token refresh error handling"
- Or `bon done aby-sanimu` and note the issue for later

It chooses to fix — spawns a quick worker, gets a clean verdict, marks done.

**Report to aboyeur:** `"aby-sanimu done (2 worker sessions, 1 reflector). 1/9 complete."`

### Next action by context correlation

The PM now picks the next action. The worker just loaded `src/gmail-trigger.ts` and the trigger infrastructure. Which unblocked action shares the most context?

- `aby-vemapa` (HEARTBEAT cron) — same trigger infrastructure, same files. High correlation.
- `aby-dagofi` (systemd wrapper) — different concern, different files. Low correlation.

It picks aby-vemapa. The beat repeats.

### PM lifecycle

The PM is disposable. If it exhausts its context window or drifts:
1. The HEARTBEAT trigger fires (daemon level)
2. The aboyeur checks: is the PM alive? Is it progressing?
3. If stuck or dead, the aboyeur spawns a fresh PM: `pm-aby-zehiwo-02`
4. The new PM reads bon state (3/9 done) and the latest handoff
5. It picks up where the old PM left off — no context loss because state is external

### Sessions 2 through 15

The beat repeats. Work → review → route. The PM manages 5-10 sessions before it needs replacing. Each replacement costs nothing — bon state is the source of truth.

After all 9 actions are done, the PM reports: `"aby-zehiwo: all 9 actions complete."` The aboyeur marks the outcome done.

## The Process vs Information Distinction

All of these Claude sessions — aboyeur, PM, workers, reflectors — are side-by-side pods under the Gueridon bridge. The bridge sees them as peers. It doesn't know about hierarchy.

The hierarchy exists purely in information flow:

```
Workers:     produce 50k tokens of code, tests, handoffs
Reflectors:  produce structured verdicts (5 lines of JSON)
PM:          reads summaries and verdicts (~100 lines per beat)
Aboyeur:     reads progress one-liners (~4 lines per trigger cycle)
```

Each level up sees less. The eyesight filter operates at every boundary. This is what makes the aboyeur sustainable as a persistent session — it never needs to understand project details, just status.

## The GTD Parallel

| What Sameer does | What Aboyeur does |
|---|---|
| Reads email, decides "this is a project" | Routes trigger to PM |
| Reads email, decides "quick reply" | Routes trigger to one-shot |
| Weekly review: are my projects progressing? | HEARTBEAT: are PMs alive? |
| Notices a next action became a project | Promotion: one-shot created bons → spawn PM |
| Asks "what did we miss?" after each chunk | Three questions at PM checkpoints |
| Senses drift, breaks out for reflect/cleanup | PM detects drift, spawns reflector or escalates |
