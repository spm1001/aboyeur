/**
 * Tests for TriggerDB and the polling loop.
 * Uses in-memory SQLite — no filesystem, no claude.
 */

import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { TriggerDB } from "./trigger-db.js";
import { startTriggerLoop } from "./trigger-loop.js";

let db: TriggerDB;

beforeEach(() => {
  db = new TriggerDB(":memory:");
});

describe("TriggerDB", () => {
  it("inserts and claims a trigger", () => {
    const id = db.insert({ source: "gmail", context_group: "email", payload: '{"threadId":"123"}' });
    assert.ok(id !== null, "Should return an ID");

    const claimed = db.claimPending(10);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].source, "gmail");
    assert.equal(claimed[0].status, "claimed");
    assert.ok(claimed[0].claimed_at);
  });

  it("deduplicates by source+payload", () => {
    db.insert({ source: "gmail", context_group: "email", payload: '{"threadId":"123"}' });
    const dupe = db.insert({ source: "gmail", context_group: "email", payload: '{"threadId":"123"}' });
    assert.equal(dupe, null, "Duplicate should return null");

    // Different payload = different trigger
    const different = db.insert({ source: "gmail", context_group: "email", payload: '{"threadId":"456"}' });
    assert.ok(different !== null, "Different payload should insert");
  });

  it("allows re-insert after done", () => {
    const id1 = db.insert({ source: "cron", context_group: "heartbeat", payload: "tick" })!;
    const claimed = db.claimPending(1);
    db.markDone(claimed[0].id);

    // Same payload should now be insertable again
    const id2 = db.insert({ source: "cron", context_group: "heartbeat", payload: "tick" });
    assert.ok(id2 !== null, "Should allow re-insert after done");
    assert.ok(id2! > id1, "New ID should be greater");
  });

  it("marks triggers as done or failed", () => {
    db.insert({ source: "test", context_group: "g1", payload: "ok" });
    db.insert({ source: "test", context_group: "g1", payload: "bad" });

    const claimed = db.claimPending(10);
    db.markDone(claimed[0].id);
    db.markFailed(claimed[1].id, "something broke");

    const counts = db.counts();
    assert.equal(counts.done, 1);
    assert.equal(counts.failed, 1);
    assert.equal(counts.pending, 0);
    assert.equal(counts.claimed, 0);
  });

  it("recovers claimed triggers on startup", () => {
    db.insert({ source: "test", context_group: "g1", payload: "a" });
    db.insert({ source: "test", context_group: "g1", payload: "b" });
    db.claimPending(10); // Claim both

    const recovered = db.recoverClaimed();
    assert.equal(recovered, 2);

    // They should be pending again
    const counts = db.counts();
    assert.equal(counts.pending, 2);
    assert.equal(counts.claimed, 0);
  });

  it("tracks cursors per source", () => {
    assert.equal(db.getCursor("gmail"), null);

    db.setCursor("gmail", "2026-03-06T19:00:00Z");
    assert.equal(db.getCursor("gmail"), "2026-03-06T19:00:00Z");

    db.setCursor("gmail", "2026-03-06T20:00:00Z");
    assert.equal(db.getCursor("gmail"), "2026-03-06T20:00:00Z");

    // Different source is independent
    assert.equal(db.getCursor("cron"), null);
  });

  it("queries pending triggers by context group", () => {
    db.insert({ source: "gmail", context_group: "email", payload: "a" });
    db.insert({ source: "gmail", context_group: "email", payload: "b" });
    db.insert({ source: "cron", context_group: "heartbeat", payload: "tick" });

    const emailTriggers = db.pendingForContext("email");
    assert.equal(emailTriggers.length, 2);

    const heartbeatTriggers = db.pendingForContext("heartbeat");
    assert.equal(heartbeatTriggers.length, 1);
  });
});

describe("startTriggerLoop", () => {
  it("processes pending triggers and marks them done", async () => {
    db.insert({ source: "test", context_group: "g1", payload: "hello" });
    db.insert({ source: "test", context_group: "g1", payload: "world" });

    const processed: string[] = [];

    const stop = startTriggerLoop({
      db,
      handler: async (trigger) => {
        processed.push(trigger.payload);
      },
      intervalMs: 50,
    });

    // Wait for processing
    await new Promise(r => setTimeout(r, 200));
    stop();

    assert.deepEqual(processed, ["hello", "world"]);
    const counts = db.counts();
    assert.equal(counts.done, 2);
    assert.equal(counts.pending, 0);
  });

  it("marks failed triggers on handler error", async () => {
    db.insert({ source: "test", context_group: "g1", payload: "boom" });

    const errors: string[] = [];

    const stop = startTriggerLoop({
      db,
      handler: async () => {
        throw new Error("kaboom");
      },
      intervalMs: 50,
      onError: (_t, err) => {
        errors.push(err instanceof Error ? err.message : String(err));
      },
    });

    await new Promise(r => setTimeout(r, 200));
    stop();

    assert.equal(errors.length, 1);
    assert.equal(errors[0], "kaboom");
    const counts = db.counts();
    assert.equal(counts.failed, 1);
  });

  it("stops cleanly", async () => {
    const stop = startTriggerLoop({
      db,
      handler: async () => {},
      intervalMs: 50,
    });

    // Insert after starting — should get picked up
    db.insert({ source: "test", context_group: "g1", payload: "late" });

    await new Promise(r => setTimeout(r, 200));
    stop();

    // Insert after stopping — should NOT get picked up
    db.insert({ source: "test", context_group: "g1", payload: "too-late" });

    await new Promise(r => setTimeout(r, 200));

    const counts = db.counts();
    assert.equal(counts.done, 1, "Only the pre-stop trigger should be done");
    assert.equal(counts.pending, 1, "Post-stop trigger should stay pending");
  });
});
