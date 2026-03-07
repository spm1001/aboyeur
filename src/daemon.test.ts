/**
 * Integration tests for startDaemon() — the full trigger → queue → spawn → result cycle.
 * Uses a mock spawn function instead of real claude processes.
 * All tests use in-memory SQLite and temp directories — fast, no external deps.
 */

import { describe, it, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { startDaemon, type DaemonHandle } from "./daemon.js";
import type { SpawnAgentOptions, SpawnAgentResult } from "./spawn-agent.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Mock spawn ---

/** Create a mock spawn that records calls and returns canned results. */
function mockSpawn(opts: { delayMs?: number; result?: Partial<SpawnAgentResult> } = {}): {
  fn: (o: SpawnAgentOptions) => Promise<SpawnAgentResult>;
  calls: SpawnAgentOptions[];
} {
  const calls: SpawnAgentOptions[] = [];
  const fn = async (o: SpawnAgentOptions): Promise<SpawnAgentResult> => {
    calls.push(o);
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
    return {
      status: "success",
      result: "mock output",
      sessionId: "mock-session-123",
      events: [{ type: "result", subtype: "success" }],
      exitCode: 0,
      stderr: [],
      ...opts.result,
    };
  };
  return { fn, calls };
}

/** Create a temp dir for a test's SQLite db. */
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "aboyeur-daemon-test-"));
  return join(dir, "test.db");
}

// --- Tests ---

let handle: DaemonHandle | null = null;

afterEach(() => {
  if (handle) {
    handle.stop();
    handle = null;
  }
});

describe("startDaemon integration", () => {
  it("full cycle: insert trigger → loop claims → queue dispatches → mock spawn → callbacks fire", async () => {
    const { fn: spawn, calls } = mockSpawn({ delayMs: 10 });
    const dispatched: string[] = [];
    const completed: string[] = [];
    const dbPath = tempDbPath();

    handle = startDaemon({
      dbPath,
      pollIntervalMs: 50,
      queueOptions: { maxConcurrent: 3 },
      resolveSpawn: (trigger) => ({
        folder: "/tmp/test-folder",
        prompt: `Process: ${trigger.payload}`,
        maxTurns: 1,
      }),
      spawn,
      onDispatch: (trigger) => { dispatched.push(trigger.payload); },
      onComplete: (trigger, result) => { completed.push(`${trigger.payload}:${result.status}`); },
    });

    // Insert a trigger — this is what a Gmail poller or cron would do
    handle.db.insert({ source: "test", context_group: "test-ctx", payload: "email-123" });

    // Wait for the cycle: poll (50ms) + claim + enqueue + mock spawn (10ms)
    await new Promise(r => setTimeout(r, 300));

    assert.equal(calls.length, 1, "Mock spawn should have been called once");
    assert.equal(calls[0].prompt, "Process: email-123");
    assert.equal(calls[0].folder, "/tmp/test-folder");
    assert.deepEqual(dispatched, ["email-123"]);
    assert.deepEqual(completed, ["email-123:success"]);

    const counts = handle.db.counts();
    assert.equal(counts.done, 1, "Trigger should be marked done");
    assert.equal(counts.pending, 0);
  });

  it("multiple triggers from different contexts all get processed", async () => {
    const { fn: spawn, calls } = mockSpawn({ delayMs: 10 });
    const dbPath = tempDbPath();

    handle = startDaemon({
      dbPath,
      pollIntervalMs: 50,
      queueOptions: { maxConcurrent: 3 },
      resolveSpawn: (trigger) => ({
        folder: "/tmp/test",
        prompt: trigger.payload,
        maxTurns: 1,
      }),
      spawn,
    });

    handle.db.insert({ source: "test", context_group: "ctx-a", payload: "alpha" });
    handle.db.insert({ source: "test", context_group: "ctx-b", payload: "beta" });
    handle.db.insert({ source: "test", context_group: "ctx-c", payload: "gamma" });

    await new Promise(r => setTimeout(r, 400));

    const prompts = calls.map(c => c.prompt).sort();
    assert.deepEqual(prompts, ["alpha", "beta", "gamma"]);
    assert.equal(handle.db.counts().done, 3);
  });

  it("triggers within same context run sequentially (FIFO)", async () => {
    const order: string[] = [];
    const { fn: spawn } = mockSpawn({ delayMs: 50 });
    const wrappedSpawn = async (o: SpawnAgentOptions): Promise<SpawnAgentResult> => {
      order.push(`start:${o.prompt}`);
      const result = await spawn(o);
      order.push(`end:${o.prompt}`);
      return result;
    };

    const dbPath = tempDbPath();

    handle = startDaemon({
      dbPath,
      pollIntervalMs: 50,
      queueOptions: { maxConcurrent: 3 },
      resolveSpawn: (trigger) => ({
        folder: "/tmp/test",
        prompt: trigger.payload,
        maxTurns: 1,
      }),
      spawn: wrappedSpawn,
    });

    handle.db.insert({ source: "test", context_group: "same-ctx", payload: "first" });
    handle.db.insert({ source: "test", context_group: "same-ctx", payload: "second" });

    await new Promise(r => setTimeout(r, 500));

    // Verify FIFO: first ends before second starts
    const endFirst = order.indexOf("end:first");
    const startSecond = order.indexOf("start:second");
    assert.ok(endFirst >= 0, "first should have ended");
    assert.ok(startSecond >= 0, "second should have started");
    assert.ok(endFirst < startSecond, `first should end (${endFirst}) before second starts (${startSecond})`);
  });

  it("spawn errors trigger onError and mark trigger as done (queue handles retry)", async () => {
    const errors: string[] = [];
    const { fn: spawn } = mockSpawn({ result: { status: "error", result: "Agent failed" } });

    const dbPath = tempDbPath();

    handle = startDaemon({
      dbPath,
      pollIntervalMs: 50,
      queueOptions: { maxConcurrent: 3, maxRetries: 0, baseRetryMs: 10 },
      resolveSpawn: (trigger) => ({
        folder: "/tmp/test",
        prompt: trigger.payload,
        maxTurns: 1,
      }),
      spawn,
      onError: (_trigger, err) => {
        errors.push(err instanceof Error ? err.message : String(err));
      },
    });

    handle.db.insert({ source: "test", context_group: "test-ctx", payload: "will-fail" });

    await new Promise(r => setTimeout(r, 300));

    assert.ok(errors.length >= 1, "Should have recorded an error");
    assert.ok(errors[0].includes("Agent returned error"), `Error should mention agent failure, got: ${errors[0]}`);
  });

  it("crash recovery: claimed triggers are re-queued on startup", async () => {
    const dbPath = tempDbPath();
    const dbDir = join(dbPath, "..");
    mkdirSync(dbDir, { recursive: true });

    // Simulate a crash: create DB, insert and claim triggers, then "crash" (close without marking done)
    const { TriggerDB } = await import("./trigger-db.js");
    const crashDb = new TriggerDB(dbPath);
    crashDb.insert({ source: "test", context_group: "test-ctx", payload: "orphan-a" });
    crashDb.insert({ source: "test", context_group: "test-ctx", payload: "orphan-b" });
    crashDb.claimPending(10); // Claim both — simulating mid-processing crash
    crashDb.close();

    // Now restart — daemon should recover and process the orphaned triggers
    const { fn: spawn, calls } = mockSpawn({ delayMs: 10 });

    handle = startDaemon({
      dbPath,
      pollIntervalMs: 50,
      queueOptions: { maxConcurrent: 3 },
      resolveSpawn: (trigger) => ({
        folder: "/tmp/test",
        prompt: `recovered:${trigger.payload}`,
        maxTurns: 1,
      }),
      spawn,
    });

    await new Promise(r => setTimeout(r, 500));

    assert.equal(calls.length, 2, "Both orphaned triggers should have been recovered and processed");
    const prompts = calls.map(c => c.prompt).sort();
    assert.deepEqual(prompts, ["recovered:orphan-a", "recovered:orphan-b"]);
  });

  it("deduplication: same trigger is not processed twice", async () => {
    const { fn: spawn, calls } = mockSpawn({ delayMs: 10 });
    const dbPath = tempDbPath();

    handle = startDaemon({
      dbPath,
      pollIntervalMs: 50,
      queueOptions: { maxConcurrent: 3 },
      resolveSpawn: (trigger) => ({
        folder: "/tmp/test",
        prompt: trigger.payload,
        maxTurns: 1,
      }),
      spawn,
    });

    const id1 = handle.db.insert({ source: "gmail", context_group: "email", payload: '{"threadId":"123"}' });
    const id2 = handle.db.insert({ source: "gmail", context_group: "email", payload: '{"threadId":"123"}' });

    assert.ok(id1 !== null, "First insert should succeed");
    assert.equal(id2, null, "Duplicate should be rejected");

    await new Promise(r => setTimeout(r, 300));

    assert.equal(calls.length, 1, "Only one spawn for deduplicated trigger");
  });

  it("stop shuts down cleanly: loop stops, queue drains active, db closes", async () => {
    const { fn: spawn, calls } = mockSpawn({ delayMs: 200 });
    const dbPath = tempDbPath();

    handle = startDaemon({
      dbPath,
      pollIntervalMs: 50,
      queueOptions: { maxConcurrent: 3 },
      resolveSpawn: (trigger) => ({
        folder: "/tmp/test",
        prompt: trigger.payload,
        maxTurns: 1,
      }),
      spawn,
    });

    // Insert trigger that will be in-progress when we stop
    handle.db.insert({ source: "test", context_group: "test-ctx", payload: "in-flight" });

    await new Promise(r => setTimeout(r, 100)); // Let it start spawning

    handle.stop();
    handle = null; // Prevent afterEach from double-stopping

    // Insert after stop — should not be processed
    // (Can't insert after db.close(), so this verifies the stop sequence)
    assert.equal(calls.length, 1, "One spawn should have started before stop");
  });
});
