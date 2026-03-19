# Review: rjcorwin/cook

Source: https://github.com/rjcorwin/cook (`@let-it-cook/cli` v5.0.0)

Cook is a CLI that wraps coding agents (Claude Code, Codex, OpenCode) in composable workflow primitives: review loops, repeat passes, parallel races, and task-list progression. ~1400 lines of TypeScript, ink/React TUI, optional Docker sandboxing.

## Architecture at a glance

```
CLI args → parser.ts (recursive-descent → AST) → executor.ts (walks AST)
                                                    ├── loop.ts (work→review→gate loop)
                                                    ├── race.ts (worktree + judge utilities)
                                                    ├── runner.ts (AgentRunner interface)
                                                    │   ├── native-runner.ts (spawn CLI)
                                                    │   └── sandbox.ts (Docker container)
                                                    └── ui/ (ink TUI: App, RaceApp, LogStream)
```

Five AST node types: `work`, `repeat`, `review`, `ralph`, `composition`. Left-to-right composition — each operator wraps everything to its left.

## What maps to aboyeur

| Cook concept | Aboyeur equivalent | Gap? |
|---|---|---|
| `work` node | Worker spawn | No |
| `review` (work→review→gate loop) | PM beat cycle (work→reflector→route) | No |
| `ralph` (outer task gate: DONE/NEXT) | PM reading bon state, picking next action | No |
| `repeat` (xN sequential passes) | Sequential worker spawns | No |
| `composition` (vN/vs + resolver) | **Nothing yet** | **Yes** |
| `NativeRunner` (spawn CLI, pipe stdin) | `spawnAgent()` | No |
| `Sandbox` (Docker + iptables) | Nothing yet | Yes |
| `COOK.md` template | Static prompts in `shared/prompts/` | Partial |
| `no-code/SKILL.md` (LLM-as-orchestrator) | PM Claude behavior | Conceptual match |

## Steals, ranked

### 1. Race-and-resolve as a bon action type

**Highest value.** Cook's `composition` node spawns N parallel git worktrees, runs full pipelines in each, then resolves via:
- `pick`: judge agent reads all diffs, outputs `PICK <N>`
- `merge`: synthesis agent in fresh worktree with `MERGE_CONTEXT.md`
- `compare`: write comparison doc, preserve all branches

Implementation: `executor.ts:380-550`, `race.ts`. Clean worktree management with cleanup registry, SIGINT handlers, graceful merge-failure fallback.

Aboyeur has the plumbing (PM→Gueridon→workers, context queue parallel lanes) but no first-class "race N workers and pick" action type. Add it. The reflector already returns structured verdicts — extend it to compare multiple worker outputs and select a winner.

### 2. The operator grammar

Cook's DSL: `cook "work" x3 review v3 pick "criteria"`. Five node types, left-to-right wrapping, two levels of composition nesting. The parser (`parser.ts`, ~520 lines) is a clean hand-written recursive descent.

If aboyeur ever needs a lightweight CLI mode ("skip the daemon, just run a beat from the terminal"), this grammar is the reference. The AST types map directly to aboyeur concepts.

### 3. Docker sandbox for workers

`sandbox.ts`: Docker container with `sleep infinity`, bind-mount project root, copy auth files, apply iptables network restrictions (only allow agent API hosts). The `generateIptablesScript` function resolves hostnames and creates per-agent allowlists.

For aboyeur: when a bon action is flagged as high-risk (external code execution, untrusted input), spawn the worker in a network-restricted Docker container instead of bare Claude Code. The auth-file-copying pattern solves credential portability.

### 4. User-editable orchestration templates

`COOK.md` is a JS template literal with runtime variables (`${step}`, `${prompt}`, `${lastMessage}`, `${iteration}`). Users customize per-project orchestration behavior without touching code.

For aboyeur: a per-project template that injects bon state, last worker output, and iteration count into PM/worker prompts. More flexible than static `shared/prompts/` files.

### 5. Dual-mode execution

`no-code/SKILL.md` re-implements the entire cook grammar as LLM instructions — no CLI needed. The agent itself parses the grammar, creates worktrees, spawns subagents. Same DSL, two executors.

For aboyeur: the beat pattern could work in "daemon-managed" mode (daemon→PM→workers) and "single-session" mode (one Claude runs the whole beat via tool calls). The SKILL.md is the template for describing orchestration to an LLM.

## What NOT to steal

1. **Module-level mutable singleton** (`loopEvents` in `loop.ts:51`). Prevents running two pipelines in one process. Aboyeur's per-session event streams via Gueridon are better.

2. **`new Function()` template evaluation** (`template.ts:51`). User-controlled COOK.md content gets `eval`'d. Fragile escaping, injection risk. Use explicit variable substitution instead.

3. **No persistence or crash recovery.** Pipelines are fire-and-forget. Aboyeur's bon + SQLite queue is strictly better.

4. **Fuzzy gate parsing.** `parseGateVerdict` checks if any line *contains* "DONE"/"PASS"/"APPROVE"/"COMPLETE". A review saying "This is not COMPLETE" matches. Their own TODO acknowledges this. Aboyeur's structured JSON reflector verdicts are better.

5. **No token refresh.** Long-running ralph loops can outlive OAuth tokens. Aboyeur has Jeton.

## Interesting details

- **Runner pool** (`runner.ts`): lazy factory keyed by `SandboxMode`, so Docker containers are only started when a step actually needs them.
- **LineBuffer** (`line-buffer.ts`): 19-line class that handles partial-line buffering from child process stdout. Simple and correct — worth cribbing if aboyeur's `spawnAgent` doesn't already handle this.
- **RaceApp TUI** (`ui/RaceApp.tsx`): N parallel progress bars, each wired to its own EventEmitter. Good UX for parallel worker monitoring. Uses ink's `<Static>` for scrollback.
- **Configurable animations**: flame, strip, campfire, pot, pulse. Silly but charming. The campfire ASCII art is:
  ```
     (    )
      )  (
   ─=≡════≡=─
  ```
- **Plans directory** contains 10+ structured plan documents with decision logs, devlogs, and plan reviews. They used cook itself (review loops + planning reflectors) to build cook. Dogfooding.

## Bottom line

Cook is a well-executed composable CLI for the "inner loop" that aboyeur's PM already does. The naming (`xN`, `review`, `ralph`, `vN`, `vs`, `pick`, `merge`, `compare`) is a clean vocabulary for patterns aboyeur implements but doesn't name.

The single biggest concrete steal: **race-and-resolve as a first-class bon action type.** The plumbing exists in aboyeur. The abstraction doesn't. Cook shows exactly how to build it.
