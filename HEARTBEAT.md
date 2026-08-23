# HEARTBEAT — estate health check (native loop prompt)

You are a Claude receiving a scheduled heartbeat fire. This file is the whole brief: work the
checks below, append one stanza to the log, and stop. Budget ~2 minutes. This is a background
health check — do NOT draw down board work, do NOT touch Todoist, do NOT send peer messages
from this checklist (and if a future edit adds one: identical-text messages are silently
deduplicated by the harness, so any message must carry the timestamp — see
`docs/native-xsm-review-2026-08-08.md` finding 7).

**Scheduling (the re-arming story).** This checklist rides a durable CronCreate task —
cron `9,39 * * * *`, prompt `Read /home/modha/repos/spm1001/aboyeur/HEARTBEAT.md and follow it.`,
`durable: true` — persisted in `~/.claude/scheduled_tasks.json`. Two known limits: durable
recurring tasks auto-expire after 7 days, and fires land only while an interactive session is
running and idle at the REPL. Check 5 below is what keeps it alive across the expiry.

## Checks

Run every check even if an earlier one fails. A check whose instrument is unavailable reports
`SKIP (reason)` — a skip is a truthful line, a hang is not. All paths absolute; assume nothing
about your cwd.

### 1. Board health (bons)
From `/home/modha/repos/spm1001/aboyeur`, run `bon list --json`.
- Stale: any open outcome with no action completed in 7+ days?
- Stuck: any action `waiting_for` something that looks long-resolved?
If the bon CLI errors (e.g. Dolt server down), that is itself a `WARN` with the error text.

### 2. Loop substrate (was: trigger queue)
Read `~/.claude/scheduled_tasks.json`.
- How many durable tasks exist? Any recurring task inside ~24h of its 7-day auto-expiry?
- Is the file missing or empty while loops are believed armed? That is a `WARN`.

### 3. Unprocessed email
Via mise (read-only search only): any unread email older than 2 hours in the ITV inbox?
If mise tools are absent in this session, `SKIP (no mise)`.

### 4. Session fleet (was: daemon health)
Read `~/.claude/sessions/*.json`. For each record, the pid is live (`kill -0`) or the record is
stale. Report: N live sessions (name, cwd basename, busy/idle), M stale records. Do not delete
stale records. A record with no `messagingSocketPath` and a live pid is a live-but-deaf
(Vertex) session, not a fault.

### 5. Re-arm self
Find this heartbeat's own task in `~/.claude/scheduled_tasks.json` (prompt mentions
HEARTBEAT.md). If absent, or expiring within 24h, re-create it with CronCreate using the
scheduling block above, and say so in the stanza. If you cannot (no CronCreate tool here),
report `FAIL (cannot re-arm)` — that line is the alarm.

## Report

Append one stanza to `/home/modha/repos/spm1001/aboyeur/.heartbeat/log.md` (create the
directory if needed; it is gitignored). One line per check, timestamp makes each stanza unique:

```
HEARTBEAT 2026-03-15T17:00:00Z (session <first8-of-session-id>)
  bons: OK (3 outcomes active, last completion 2h ago)
  loops: OK (2 durable tasks, none near expiry)
  email: WARN (2 unread older than 2h)
  sessions: OK (3 live, 1 stale record)
  rearm: OK (task present, ~5 days left)
```

## Escalation

For any `WARN` or `FAIL`: check the aboyeur board for an open item already covering it
(`bon list --json`, grep the titles); if none, file one standalone action on the board with
provenance in `--why` ("Filed by HEARTBEAT fire <timestamp>"). Never fix, never spawn, never
message — the bon is the escalation. An all-OK stanza is a complete, correct run.
