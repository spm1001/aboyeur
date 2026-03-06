/**
 * Tests for ContextQueue — concurrency, FIFO ordering, backoff, lane policies.
 * Pure in-memory, no external dependencies.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { ContextQueue } from "./context-queue.js";
import type { Trigger } from "./trigger-db.js";

/** Create a minimal trigger for testing. */
function fakeTrigger(id: number, contextGroup: string = "test"): Trigger {
  return {
    id,
    source: "test",
    context_group: contextGroup,
    payload: `payload-${id}`,
    dedup_hash: `hash-${id}`,
    status: "claimed",
    created_at: new Date().toISOString(),
    claimed_at: new Date().toISOString(),
    done_at: null,
    error: null,
  };
}

/** Helper: create a delayed async function that records execution order. */
function delayedFn(log: string[], label: string, ms: number = 50): () => Promise<void> {
  return () => new Promise((resolve) => {
    log.push(`start:${label}`);
    setTimeout(() => {
      log.push(`end:${label}`);
      resolve();
    }, ms);
  });
}

describe("ContextQueue", () => {
  it("processes triggers from different contexts in parallel", async () => {
    const q = new ContextQueue({ maxConcurrent: 3 });
    const log: string[] = [];

    q.enqueue("ctx-a", fakeTrigger(1, "ctx-a"), delayedFn(log, "a", 100));
    q.enqueue("ctx-b", fakeTrigger(2, "ctx-b"), delayedFn(log, "b", 100));
    q.enqueue("ctx-c", fakeTrigger(3, "ctx-c"), delayedFn(log, "c", 100));

    await new Promise(r => setTimeout(r, 50));

    // All three should have started (parallel across contexts)
    assert.ok(log.includes("start:a"), "ctx-a should have started");
    assert.ok(log.includes("start:b"), "ctx-b should have started");
    assert.ok(log.includes("start:c"), "ctx-c should have started");

    await new Promise(r => setTimeout(r, 200));
    assert.equal(q.active, 0);
  });

  it("processes triggers within same context sequentially (FIFO)", async () => {
    const q = new ContextQueue({ maxConcurrent: 3 });
    const log: string[] = [];

    q.enqueue("ctx-a", fakeTrigger(1, "ctx-a"), delayedFn(log, "first", 100));
    q.enqueue("ctx-a", fakeTrigger(2, "ctx-a"), delayedFn(log, "second", 50));

    await new Promise(r => setTimeout(r, 50));

    // Only first should have started
    assert.ok(log.includes("start:first"), "first should have started");
    assert.ok(!log.includes("start:second"), "second should NOT have started yet");

    await new Promise(r => setTimeout(r, 150));

    // Now second should have started after first finished
    assert.ok(log.includes("end:first"), "first should have finished");
    assert.ok(log.includes("start:second"), "second should have started");

    await new Promise(r => setTimeout(r, 100));

    // Verify FIFO order
    const startFirst = log.indexOf("start:first");
    const endFirst = log.indexOf("end:first");
    const startSecond = log.indexOf("start:second");
    assert.ok(startFirst < endFirst, "first starts before it ends");
    assert.ok(endFirst < startSecond, "first ends before second starts");
  });

  it("respects global concurrency limit", async () => {
    const q = new ContextQueue({ maxConcurrent: 2 });
    const log: string[] = [];

    q.enqueue("ctx-a", fakeTrigger(1), delayedFn(log, "a", 100));
    q.enqueue("ctx-b", fakeTrigger(2), delayedFn(log, "b", 100));
    q.enqueue("ctx-c", fakeTrigger(3), delayedFn(log, "c", 50));

    await new Promise(r => setTimeout(r, 50));

    // Only 2 should be running (maxConcurrent: 2)
    assert.equal(q.active, 2, "Should have exactly 2 active");
    assert.ok(!log.includes("start:c"), "ctx-c should be waiting");

    await new Promise(r => setTimeout(r, 150));

    // After first two finish, ctx-c should run
    assert.ok(log.includes("start:c"), "ctx-c should have started after slot freed");

    await new Promise(r => setTimeout(r, 100));
    assert.equal(q.active, 0);
  });

  it("retries with exponential backoff on failure", async () => {
    const q = new ContextQueue({ maxConcurrent: 3, baseRetryMs: 50, maxRetries: 2 });
    let attempts = 0;

    q.enqueue("ctx-a", fakeTrigger(1), async () => {
      attempts++;
      if (attempts < 3) throw new Error("fail");
    });

    // Wait for retries (50ms + 100ms + execution time)
    await new Promise(r => setTimeout(r, 300));

    assert.equal(attempts, 3, "Should have tried 3 times (1 initial + 2 retries)");
    assert.equal(q.active, 0);
  });

  it("drops task after max retries and calls onDropped", async () => {
    const dropped: number[] = [];
    const q = new ContextQueue({
      maxConcurrent: 3,
      baseRetryMs: 20,
      maxRetries: 2,
      onDropped: (_ctx, trigger) => { dropped.push(trigger.id); },
    });

    q.enqueue("ctx-a", fakeTrigger(42), async () => {
      throw new Error("always fails");
    });

    await new Promise(r => setTimeout(r, 300));

    assert.deepEqual(dropped, [42], "Should have dropped trigger 42");
    assert.equal(q.active, 0);
  });

  it("steer policy replaces pending queue", async () => {
    const q = new ContextQueue({ maxConcurrent: 3 });
    const log: string[] = [];

    q.setLanePolicy("ctx-a", "steer");

    // First trigger starts immediately
    q.enqueue("ctx-a", fakeTrigger(1), delayedFn(log, "first", 100));
    // Second trigger is enqueued
    q.enqueue("ctx-a", fakeTrigger(2), delayedFn(log, "second", 50));
    // Third trigger REPLACES second (steer policy)
    q.enqueue("ctx-a", fakeTrigger(3), delayedFn(log, "third", 50));

    await new Promise(r => setTimeout(r, 300));

    assert.ok(log.includes("start:first"), "first should run");
    assert.ok(!log.includes("start:second"), "second should be replaced");
    assert.ok(log.includes("start:third"), "third should run (replaced second)");
  });

  it("collect policy accumulates until flushed", async () => {
    const q = new ContextQueue({ maxConcurrent: 3 });
    const log: string[] = [];

    q.setLanePolicy("ctx-a", "collect");

    q.enqueue("ctx-a", fakeTrigger(1), delayedFn(log, "first", 50));
    q.enqueue("ctx-a", fakeTrigger(2), delayedFn(log, "second", 50));

    await new Promise(r => setTimeout(r, 100));

    // Nothing should have started (collect waits for flush)
    assert.equal(log.length, 0, "Nothing should run before flush");
    assert.equal(q.pending, 2, "Both should be pending");

    // Flush — starts processing
    q.flush("ctx-a");

    await new Promise(r => setTimeout(r, 200));

    assert.ok(log.includes("start:first"), "first should run after flush");
    assert.ok(log.includes("start:second"), "second should run after flush");
  });

  it("shuts down gracefully", async () => {
    const q = new ContextQueue({ maxConcurrent: 1 });
    const log: string[] = [];

    q.enqueue("ctx-a", fakeTrigger(1), delayedFn(log, "running", 100));
    q.enqueue("ctx-a", fakeTrigger(2), delayedFn(log, "queued", 50));

    await new Promise(r => setTimeout(r, 20));
    q.shutdown();

    await new Promise(r => setTimeout(r, 200));

    // Active task finishes, but queued task should not start
    assert.ok(log.includes("start:running"), "active task should finish");
    assert.ok(log.includes("end:running"), "active task should complete");
    assert.ok(!log.includes("start:queued"), "queued task should not start after shutdown");
  });

  it("reports active and pending counts", async () => {
    const q = new ContextQueue({ maxConcurrent: 1 });

    q.enqueue("ctx-a", fakeTrigger(1), delayedFn([], "a", 100));
    q.enqueue("ctx-a", fakeTrigger(2), delayedFn([], "b", 50));
    q.enqueue("ctx-b", fakeTrigger(3), delayedFn([], "c", 50));

    await new Promise(r => setTimeout(r, 20));

    assert.equal(q.active, 1, "One active (concurrency limit 1)");
    assert.equal(q.pending, 2, "Two pending (one same context, one different)");

    await new Promise(r => setTimeout(r, 300));
    assert.equal(q.active, 0);
    assert.equal(q.pending, 0);
  });
});
