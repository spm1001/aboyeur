/**
 * conductor-bridge-supersede.test.ts — Verify that a bridge yields on supersession.
 *
 * When two bridges register with the same agentId, the conductor mesh closes
 * the older connection with code 1001, reason "Superseded by new connection".
 * The old bridge must NOT reconnect — it should set closed=true and stop.
 *
 * This test requires network access (connects to bridge.claudeusercontent.com).
 * It verifies the fix for aby-tarafo (interactive mode reconnect cycling).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ConductorBridge } from "./conductor-bridge.js";

const TEST_AGENT_ID = `cc-test-supersede-${Date.now().toString(36)}`;

describe("ConductorBridge supersession", () => {
  const bridges: ConductorBridge[] = [];

  after(() => {
    for (const b of bridges) {
      try { b.close(); } catch { /* ignore */ }
    }
  });

  it("yields on supersession instead of reconnecting", async () => {
    const logFileA = `/tmp/conductor-bridge/${TEST_AGENT_ID}-a/bridge.log`;
    const logFileB = `/tmp/conductor-bridge/${TEST_AGENT_ID}-b/bridge.log`;

    // Bridge A connects first
    const bridgeA = new ConductorBridge({
      agentId: TEST_AGENT_ID,
      label: "Test A",
      logFile: logFileA,
      bridgeDir: `/tmp/conductor-bridge/${TEST_AGENT_ID}-a`,
    });
    bridges.push(bridgeA);

    const aConnected = new Promise<void>((resolve) => {
      bridgeA.on("connected", () => resolve());
    });
    const aDisconnected = new Promise<void>((resolve) => {
      bridgeA.on("disconnected", () => resolve());
    });

    await bridgeA.connect();
    await aConnected;

    // Bridge B connects with the same agentId — should supersede A
    const bridgeB = new ConductorBridge({
      agentId: TEST_AGENT_ID,
      label: "Test B",
      logFile: logFileB,
      bridgeDir: `/tmp/conductor-bridge/${TEST_AGENT_ID}-b`,
    });
    bridges.push(bridgeB);

    const bConnected = new Promise<void>((resolve) => {
      bridgeB.on("connected", () => resolve());
    });

    await bridgeB.connect();
    await bConnected;

    // Wait for A to be superseded
    await aDisconnected;

    // Give a moment for any potential reconnect attempt
    await new Promise((r) => setTimeout(r, 3000));

    // Check A's log — should show "yielding", NOT "Reconnecting"
    const logA = existsSync(logFileA) ? readFileSync(logFileA, "utf-8") : "";
    assert.ok(
      logA.includes("yielding to new connection"),
      `Expected bridge A to yield. Log:\n${logA}`,
    );
    assert.ok(
      !logA.includes("Reconnecting in"),
      `Bridge A should NOT have attempted reconnection after supersession. Log:\n${logA}`,
    );

    // Bridge B should still be connected
    const peersB = bridgeB.getPeers();
    // (No assertion on peers count — just verify B didn't crash)

    // Clean up
    bridgeB.close();
  });
});
