import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSpawn } from "./router.js";
import type { Trigger } from "./trigger-db.js";

const makeTrigger = (overrides: Partial<Trigger> = {}): Trigger => ({
  id: 1,
  source: "gmail",
  context_group: "thread_abc123",
  payload: JSON.stringify({ messageId: "msg_001", subject: "Q3 data request", from: "jane@example.com" }),
  dedup_hash: "abc123",
  status: "claimed",
  created_at: "2026-03-15T16:30:00Z",
  claimed_at: "2026-03-15T16:30:01Z",
  done_at: null,
  error: null,
  ...overrides,
});

describe("resolveSpawn", () => {
  it("produces valid SpawnAgentOptions for an email trigger", () => {
    const trigger = makeTrigger();
    const result = resolveSpawn(trigger, { aboyeurDir: "/tmp/test-aboyeur" });

    assert.equal(result.folder, "/tmp/test-aboyeur");
    assert.ok(result.prompt.includes("gmail"));
    assert.ok(result.prompt.includes("Q3 data request"));
    assert.ok(result.prompt.includes("jane@example.com"));
    assert.ok(result.sessionId?.startsWith("aboyeur-gmail-"));
    assert.equal(result.maxTurns, 20);
  });

  it("produces valid options for a cron trigger", () => {
    const trigger = makeTrigger({
      source: "cron",
      context_group: "heartbeat",
      payload: JSON.stringify({ schedule: "heartbeat", interval: "30m" }),
    });
    const result = resolveSpawn(trigger);

    assert.ok(result.sessionId?.startsWith("aboyeur-cron-"));
    assert.ok(result.prompt.includes("cron"));
    assert.ok(result.prompt.includes("heartbeat"));
  });

  it("produces valid options for a conductor trigger", () => {
    const trigger = makeTrigger({
      source: "conductor",
      context_group: "/home/modha/Repos/passe",
      payload: JSON.stringify({ from: "cc-passe-a3f9e2", message: "Tests passing, ready for review" }),
    });
    const result = resolveSpawn(trigger);

    assert.ok(result.sessionId?.startsWith("aboyeur-conductor-"));
    assert.ok(result.prompt.includes("conductor"));
    assert.ok(result.prompt.includes("cc-passe-a3f9e2"));
  });

  it("handles non-JSON payload gracefully", () => {
    const trigger = makeTrigger({ payload: "plain text payload" });
    const result = resolveSpawn(trigger);

    assert.ok(result.prompt.includes("plain text payload"));
  });

  it("session names include HHMMSS timestamp", () => {
    const trigger = makeTrigger();
    const result = resolveSpawn(trigger);
    // Session name: aboyeur-gmail-HHMMSS (6 digits)
    const match = result.sessionId?.match(/^aboyeur-gmail-(\d{6})$/);
    assert.ok(match, `Expected aboyeur-gmail-HHMMSS, got: ${result.sessionId}`);
  });

  it("loads system prompt from prompts directory", () => {
    // With real prompts dir
    const trigger = makeTrigger();
    const result = resolveSpawn(trigger, {
      promptsDir: new URL("../shared/prompts", import.meta.url).pathname,
    });
    // System prompt should contain content from aboyeur-open.md
    assert.ok(result.systemPrompt?.includes("aboyeur"));
  });

  it("omits system prompt when file not found", () => {
    const trigger = makeTrigger();
    const result = resolveSpawn(trigger, { promptsDir: "/nonexistent" });
    assert.equal(result.systemPrompt, undefined);
  });

  it("respects maxTurns override", () => {
    const trigger = makeTrigger();
    const result = resolveSpawn(trigger, { maxTurns: 5 });
    assert.equal(result.maxTurns, 5);
  });
});
