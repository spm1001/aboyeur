/**
 * Cron trigger source — fires periodic triggers into the daemon's queue.
 *
 * Simple interval-based scheduling. Each schedule has a name, interval,
 * and payload. When the interval elapses since the last fire, a trigger
 * row is inserted. Uses the daemon's cursor tracking for persistence
 * across restarts.
 */

import type { TriggerDB } from "./trigger-db.js";

// --- Types ---

export interface CronSchedule {
  /** Schedule name (used as context_group and cursor key). */
  name: string;
  /** Interval in milliseconds. */
  intervalMs: number;
  /** Payload to include in the trigger (JSON string). */
  payload: string;
}

export interface CronTriggerOptions {
  /** TriggerDB instance for inserting triggers and tracking cursors. */
  db: TriggerDB;
  /** Schedules to run. */
  schedules: CronSchedule[];
  /** Poll interval in ms (default: 10000 — check every 10s). */
  pollIntervalMs?: number;
}

// --- Cron trigger ---

export function startCronTrigger(opts: CronTriggerOptions): () => void {
  const { db, schedules } = opts;
  const pollMs = opts.pollIntervalMs ?? 10_000;

  function check() {
    const now = Date.now();

    for (const schedule of schedules) {
      const cursorKey = `cron:${schedule.name}`;
      const lastFired = db.getCursor(cursorKey);
      const lastMs = lastFired ? new Date(lastFired).getTime() : 0;

      if (now - lastMs >= schedule.intervalMs) {
        db.insert({
          source: "cron",
          context_group: schedule.name,
          payload: schedule.payload,
        });
        db.setCursor(cursorKey, new Date(now).toISOString());
      }
    }
  }

  // Check immediately on start
  check();

  const timer = setInterval(check, pollMs);

  return () => {
    clearInterval(timer);
  };
}
