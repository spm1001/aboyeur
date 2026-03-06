/**
 * Per-context FIFO queue with global concurrency limit.
 *
 * Cribbed from NanoClaw's GroupQueue (group-queue.ts) but stripped of
 * container/IPC specifics. This is pure concurrency governance:
 * - FIFO within each context group
 * - Global cap on concurrent active tasks (default 3)
 * - Exponential backoff on failure (5s base, max 5 retries)
 * - Lane policies: followup (default), steer (interrupt current), collect (batch)
 */

import { type Trigger } from "./trigger-db.js";

// --- Types ---

export type LanePolicy = "followup" | "steer" | "collect";

export interface ContextQueueOptions {
  /** Max concurrent tasks across all contexts (default: 3). */
  maxConcurrent?: number;
  /** Base retry delay in ms (default: 5000). Doubles each retry. */
  baseRetryMs?: number;
  /** Max retries before dropping a task (default: 5). */
  maxRetries?: number;
  /** Called when a task is dispatched. */
  onDispatch?: (contextId: string, trigger: Trigger) => void;
  /** Called when a task fails after all retries. */
  onDropped?: (contextId: string, trigger: Trigger, error: unknown) => void;
}

interface QueuedItem {
  trigger: Trigger;
  fn: () => Promise<void>;
}

interface ContextState {
  active: boolean;
  pending: QueuedItem[];
  retryCount: number;
  lanePolicy: LanePolicy;
  /** For "collect" policy: accumulated triggers awaiting batch dispatch. */
  collected: Trigger[];
  /** Set by flush() — allows drain to continue even in collect mode. */
  flushed: boolean;
}

// --- ContextQueue ---

export class ContextQueue {
  private contexts = new Map<string, ContextState>();
  private activeCount = 0;
  private waitingContexts: string[] = [];
  private shuttingDown = false;

  private readonly maxConcurrent: number;
  private readonly baseRetryMs: number;
  private readonly maxRetries: number;
  private readonly onDispatch?: (contextId: string, trigger: Trigger) => void;
  private readonly onDropped?: (contextId: string, trigger: Trigger, error: unknown) => void;

  constructor(opts: ContextQueueOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 3;
    this.baseRetryMs = opts.baseRetryMs ?? 5000;
    this.maxRetries = opts.maxRetries ?? 5;
    this.onDispatch = opts.onDispatch;
    this.onDropped = opts.onDropped;
  }

  private getContext(contextId: string): ContextState {
    let state = this.contexts.get(contextId);
    if (!state) {
      state = {
        active: false,
        pending: [],
        retryCount: 0,
        lanePolicy: "followup",
        collected: [],
        flushed: false,
      };
      this.contexts.set(contextId, state);
    }
    return state;
  }

  /** Set the lane policy for a context. */
  setLanePolicy(contextId: string, policy: LanePolicy): void {
    this.getContext(contextId).lanePolicy = policy;
  }

  /**
   * Enqueue a task for a context group.
   * The fn is called when it's this context's turn and a slot is available.
   */
  enqueue(contextId: string, trigger: Trigger, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getContext(contextId);

    // Lane policy handling
    switch (state.lanePolicy) {
      case "steer":
        // Steer: new trigger replaces pending queue (interrupt)
        state.pending = [{ trigger, fn }];
        if (!state.active) {
          this.tryRun(contextId);
        }
        return;

      case "collect":
        // Collect: accumulate triggers, don't dispatch yet
        state.collected.push(trigger);
        state.pending.push({ trigger, fn });
        if (!state.active) {
          // Don't auto-dispatch — caller must flush explicitly
        }
        return;

      case "followup":
      default:
        // Followup: FIFO — append and try to run
        state.pending.push({ trigger, fn });
        if (!state.active) {
          this.tryRun(contextId);
        }
        return;
    }
  }

  /**
   * Flush collected triggers for a context (collect policy).
   * Dispatches the first collected item; rest drain via FIFO.
   */
  flush(contextId: string): void {
    const state = this.getContext(contextId);
    state.collected = [];
    state.flushed = true;
    if (!state.active && state.pending.length > 0) {
      this.tryRun(contextId);
    }
  }

  private tryRun(contextId: string): void {
    if (this.shuttingDown) return;

    const state = this.getContext(contextId);
    if (state.active || state.pending.length === 0) return;

    if (this.activeCount >= this.maxConcurrent) {
      if (!this.waitingContexts.includes(contextId)) {
        this.waitingContexts.push(contextId);
      }
      return;
    }

    const item = state.pending.shift()!;
    state.active = true;
    this.activeCount++;

    this.onDispatch?.(contextId, item.trigger);

    item.fn().then(
      () => {
        state.retryCount = 0;
        this.finish(contextId);
      },
      (err) => {
        this.handleFailure(contextId, item, err);
      },
    );
  }

  private handleFailure(contextId: string, item: QueuedItem, error: unknown): void {
    const state = this.getContext(contextId);
    state.retryCount++;

    if (state.retryCount > this.maxRetries) {
      // Drop after max retries
      state.retryCount = 0;
      this.onDropped?.(contextId, item.trigger, error);
      this.finish(contextId);
      return;
    }

    // Exponential backoff — re-insert at front of queue
    const delayMs = this.baseRetryMs * Math.pow(2, state.retryCount - 1);
    state.pending.unshift(item);

    // Release the slot during the backoff wait
    state.active = false;
    this.activeCount--;

    setTimeout(() => {
      if (!this.shuttingDown) {
        this.tryRun(contextId);
      }
    }, delayMs);
  }

  private finish(contextId: string): void {
    const state = this.getContext(contextId);
    state.active = false;
    this.activeCount--;

    // Drain this context's queue first
    // For collect policy, only drain after flush() has been called
    if (state.pending.length > 0 && (state.lanePolicy !== "collect" || state.flushed)) {
      this.tryRun(contextId);
      return;
    }

    // Then check if other contexts are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (this.waitingContexts.length > 0 && this.activeCount < this.maxConcurrent) {
      const nextId = this.waitingContexts.shift()!;
      const state = this.getContext(nextId);
      if (state.pending.length > 0 && !state.active) {
        this.tryRun(nextId);
      }
    }
  }

  /** Current active count (for monitoring). */
  get active(): number {
    return this.activeCount;
  }

  /** Pending count across all contexts (for monitoring). */
  get pending(): number {
    let total = 0;
    for (const state of this.contexts.values()) {
      total += state.pending.length;
    }
    return total;
  }

  /** Graceful shutdown — stop accepting new tasks, let active ones finish. */
  shutdown(): void {
    this.shuttingDown = true;
    this.waitingContexts = [];
  }
}
