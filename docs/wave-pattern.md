# The wave pattern — codified from the 2026-08-17 pilot (bon-turibi)

A **wave** is a batch of parallel, unattended work: an orchestrating session takes N items, writes a dispatch brief per item to disk, launches an **executor** per item, then launches an independent **sceptic** per item to adversarially verify the executor's claim of done before anything is accepted. Two waves ran on 2026-08-17: eight items, eight verified dones, zero destructive surprises.

## The measured record

- **Executors do the work well and misreport it slightly.** Small, confident overstatements in summaries: 4 of 4 wave-1 items unaudited; an explicit precision-audit instruction in the brief cut that to 1 of 4 in wave 2.
- **Adversarial verification caught every drift**, at roughly a third of total spend. It is the honesty layer, never optional — without it the inflations enter the record verbatim.
- **Briefs on disk before launch** give verifiers an independent spec (checking an executor against its own narrative only proves self-agreement) and allow mid-run fact injection.
- **Boards move under fleets.** Freshness-gate every dispatch at the moment of use; a gate turned one mid-wave collision into a recorded divergence. The sharper lesson landed five days later: on 2026-08-22, just two well-behaved concurrent writers on one Dolt board silently lost seven rows (bon-resena carries the forensics). Parallel lanes are a measured write-concurrency risk, not just an attention cost.

## When to wave, when to loop

The estate's default for unattended work is now the **loop** (`~/.claude/loop.md` + the aboyeur v2 CLI design, aby-degeki): one session, serial trickle, one writer per board at a time, per-verdict cold-eyes check before every durable close. Serial topology dissolves most of the write-concurrency hazard family structurally.

The wave keeps a named niche: **parallel read work** — research sweeps, audits, verification fan-outs, anything where lanes read much and write boards not at all. Parallelism belongs where writes don't. A wave launched today should consult the same dispatcher as the loop (`aboyeur next`, once degeki ships) so a line can't be claimed twice — until then, freshness-gates and dispatch-brief claims are lane-side virtue, not structure (that gap is bon-hunote, parked on exactly this condition).

## The common discipline (wave-2 COMMON.md, verbatim — this text is the exemplar)

> - FRESHNESS FIRST: cd to the board repo and `bon show <ID> --json`. Diff what you read against this dispatch brief. If the board has moved — item closed, re-scoped, newly waiting, or a live tactical claim present — record the divergence in your evidence and adapt; never collide with another session's claim. Boards move under the fleet; this check is load-bearing, not hygiene.
> - BOARD WRITES: none. No bon work/step/done/edit anywhere. Mechanism: tactical claims are session-identity-keyed and the orchestrator owns all bookkeeping; a write from you desynchronises another session's accounting.
> - EVIDENCE AS YOU GO: keep your evidence file updated while working — commands, key outputs, paths, commits. A sceptical verifier follows who re-runs your checks against the world; write only what reproduces.
> - PRECISION IN SUMMARIES: every quantified claim carries its measured count and its scope ("14 of 16 cite transcripts; 2 are inferences"). Wave 1's only verifier catches were small overstatements in summaries. Don't be the fifth.
> - GIT: stage explicit paths only, never add -A; read each push's own output as its result; other lanes' uncommitted state is theirs — exclude it (surgical staging if needed). In ~/notes specifically: notes-sync owns all git WRITES — read-only git commands are fine, write the working tree only.
> - STOP-GATES: only those your item brief names. Everything else in scope you complete; if blocked, deliver the largest clean subset with the edge named — a bounded partial beats a forced complete.

Why the phrasings matter: constraints stated **by mechanism** ("notes-sync owns git *writes*"; "a write from you desynchronises another session's accounting") leave no letter/spirit edge for a reasoning agent to slip through, where bare prohibitions get benignly reasoned around. This was a designed property, and it held across all eight items.

## Pointers

- Serial counterpart and estate default: `~/.claude/loop.md` (its step 4 — cold-eyes verification before durable verdicts — is this pilot's 4-of-4 lesson applied).
- Machinery direction: aby-degeki on this board (aboyeur v2 as a pulled CLI, not a daemon; reflector ticks as fresh-context subagents).
- Worked per-item dispatch briefs: private notes room, `practices/model-minds/wave2-briefs-2026-08-17/` (they carry ITV-sensitive content and this repo is public — pointer only, by design).
- Narrative write-ups: the bon repo's `.bon/understanding.md` (orchestration-wave section) and the 2026-08-17 handoff there.
