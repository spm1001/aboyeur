# Aboyeur — Project Guidance

## What this is

Session orchestrator that alternates worker and reflector Claude sessions. See README.md for architecture.

## Code style

This is shell scripts and markdown prompts. Keep it simple.

- Shell: `set -euo pipefail`, quote variables, use `local` in functions
- Prompts: direct, no fluff, concrete instructions over abstract principles
- No over-engineering — the conductor should stay under 200 lines

## Key files

| File | Purpose | Change carefully? |
|------|---------|-------------------|
| `conductor.sh` | The loop | Yes — this is load-bearing |
| `shared/prompts/reflector-open.md` | Reflector instructions | Yes — sycophancy risk if weakened |
| `shared/prompts/worker-open.md` | Worker instructions | Less sensitive |
| `adapters/pi.sh` | How to start Pi | Mechanical, low risk |

## The reflector prompt is the hardest part

If the reflector is too polite, the whole system is an expensive rubber stamp. When editing `reflector-open.md`:
- Keep the adversarial framing ("find what's wrong")
- Don't add hedging language ("if you think there might be issues...")
- The reflector owes the previous Claude nothing

## Testing

No automated tests yet. Test by running `conductor.sh` on a real project with `.bon/` and observing the worker→reflector→worker cycle.

## Dependencies

- Bon CLI (`bon`)
- Pi or Claude Code (via adapter)
- Trousse handoff infrastructure (`~/.claude/handoffs/`)
- macOS (for default pager — `osascript`)
