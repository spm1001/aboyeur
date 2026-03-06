/**
 * Polling loop that drains the trigger queue.
 *
 * Claims pending triggers and dispatches them to a handler function.
 * The handler is where spawnAgent() gets called — this module doesn't
 * know about Claude, just about draining a queue.
 */

import { TriggerDB, type Trigger } from "./trigger-db.js";

// --- Types ---

export interface TriggerLoopOptions {
  /** TriggerDB instance to poll. */
  db: TriggerDB;
  /** Called for each claimed trigger. Return resolves when processing is done. */
  handler: (trigger: Trigger) => Promise<void>;
  /** Polling interval in ms (default: 2000). */
  intervalMs?: number;
  /** Max triggers to claim per poll (default: 10). */
  batchSize?: number;
  /** Called on handler errors (default: console.error). */
  onError?: (trigger: Trigger, error: unknown) => void;
}

// --- Loop ---

/**
 * Start the polling loop. Returns a stop function.
 *
 * On each tick:
 * 1. Claims up to batchSize pending triggers
 * 2. Dispatches each to handler (concurrent within a batch)
 * 3. Marks done or failed based on handler result
 *
 * Note: concurrency limiting per context_group is NOT handled here —
 * that's aby-bunuza (FIFO queue with concurrency limits). This loop
 * just drains the queue; the handler is responsible for respecting
 * concurrency.
 */
export function startTriggerLoop(opts: TriggerLoopOptions): () => void {
  const {
    db,
    handler,
    intervalMs = 2000,
    batchSize = 10,
    onError = (t, e) => console.error(`Trigger ${t.id} failed:`, e),
  } = opts;

  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    if (!running) return;

    try {
      const claimed = db.claimPending(batchSize);

      if (claimed.length > 0) {
        // Process all claimed triggers concurrently
        await Promise.all(
          claimed.map(async (trigger) => {
            try {
              await handler(trigger);
              db.markDone(trigger.id);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              db.markFailed(trigger.id, message);
              onError(trigger, err);
            }
          }),
        );
      }
    } catch (err) {
      // DB-level error — log but don't crash the loop
      console.error("Trigger loop error:", err);
    }

    if (running) {
      timer = setTimeout(tick, intervalMs);
    }
  }

  // Kick off first tick
  tick();

  // Return stop function
  return () => {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
