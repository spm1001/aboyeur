# Aboyeur — Project Context

Multi-session orchestrator. Alternates worker and reflector Claude sessions via handoff files. The conductor is intentionally dumb — all intelligence lives in the prompt files and in the Claudes that read them.

## Architecture

```
conductor.sh (the loop)
  → adapters/pi.sh or adapters/claude-code.sh (start a session)
  → shared/prompts/worker-open.md (worker instructions)
  → shared/prompts/reflector-open.md (reflector instructions)
  → adapters/pager/notify.sh (macOS notification when stuck)
```

**The cycle:** Worker → handoff → Reflector → handoff → Worker → ...

The conductor checks two things between sessions:
1. Does the handoff contain "HUMAN REVIEW NEEDED"? → page the human
2. Has `bon list --all --json` hash changed? → if not for `MAX_IDLE_MINUTES`, page

## Key Files

| File | Purpose | Sensitivity |
|------|---------|-------------|
| `conductor.sh` | The alternation loop (~150 lines) | High — load-bearing |
| `shared/prompts/reflector-open.md` | Reflector instructions | High — sycophancy risk if weakened |
| `shared/prompts/worker-open.md` | Worker instructions | Medium |
| `adapters/pi.sh` | Start a Pi session | Low — mechanical |
| `adapters/claude-code.sh` | Start a CC session (stub) | Low |
| `adapters/pager/notify.sh` | macOS notification | Low |

## The Reflector Prompt

This is the hardest part. If the reflector is too polite, the whole system is an expensive rubber stamp. Rules:
- Keep the adversarial framing ("find what's wrong")
- No hedging language ("if you think there might be issues...")
- The reflector owes the previous Claude nothing
- The reflector does modest remedial work (bug fixes, plan adjustments, bon updates) — it doesn't restart from scratch

## Conventions

- Shell: `set -euo pipefail`, quote variables, use `local` in functions
- Prompts: direct, no fluff, concrete instructions over abstract principles
- The conductor should stay under 200 lines — complexity belongs in the prompts, not the loop

## Dependencies

- **Bon CLI** (`bon`) — work tracking, stuck detection via hash comparison
- **Trousse** — handoff infrastructure (`~/.claude/handoffs/`), session lifecycle
- **Pi or Claude Code** — the agent harness (via adapter)
- **macOS** — default pager uses `osascript` (pluggable via `--pager`)

## Testing

No automated tests. Test by running `conductor.sh` on a real project with `.bon/` initialised and observing the worker→reflector→worker cycle. The reflector's adversarial quality is the thing to watch — if it starts agreeing with everything, the prompt needs tightening.

## Status

Alpha. Works with Pi adapter. Claude Code adapter is a stub — CC sessions use `/open` and `/close` skills directly rather than receiving an injected prompt.
