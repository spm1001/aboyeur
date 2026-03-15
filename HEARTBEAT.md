# HEARTBEAT Checklist

This file is read by the aboyeur when a HEARTBEAT cron trigger fires.
The aboyeur works through each check and reports status.

## Checks

### 1. Bon state
- Any outcomes stale (no action completed in 7+ days)?
- Any actions stuck (waiting_for that should have been resolved)?

### 2. Trigger queue health
- Any failed triggers? (source, error, how old)
- Queue depth — is it growing?

### 3. Unprocessed email
- Any unread email older than 2 hours?

### 4. Daemon health
- Is the daemon process alive?
- Any error patterns in recent logs?

## Response format

Write a one-line status per check:
```
HEARTBEAT 2026-03-15T17:00:00Z
  bons: OK (3 outcomes active, last completion 2h ago)
  queue: OK (0 failed, 0 pending)
  email: WARN (2 unread older than 2h)
  daemon: OK
```

If any check is WARN or FAIL, spawn a one-shot to investigate.
