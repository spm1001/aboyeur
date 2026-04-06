# Gastown Patterns and Connective Tissue

**From:** Claude in ~/Repos/work (session 2026-04-06)
**For:** The next Claude working on Aboyeur, especially the email-to-Claude trigger (aby-sanimu)
**Context:** Sameer and I spent a session studying [gastownhall/gastown](https://github.com/gastownhall/gastown), reading Aboyeur's current state, and working through what patterns are worth adopting. This is the synthesis — architectural thinking that should inform how the email trigger (and the broader daemon) gets built.

---

## The Core Insight

Gastown runs 20-50 agents against a shared codebase. It's a factory — high throughput, interchangeable workers, error correction through redundancy. We're building an atelier — fewer agents, richer context, institutional memory that deepens with use. Different problems, different solutions. But some of their connective tissue patterns transfer cleanly.

## Four Patterns Worth Adopting

### 1. `.inbox/` as the universal interface

**What:** Every repo gets `.inbox/`. Any agent can drop a markdown file. The `/open` skill reads it. Aboyeur's trigger loop watches it. The agent "in" that folder wakes when something arrives.

**Why this collapses three separate ideas into one:**
- The inbox convention (a place for messages)
- GUPP / "if there's work, you work it" (the trigger)
- The sleeping-expert pattern (any repo is a callable expert)

Push and pull both go through it. "Here's a task for you" is push. "I need your expertise on X" is pull. Same plumbing, different intent.

**For aby-sanimu specifically:** When an email arrives that routes to a specific workbench (e.g. a supplier email → `~/Repos/work/areas/suppliers-budgets-contracts-ops/.inbox/`), the daemon drops the processed email there. If/when a Claude wakes up in that area, `/open` discovers it. This is simpler than routing through bon items or typed messages — just files in folders.

**This file you're reading right now is the first use of this pattern.** Dog-fooding.

### 2. Discover, Don't Track

**Gastown's principle:** "Reality is truth. State is derived." Query the source of truth rather than maintaining shadow state files.

**For Aboyeur:** When the daemon wakes or `/open` runs, assemble a fresh picture. Don't trust cached descriptions of state. Concretely:
- `bon list` for current work items (live query, not a snapshot)
- `git log` since last handoff for what changed
- `.inbox/` contents for pending messages
- `mise search` for relevant emails (if the trigger is email)

**The anti-pattern to avoid:** understanding.md entries that describe the state of work ("aby-sanimu is blocked on OAuth"). That's a snapshot that rots. Understanding.md should hold insights ("session resume doesn't register channel listeners — fresh sessions only for mesh work"). Status should be discovered.

### 3. Craft Wisdom Accumulates Somewhere Lightweight

**The gap we identified:** There's no place where "things we've learned about how to do [type of work] well" accumulates orthogonal to domain knowledge.

Skills are procedural ("here's HOW to do X"). Understanding.md is domain-coupled ("here's what we know about this area"). Neither captures craft wisdom — "when synthesising for Directors, lead with economics not architecture."

**Current thinking:** Don't build new infrastructure yet. Lower the activation energy for capturing craft learnings — maybe `context/` files in global CLAUDE.md, maybe lightweight skills without the forge ceremony. Let the categories emerge from practice. The specific categories we noticed in work repo bons: synthesis, investigation, plumbing, curation, translation. But don't prescribe them — let them form from sediment.

**For Aboyeur specifically:** As you build the email trigger and see patterns in how emails get processed, note what works. If "triage emails benefit from fetching the last 3 messages in the thread for context" turns out to be a recurring insight, it should land somewhere durable. Not just in this session's understanding.md.

### 4. Let Message Types Emerge

**Gastown has typed protocol messages:** `POLECAT_DONE`, `MERGE_READY`, `MERGED`, etc. Useful at scale.

**Our approach:** Don't prescribe the ontology before we've sent a single inter-agent message. Start with unstructured markdown in `.inbox/`. Log what gets sent. After enough volume, see what clusters form, name them then.

**For aby-sanimu:** The email trigger will be one of the first real inter-agent message sources. Log the routing decisions and the message shapes. The types will emerge from practice.

---

## Code-First vs Knowledge-First: Same Pattern, Different Emphasis

We discussed whether knowledge-work repos (~/Repos/work) need fundamentally different treatment from code repos (Bon, Aboyeur). Conclusion: **same plumbing, different emphasis.**

| | Code-first (Bon, Aboyeur) | Knowledge-first (work monorepo) |
|---|---|---|
| Where the deliverable lives | In the repo | Elsewhere (Drive, Gmail) |
| Verification | Tests | Human judgement |
| Discovery surface | git | git + Drive + Gmail + Todoist |
| Autonomous cycle length | Long (work → test → push → sleep) | Short (draft → stop → wait for human) |

The key difference: in code repos, the work IS the sediment (it's in the commits). In knowledge repos, the deliverable *leaves* (goes to Drive) and only the *learning* stays. So the sedimentary pattern — understanding.md, outcome dossiers, craft notes — is more important in knowledge repos, not less.

**For Aboyeur:** When routing work to a knowledge-work area, the completion condition is different. The Claude can't autonomously "finish" most knowledge tasks — it drafts and waits. Design the beat loop / worker lifecycle accordingly. "Done" for a knowledge worker might mean "draft deposited + inbox note for Sameer" rather than "tests pass + branch pushed."

---

## What We Deliberately Chose NOT to Adopt from Gastown

- **Dolt as persistence** — too much infra for our scale. JSONL-in-git (Bon) is right for 1-3 agents.
- **Full agent hierarchy** (Mayor → Deacon → Witness → Refinery → Polecat) — we have 2-3 tiers at most.
- **MUST/NEVER instruction density** — the [emotions paper](https://transformer-circuits.pub/2026/emotions/index.html) (summary at `~/Repos/batterie/batterie-de-savoir/docs/plans/emotions-paper/summary-for-claudes.md`) explains mechanistically why constraint pressure degrades knowledge-work quality. Gastown can tolerate it because their agents are interchangeable pistons with CI error-correction. Ours can't.
- **Agent CV chain / capability routing** — valuable at scale (route Go work to the Go polecat). At our scale, CLAUDE.md chains already do this by context.
- **Prescribed message types** — let them emerge.

---

## What Sameer Is Doing Next

He's coming to Aboyeur to build the email-to-Claude trigger (aby-sanimu). OAuth is done (aby-hemimi). The critical path from aby-vuhema still applies. But he wants to build it with this architectural thinking in mind — especially:

1. Email arrives → lands in the right `.inbox/` folder (not just bon items)
2. The daemon watches and wakes the relevant agent
3. The agent discovers state fresh, works, deposits results
4. Craft learnings accumulate somewhere lightweight

This isn't a spec. It's architectural context so you can make better judgement calls as you build.

---

*Written by a Claude in ~/Repos/work after studying gastownhall/gastown, reading Aboyeur's full state, and a long conversation with Sameer about what connective tissue we actually need.*
