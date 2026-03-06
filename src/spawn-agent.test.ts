/**
 * Tests for spawnAgent — integration tests that spawn real `claude` processes.
 * Skips gracefully when `claude` is not in PATH.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { spawnAgent } from "./spawn-agent.js";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function claudeAvailable(): boolean {
  try {
    execSync("which claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("spawnAgent", () => {
  it("spawns claude and gets a response", async () => {
    if (!claudeAvailable()) {
      console.log("  skipping: claude not in PATH");
      return;
    }

    const folder = mkdtempSync(join(tmpdir(), "aboyeur-test-"));
    let spawnedPid: number | undefined;

    const result = await spawnAgent({
      folder,
      prompt: "Reply with exactly: PING_OK",
      maxTurns: 1,
      systemPrompt: "You are in a test. Reply with exactly the text requested, nothing else.",
      onSpawn: (pid) => { spawnedPid = pid; },
    });

    assert.equal(result.status, "success", `Expected success, got ${result.status}. stderr: ${result.stderr.join("\n")}`);
    assert.ok(result.sessionId, "Should have a session ID");
    assert.ok(result.events.length > 0, "Should have received events");
    assert.ok(result.result.includes("PING_OK"), `Expected PING_OK in result, got: ${result.result}`);
    assert.ok(spawnedPid !== undefined, "onSpawn should have been called with PID");
    assert.ok(typeof spawnedPid === "number" && spawnedPid > 0, `PID should be positive, got: ${spawnedPid}`);
  });

  it("session resume continues a previous session", async () => {
    if (!claudeAvailable()) {
      console.log("  skipping: claude not in PATH");
      return;
    }

    const folder = mkdtempSync(join(tmpdir(), "aboyeur-test-"));

    // First session: establish a fact
    const first = await spawnAgent({
      folder,
      prompt: "Remember this code word: ZEBRA_42. Reply with exactly: STORED",
      maxTurns: 1,
      systemPrompt: "You are in a test. Follow instructions exactly.",
    });

    assert.equal(first.status, "success", `First session failed: ${first.stderr.join("\n")}`);
    assert.ok(first.result.includes("STORED"), `Expected STORED, got: ${first.result}`);

    // Second session: resume and recall
    const second = await spawnAgent({
      folder,
      prompt: "What was the code word I told you? Reply with exactly that code word and nothing else.",
      sessionId: first.sessionId,
      resume: true,
      maxTurns: 1,
      systemPrompt: "You are in a test. Follow instructions exactly.",
    });

    assert.equal(second.status, "success", `Resume session failed: ${second.stderr.join("\n")}`);
    assert.ok(second.result.includes("ZEBRA_42"), `Expected ZEBRA_42 in resumed result, got: ${second.result}`);
    assert.equal(second.sessionId, first.sessionId, "Resumed session should keep the same ID");
  });

  it("respects abort signal", async () => {
    if (!claudeAvailable()) {
      console.log("  skipping: claude not in PATH");
      return;
    }

    const folder = mkdtempSync(join(tmpdir(), "aboyeur-test-"));
    const controller = new AbortController();

    // Abort after 2 seconds
    setTimeout(() => controller.abort(), 2000);

    const result = await spawnAgent({
      folder,
      prompt: "Write a very long essay about the history of computing. Take your time.",
      maxTurns: 10,
      signal: controller.signal,
    });

    assert.equal(result.status, "aborted");
  });

  it("times out if init takes too long", async () => {
    // This test uses a fake command to simulate a hung init.
    // We can't easily make `claude` hang, so we test the timeout
    // with a very short timeout on a real spawn — the init event
    // usually takes a few seconds, so 1ms should always timeout.
    if (!claudeAvailable()) {
      console.log("  skipping: claude not in PATH");
      return;
    }

    const folder = mkdtempSync(join(tmpdir(), "aboyeur-test-"));
    const result = await spawnAgent({
      folder,
      prompt: "Reply with: OK",
      maxTurns: 1,
      initTimeoutMs: 1, // 1ms — will always timeout before init
    });

    // Process was killed by init timeout — either aborted or error
    assert.ok(
      result.status === "aborted" || result.status === "error",
      `Expected aborted or error from init timeout, got: ${result.status}`,
    );
    assert.ok(
      result.stderr.some(l => l.includes("init timeout")),
      "Stderr should mention init timeout",
    );
  });
});
