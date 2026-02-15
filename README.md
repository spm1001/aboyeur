# Aboyeur

*The one who calls.*

In a professional kitchen, the aboyeur stands at the pass. They don't cook — they call the tickets, check every plate before it goes out, coordinate timing between stations. When something's wrong, they send it back. When everything's right, they call "service."

## Status

**Robustness:** Alpha — experimental, actively developed
**Works with:** Claude Code
**Install:** `git clone` + run `conductor.sh`
**Requires:** Claude Code CLI, Bon

Aboyeur does the same for Claude sessions. It alternates **worker** sessions (do the work) with **reflector** sessions (review the work), using handoff files as the protocol between them. Each Claude gets a clean context, fresh eyes, and clear direction.

## The pattern

```
Worker → writes handoff → Reflector → reviews, fixes, writes handoff → Worker → ...
```

The **worker** reads the previous handoff, picks up work from Bon, builds, commits, and writes a handoff when context fills up or work completes.

The **reflector** reads the worker's handoff with fresh eyes. It asks: what was missed? What could be better? What could go wrong? It does modest remedial work (bug fixes, plan adjustments, bon updates) and writes a handoff that becomes the next worker's brief.

The **conductor** (`conductor.sh`) alternates between them. It pages the human when:
- A handoff contains "HUMAN REVIEW NEEDED"
- Bon state hasn't changed for too long (configurable, default 60 minutes)

That's it. The intelligence lives in the prompts and the handoff files, not in the conductor.

## Architecture

```
conductor.sh          ← the loop (alternate worker/reflector, page if stuck)
adapters/
  pi.sh               ← start a Pi session with the right prompt
  claude-code.sh      ← stub (CC uses /open and /close skills instead)
  pager/
    notify.sh         ← macOS notification (pluggable)
shared/
  prompts/
    worker-open.md    ← instructions for worker sessions
    reflector-open.md ← instructions for reflector sessions
```

### What the conductor does

1. Start a worker session (via adapter)
2. Wait for it to exit
3. Check handoff for escalation ("HUMAN REVIEW NEEDED")
4. Check bon state for progress (hash comparison)
5. Start a reflector session
6. Wait for it to exit
7. Repeat from 1

### What the conductor doesn't do

- Parse LLM output
- Make complex decisions
- Manage state beyond "is bon progressing?" and "did the handoff escalate?"

## Usage

```bash
# Start alternating sessions in a project
./conductor.sh ~/Repos/my-project

# Use a specific adapter
./conductor.sh --adapter pi ~/Repos/my-project

# Page after 30 minutes of no progress
./conductor.sh --max-idle 30 ~/Repos/my-project

# Custom pager
./conductor.sh --pager ./my-pager.sh ~/Repos/my-project
```

## Prerequisites

- [Pi](https://github.com/badlogic/pi-mono) or Claude Code
- [Bon](https://github.com/spm1001/bon) CLI in PATH
- `.bon/` initialised in the project
- Handoff infrastructure from [Trousse](https://github.com/spm1001/trousse)

## Design principles

**Handoffs are the protocol.** No custom formats, no databases, no IPC. Workers and reflectors communicate through the same handoff files that `/open` and `/close` already use.

**The conductor is dumb.** It alternates roles and pages when stuck. All the intelligence is in the two prompt files and in the Claudes that read them.

**Harness-agnostic.** The prompts work with any agent that can read files and run commands. Adapters handle the mechanical differences (how to start a session, how to pass the initial message). Today: Pi. Tomorrow: Claude Code, or whatever comes next.

**Silent when no Bon.** If the project has no `.bon/` directory, the stuck-detection is disabled. The prompts still work — they just skip the bon-specific steps.

## Relationship to other tools

| Tool | Role |
|------|------|
| **Bon** | Work tracker — outcomes, actions, tactical steps |
| **Trousse** | Session lifecycle — /open, /close, handoff format, hooks |
| **Pi / Claude Code** | Agent harness — the Claude that does the work |
| **Aboyeur** | Orchestrator — alternates sessions, pages when stuck |

Aboyeur consumes all of these but owns none of them. See [Batterie de Savoir](https://spm1001.github.io/batterie-de-savoir/) for the full brigade and design principles.
