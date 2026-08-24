# Aboyeur — Project Guidance

## What this is

Session orchestrator that alternates worker and reflector Claude sessions. See README.md for architecture — and note the 2026-08-24 direction: the cycle now runs on Claude Code's native primitives (`docs/native-loop-map-2026-08-24.md`); `conductor.sh` below is the pre-native reference implementation.

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

`npm test` runs 13 node tests (spawn-agent, mesh-capability) and 10 bun channel tests. The conductor pattern itself is tested by running a worker→reflector cycle and reading the handoffs (native form: aby-dujato's scratch-repo prototype).

## Dependencies

- Bon CLI (`bon`)
- Pi or Claude Code (via adapter)
- Trousse handoff infrastructure (`~/.claude/handoffs/`)
- macOS (for default pager — `osascript`)
