/**
 * Daemon wiring — connects the three core modules:
 *   TriggerLoop → ContextQueue → spawnAgent()
 *
 * This is the daemon's main integration point. Trigger sources (Gmail, cron, etc.)
 * insert into TriggerDB. The loop claims them. The queue governs concurrency.
 * spawnAgent() does the work.
 */

import { TriggerDB, type Trigger } from "./trigger-db.js";
import { startTriggerLoop } from "./trigger-loop.js";
import { ContextQueue, type ContextQueueOptions } from "./context-queue.js";
import { spawnAgent, type SpawnAgentOptions } from "./spawn-agent.js";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// --- Types ---

export interface DaemonOptions {
  /** Path to the SQLite database file. */
  dbPath: string;
  /** Polling interval in ms (default: 2000). */
  pollIntervalMs?: number;
  /** ContextQueue options (concurrency, backoff, etc). */
  queueOptions?: ContextQueueOptions;
  /**
   * Resolve a trigger into spawnAgent options.
   * This is where trigger-specific logic lives: what folder to use,
   * what prompt to send, what system prompt to inject.
   */
  resolveSpawn: (trigger: Trigger) => SpawnAgentOptions;
  /** Called when a trigger is dispatched to spawnAgent. */
  onDispatch?: (trigger: Trigger) => void;
  /** Called when a trigger completes. */
  onComplete?: (trigger: Trigger, result: Awaited<ReturnType<typeof spawnAgent>>) => void;
  /** Called on errors. */
  onError?: (trigger: Trigger, error: unknown) => void;
}

export interface DaemonHandle {
  db: TriggerDB;
  queue: ContextQueue;
  stop: () => void;
}

// --- Daemon ---

export function startDaemon(opts: DaemonOptions): DaemonHandle {
  // Ensure DB directory exists
  const dbDir = join(opts.dbPath, "..");
  mkdirSync(dbDir, { recursive: true });

  const db = new TriggerDB(opts.dbPath);

  // Crash recovery: re-queue any triggers that were claimed when we last died
  const recovered = db.recoverClaimed();
  if (recovered > 0) {
    opts.onError?.({ id: 0, source: "daemon", context_group: "startup", payload: `Recovered ${recovered} claimed triggers`, dedup_hash: "", status: "pending", created_at: new Date().toISOString(), claimed_at: null, done_at: null, error: null }, `Recovered ${recovered} claimed triggers from previous crash`);
  }

  const queue = new ContextQueue(opts.queueOptions);

  const stopLoop = startTriggerLoop({
    db,
    intervalMs: opts.pollIntervalMs,
    handler: async (trigger: Trigger) => {
      // Enqueue into the context queue — it handles FIFO and concurrency
      return new Promise<void>((resolve, reject) => {
        queue.enqueue(trigger.context_group, trigger, async () => {
          try {
            opts.onDispatch?.(trigger);
            const spawnOpts = opts.resolveSpawn(trigger);
            const result = await spawnAgent(spawnOpts);
            opts.onComplete?.(trigger, result);

            if (result.status === "error") {
              throw new Error(`Agent returned error: ${result.result || "unknown"}`);
            }
          } catch (err) {
            opts.onError?.(trigger, err);
            throw err; // Let the queue handle retry/backoff
          }
        });
        // The trigger is "handled" from the loop's perspective once it's enqueued.
        // The queue manages the actual execution lifecycle.
        resolve();
      });
    },
    onError: (trigger, error) => {
      opts.onError?.(trigger, error);
    },
  });

  return {
    db,
    queue,
    stop: () => {
      stopLoop();
      queue.shutdown();
      db.close();
    },
  };
}
