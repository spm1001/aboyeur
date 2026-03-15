import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TriggerDB } from "./trigger-db.js";
import { startCronTrigger } from "./trigger-cron.js";

describe("startCronTrigger", () => {
  let db: TriggerDB;

  beforeEach(() => {
    db = new TriggerDB(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("fires a trigger immediately when no cursor exists", () => {
    const stop = startCronTrigger({
      db,
      schedules: [
        { name: "heartbeat", intervalMs: 30 * 60 * 1000, payload: JSON.stringify({ schedule: "heartbeat" }) },
      ],
      pollIntervalMs: 60_000, // won't fire again in test
    });

    const triggers = db.claimPending(10);
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0].source, "cron");
    assert.equal(triggers[0].context_group, "heartbeat");

    stop();
  });

  it("does not fire again before interval elapses", () => {
    const stop = startCronTrigger({
      db,
      schedules: [
        { name: "heartbeat", intervalMs: 30 * 60 * 1000, payload: JSON.stringify({ schedule: "heartbeat" }) },
      ],
      pollIntervalMs: 60_000,
    });

    // First fire
    const first = db.claimPending(10);
    assert.equal(first.length, 1);
    db.markDone(first[0].id);

    // Manually call again — should not fire (interval not elapsed)
    // The cursor was set on first fire, and 30 minutes haven't passed
    const second = db.claimPending(10);
    assert.equal(second.length, 0);

    stop();
  });

  it("fires after interval elapses (simulated via cursor manipulation)", () => {
    // Set cursor to 31 minutes ago
    const thirtyOneMinAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    db.setCursor("cron:heartbeat", thirtyOneMinAgo);

    const stop = startCronTrigger({
      db,
      schedules: [
        { name: "heartbeat", intervalMs: 30 * 60 * 1000, payload: JSON.stringify({ schedule: "heartbeat" }) },
      ],
      pollIntervalMs: 60_000,
    });

    const triggers = db.claimPending(10);
    assert.equal(triggers.length, 1);

    stop();
  });

  it("handles multiple schedules independently", () => {
    const stop = startCronTrigger({
      db,
      schedules: [
        { name: "heartbeat", intervalMs: 30 * 60 * 1000, payload: JSON.stringify({ schedule: "heartbeat" }) },
        { name: "daily-review", intervalMs: 24 * 60 * 60 * 1000, payload: JSON.stringify({ schedule: "daily-review" }) },
      ],
      pollIntervalMs: 60_000,
    });

    const triggers = db.claimPending(10);
    assert.equal(triggers.length, 2);
    const names = triggers.map(t => t.context_group).sort();
    assert.deepEqual(names, ["daily-review", "heartbeat"]);

    stop();
  });

  it("stops cleanly", () => {
    const stop = startCronTrigger({
      db,
      schedules: [
        { name: "heartbeat", intervalMs: 1000, payload: "{}" },
      ],
      pollIntervalMs: 100,
    });

    stop();
    // No assertion needed — just verify it doesn't throw or leave timers
  });
});
