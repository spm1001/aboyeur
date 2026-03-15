/**
 * Conductor mesh trigger source for the daemon.
 *
 * Polls the bridge's inbox.jsonl for new messages and inserts them as
 * trigger rows. Each message becomes a trigger with source="conductor"
 * and context_group keyed by sender (so messages from the same peer
 * queue FIFO rather than running in parallel).
 *
 * The daemon runs its own conductor bridge as a long-lived sidecar.
 * This module only reads the inbox — bridge lifecycle is managed elsewhere.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type TriggerDB } from "./trigger-db.js";

// --- Types ---

export interface ConductorTriggerOptions {
  /** TriggerDB instance to insert triggers into. */
  db: TriggerDB;
  /** Path to the bridge directory (e.g. /tmp/conductor-bridge/aboyeur-daemon). */
  bridgeDir: string;
  /** Polling interval in ms (default: 1000). */
  intervalMs?: number;
  /** Called when a new trigger is inserted. */
  onTrigger?: (from: string, message: string) => void;
  /** Called on errors (default: console.error). */
  onError?: (error: unknown) => void;
}

// --- Poller ---

/**
 * Start polling the conductor bridge inbox for new messages.
 * Returns a stop function.
 */
export function startConductorTrigger(opts: ConductorTriggerOptions): () => void {
  const {
    db,
    bridgeDir,
    intervalMs = 1000,
    onTrigger,
    onError = (e) => console.error("Conductor trigger error:", e),
  } = opts;

  const inboxPath = join(bridgeDir, "inbox.jsonl");
  let cursor = 0;
  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Start cursor at end of file (skip pre-existing messages from before daemon started)
  try {
    cursor = statSync(inboxPath).size;
  } catch {
    // File doesn't exist yet — will be created by bridge. Start at 0.
    cursor = 0;
  }

  function poll(): void {
    if (!running) return;

    try {
      let size: number;
      try {
        size = statSync(inboxPath).size;
      } catch {
        // Inbox doesn't exist yet — bridge hasn't started or hasn't received anything
        scheduleNext();
        return;
      }

      if (size <= cursor) {
        scheduleNext();
        return;
      }

      // Read new content from cursor position
      const content = readFileSync(inboxPath, "utf-8");
      const newContent = content.slice(cursor);
      cursor = content.length;

      for (const line of newContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const msg = JSON.parse(trimmed) as { from: string; message: string; ts?: number };
          const from = msg.from ?? "unknown";
          const message = msg.message ?? "";

          const payload = JSON.stringify({
            from,
            message,
            receivedAt: msg.ts ?? Date.now() / 1000,
          });

          const id = db.insert({
            source: "conductor",
            context_group: `conductor:${from}`,
            payload,
          });

          if (id !== null) {
            onTrigger?.(from, message);
          }
          // id === null means dedup caught it — same message already pending
        } catch {
          // Malformed JSON line — skip
        }
      }
    } catch (err) {
      onError(err);
    }

    scheduleNext();
  }

  function scheduleNext(): void {
    if (running) {
      timer = setTimeout(poll, intervalMs);
    }
  }

  // Kick off first poll
  poll();

  return () => {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
