/**
 * Tests for the conductor mesh trigger source.
 * Uses real TriggerDB (in-memory SQLite) and temp files for inbox.
 */

import { describe, it, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TriggerDB } from "./trigger-db.js";
import { startConductorTrigger } from "./trigger-conductor.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "conductor-trigger-test-"));
}

function tempDbPath(): string {
  const dir = tempDir();
  return join(dir, "test.db");
}

let stopFn: (() => void) | null = null;

afterEach(() => {
  if (stopFn) {
    stopFn();
    stopFn = null;
  }
});

describe("startConductorTrigger", () => {
  it("new inbox message creates a trigger row", async () => {
    const dbPath = tempDbPath();
    const bridgeDir = tempDir();
    const db = new TriggerDB(dbPath);
    const triggered: string[] = [];

    // Create empty inbox
    writeFileSync(join(bridgeDir, "inbox.jsonl"), "");

    stopFn = startConductorTrigger({
      db,
      bridgeDir,
      intervalMs: 50,
      onTrigger: (from, msg) => { triggered.push(`${from}:${msg}`); },
    });

    // Append a message to inbox
    const msg = JSON.stringify({ ts: 1000, from: "excel-d49606", message: "Check the forecast" });
    appendFileSync(join(bridgeDir, "inbox.jsonl"), msg + "\n");

    await new Promise(r => setTimeout(r, 200));

    assert.equal(triggered.length, 1);
    assert.equal(triggered[0], "excel-d49606:Check the forecast");

    const counts = db.counts();
    assert.equal(counts.pending, 1);

    // Verify the trigger row content
    const pending = db.pendingForContext("conductor:excel-d49606");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].source, "conductor");

    const payload = JSON.parse(pending[0].payload);
    assert.equal(payload.from, "excel-d49606");
    assert.equal(payload.message, "Check the forecast");

    db.close();
  });

  it("messages from same sender go to same context group (FIFO)", async () => {
    const dbPath = tempDbPath();
    const bridgeDir = tempDir();
    const db = new TriggerDB(dbPath);

    writeFileSync(join(bridgeDir, "inbox.jsonl"), "");

    stopFn = startConductorTrigger({
      db,
      bridgeDir,
      intervalMs: 50,
    });

    // Two messages from same sender
    appendFileSync(join(bridgeDir, "inbox.jsonl"),
      JSON.stringify({ ts: 1000, from: "cc-passe-abc123", message: "First" }) + "\n" +
      JSON.stringify({ ts: 1001, from: "cc-passe-abc123", message: "Second" }) + "\n"
    );

    await new Promise(r => setTimeout(r, 200));

    const pending = db.pendingForContext("conductor:cc-passe-abc123");
    assert.equal(pending.length, 2, "Both should be in same context group");

    db.close();
  });

  it("messages from different senders go to different context groups", async () => {
    const dbPath = tempDbPath();
    const bridgeDir = tempDir();
    const db = new TriggerDB(dbPath);

    writeFileSync(join(bridgeDir, "inbox.jsonl"), "");

    stopFn = startConductorTrigger({
      db,
      bridgeDir,
      intervalMs: 50,
    });

    appendFileSync(join(bridgeDir, "inbox.jsonl"),
      JSON.stringify({ ts: 1000, from: "excel-d49606", message: "From Excel" }) + "\n" +
      JSON.stringify({ ts: 1001, from: "cc-passe-abc123", message: "From Passe" }) + "\n"
    );

    await new Promise(r => setTimeout(r, 200));

    assert.equal(db.pendingForContext("conductor:excel-d49606").length, 1);
    assert.equal(db.pendingForContext("conductor:cc-passe-abc123").length, 1);

    db.close();
  });

  it("deduplicates identical messages", async () => {
    const dbPath = tempDbPath();
    const bridgeDir = tempDir();
    const db = new TriggerDB(dbPath);

    writeFileSync(join(bridgeDir, "inbox.jsonl"), "");

    stopFn = startConductorTrigger({
      db,
      bridgeDir,
      intervalMs: 50,
    });

    // Same message twice (same sender, same content — dedup hash matches)
    const msg = JSON.stringify({ ts: 1000, from: "excel-d49606", message: "Check the forecast" });
    appendFileSync(join(bridgeDir, "inbox.jsonl"), msg + "\n" + msg + "\n");

    await new Promise(r => setTimeout(r, 200));

    assert.equal(db.counts().pending, 1, "Duplicate should be rejected by dedup");

    db.close();
  });

  it("skips pre-existing messages (cursor starts at end of file)", async () => {
    const dbPath = tempDbPath();
    const bridgeDir = tempDir();
    const db = new TriggerDB(dbPath);
    const triggered: string[] = [];

    // Pre-populate inbox with old messages
    const oldMsg = JSON.stringify({ ts: 500, from: "old-agent", message: "Old message" });
    writeFileSync(join(bridgeDir, "inbox.jsonl"), oldMsg + "\n");

    stopFn = startConductorTrigger({
      db,
      bridgeDir,
      intervalMs: 50,
      onTrigger: (from, msg) => { triggered.push(`${from}:${msg}`); },
    });

    await new Promise(r => setTimeout(r, 200));

    // Old message should NOT have been picked up
    assert.equal(triggered.length, 0, "Pre-existing messages should be skipped");

    // New message should be picked up
    const newMsg = JSON.stringify({ ts: 2000, from: "new-agent", message: "New message" });
    appendFileSync(join(bridgeDir, "inbox.jsonl"), newMsg + "\n");

    await new Promise(r => setTimeout(r, 200));

    assert.equal(triggered.length, 1);
    assert.equal(triggered[0], "new-agent:New message");

    db.close();
  });

  it("handles missing inbox file gracefully", async () => {
    const dbPath = tempDbPath();
    const bridgeDir = tempDir();
    const db = new TriggerDB(dbPath);
    // Don't create inbox.jsonl — bridge hasn't started yet

    stopFn = startConductorTrigger({
      db,
      bridgeDir,
      intervalMs: 50,
    });

    // Should not crash
    await new Promise(r => setTimeout(r, 200));

    assert.equal(db.counts().pending, 0);

    // Now create inbox with a message — should be picked up
    const msg = JSON.stringify({ ts: 1000, from: "late-agent", message: "Hello" });
    writeFileSync(join(bridgeDir, "inbox.jsonl"), msg + "\n");

    await new Promise(r => setTimeout(r, 200));

    assert.equal(db.counts().pending, 1);

    db.close();
  });

  it("handles malformed JSON lines without crashing", async () => {
    const dbPath = tempDbPath();
    const bridgeDir = tempDir();
    const db = new TriggerDB(dbPath);

    writeFileSync(join(bridgeDir, "inbox.jsonl"), "");

    stopFn = startConductorTrigger({
      db,
      bridgeDir,
      intervalMs: 50,
    });

    // Mix of valid and invalid lines
    appendFileSync(join(bridgeDir, "inbox.jsonl"),
      "not json\n" +
      JSON.stringify({ ts: 1000, from: "good-agent", message: "Valid" }) + "\n" +
      "{broken\n"
    );

    await new Promise(r => setTimeout(r, 200));

    assert.equal(db.counts().pending, 1, "Only valid message should create trigger");

    db.close();
  });
});
