# Conductor responsibilities → native primitives (aby-dujato, 2026-08-24)

The map the brief asked for, written before the prototype. Each row is one thing conductor.sh (plus its role prompts) actually does, the native primitive that carries it now, and what the primitive cannot carry. Primitive availability verified against current docs via a claude-code-guide agent on 2026-08-24 (CC ~2.1.241; doc URLs at the foot) plus this estate's own measurements (CronCreate session-only, measured under aby-gonida and corroborated by GitHub #50911).

One observation reframes the whole port: **conductor.sh never had a timer.** Its `while true` flips role on session exit — alternation is sequential control flow, not scheduling. So the "scheduler" aboyeur hand-rolled decomposes into control flow (native: Agent tool / Workflow), cadence (native: CronCreate ticks via loop.md), and state-across-ticks (NOT native — residue).

| # | Conductor responsibility (mechanism) | Native primitive | Surface constraints | Residue — what the primitive cannot carry |
|---|---|---|---|---|
| C1 | Alternation: worker ↔ reflector, `while true` + role flip on exit | Sequential `Agent()` calls in the orchestrating session's control flow; code-defined form is a Workflow (`agent()` / `pipeline()` stages) | Agent tool: everywhere incl. subagents. Workflow: TUI + SDK | None. This is the cleanest kill: a bash process supervisor replaced by two tool calls. |
| C2 | Session lifecycle: spawn role session, wait for exit (adapters/pi.sh; claude-code.sh was never implemented) | `Agent(subagent_type: general-purpose)` — spawn, run to completion, return report | Subagent cwd is not the target repo's; role prompts must use absolute paths | Adapter layer dies. Note: a subagent does NOT auto-load the target repo's CLAUDE.md/room tissue — the role prompt must point at it explicitly. |
| C3 | Role identities (shared/prompts/worker-open.md, reflector-open.md) | Survive as prompts, near-verbatim, embedded in the Agent() call | — | KEEP (updated for the pointing-at-tissue note above). The intelligence was never in conductor.sh. |
| C4 | Inter-session protocol: handoff files on disk, newest = brief | KEEP unchanged — transport-independent, survived the audit as aboyeur's best idea | — | Nothing native replaces it and nothing needs to: files + git already give atomicity, audit, rollback. |
| C5 | Stuck detection: bon-state hash unchanged ≥ N minutes | Tick-time one-command check (`bon list --all --json \| sha256sum`) compared against the previous tick's value; continuous form: Monitor tool watching the same command | Monitor: interactive-first; unclear in headless/subagents | **Residue: state across ticks.** Nothing native remembers "the hash N minutes ago" between sessions — the loop session must persist it (a file beside the log). This is aboyeur-v2-CLI territory: alternation state, stuck detection, paging rules. |
| C6 | Escalation detection: newest handoff contains `HUMAN REVIEW NEEDED` | One grep at tick time; convention KEPT in the role prompts — but anchored: `grep -q '^HUMAN REVIEW NEEDED:'` (case-sensitive, line-start, colon) | — | **The naive form is mention-fragile — measured on the prototype's first cycle**: a reflector wrote "No human review needed" and conductor.sh's own `grep -qi` fires on that negation. Reserve the anchored token; role prompts say the phrase is never written except to escalate. |
| C7 | Paging the human (adapters/pager/notify.sh) | `PushNotification` (desktop + phone push via Remote Control) when interactive on Anthropic billing; the estate's OnFailure mail rail otherwise | NOT headless, NOT SDK, NOT Vertex/Bedrock/Foundry; needs Remote Control for phone | **Residue: paging from agent/headless surfaces.** A dispatched worker cannot push a phone notification; it files a bon / writes the report line and the human-facing surface (despatch loop, mail rail) escalates. |
| C8 | Human gate: block the loop until ack (`read -r`) | Dies. Parking replaces blocking: the loop session parks the item (`bon wait` / With Sameer lane) and moves on | — | Deliberate improvement, not a loss — a blocked terminal waiting on Enter was the old design's worst human-interface idea; GTD parking is the estate norm. |
| C9 | Audit log (.aboyeur/conductor.log) | Session JSONLs + handoff files + bon history ARE the log. Scheduled fires are auditable in JSONL via `promptSource:"system"` + `isMeta:true` (measured, aby-gonida) | — | conductor.log dies. No residue. |
| C10 | Cold-eyes guarantee: reflector is structurally a NEW session | `Agent()` fresh context by construction — never `fork`, which inherits parent context and voids the property | — | None, and the estate already ratified this (loop.md step 4: fresh-context refuter before durable verdicts). |
| — | (Implicit) cadence between human visits | CronCreate ticks driving loop.md — session-mortal (docs + #50911: `durable:true` not honoured; 7-day auto-expiry), so ticks only, never continuity | Fires land only while an interactive session idles at the REPL | **Residue: continuity.** Scheduling gives ticks; an outer loop (or re-arming) must give lifetime. Constraint already appended to aby-degeki's brief. |

## The /goal evaluator question (brief's open question)

Docs answer: the `/goal` evaluator is a small fast model (Haiku by default) that judges the completion condition after every turn and returns Not-yet-met / Met / Impossible with a reason — **it has no tools, cannot run commands, cannot open files, cannot write** (code.claude.com/docs/en/goal). `/goal` is also interactive-TUI-only (no `-p`, no SDK, no subagents), which alone disqualifies it as the alternation backbone for dispatched/loop work.

**Measured live (test-not-assume), 2026-08-24, CC 2.1.241, hublot-driven interactive session in ~/repos, target files /tmp/goal-test/ (session 1cd40998, cwd -home-modha-repos):**

- *Phase 1 (happy path):* `/goal python3 /tmp/goal-test/test_greeting.py exits 0 and prints ALL GREEN` against a planted one-character bug. Setting the goal alone started the doer — no separate task prompt. Doer ran the test, read the file, made the Edit, re-ran; evaluator `met:true` after one turn ("Goal achieved · 1 turn · 863 tokens").
- *Phase 2 (the discriminating case):* new goal against a missing function, with the doer instructed "do not edit any file in this turn". The doer complied — ran the test once, reported verbatim, stopped. The harness rendered "◯ Goal not yet met… continuing" and RE-ENGAGED the doer, which then read the test, wrote the fix, re-ran; `met:true` on turn two. **Every file modification in the transcript is a doer tool call; the evaluator's only observable acts are verdicts and re-engagement.**

So the evaluator carries the VERDICT role plus a persistence/steering channel (its not-met reason re-prompts the doer) — and never the remedial role. The verdict + re-engagement loop is genuinely useful for *supervised* sessions (it defeated a stop instruction's premature halt); remediation is always session-shaped work.

**Legend — measured vs docs-only.** /goal rows above: measured live. CronCreate rows: measured (aby-gonida) + docs (#50911). Workflow rows: **docs-only — the Workflow tool has not been executed on this estate**; its stage/judge properties are borrowed from code.claude.com/docs/en/workflows via a claude-code-guide agent. The prototype's alternation ran on Agent-tool control flow (one measured native form); the Workflow form is the untested half, filed as its own follow-on on this board.

Where the reflector's two halves actually land:

- **Verdict half** → `/goal` evaluator (interactive supervision), Workflow judge stages (scoring subagents), or a fresh-context refuting Agent (the estate's current practice).
- **Remedial half** → a full role session with tools: a Workflow *stage* (stages get full tool access) or an `Agent()` reflector with the reflector-open.md prompt. Nothing evaluator-shaped writes fixes; something session-shaped must.

## What replaces conductor.sh, in one sentence

The orchestrating session's own control flow (loop.md's rhythm) makes two `Agent()` calls with the surviving role prompts, checks two one-liners between them (bon-hash drift, HUMAN REVIEW NEEDED), and the only genuinely new thing aboyeur v2 must build is the small CLI that remembers state between ticks — alternation position, last bon hash, paging thresholds — exactly Sameer's "l'il CLI that loop.md consults" inversion.

## Sources

- code.claude.com/docs/en/goal (evaluator: verdicts only, no tools; TUI-only)
- code.claude.com/docs/en/workflows (agent()/pipeline(); stages fresh-context with full tools; judges score)
- code.claude.com/docs/en/scheduled-tasks + GitHub #50911 (session-only; 7-day expiry)
- code.claude.com/docs/en/remote-control (PushNotification surfaces; not on Vertex)
- code.claude.com/docs/en/sub-agents (fresh context; fork inherits; parent orchestrates sequencing)
- conductor.sh, shared/prompts/worker-open.md, shared/prompts/reflector-open.md (this repo) — the responsibilities themselves
- aby-gonida done note + `.heartbeat/log.md` (CronCreate measurements on this estate)
