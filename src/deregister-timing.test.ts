/**
 * deregister-timing.test.ts — Measure conductor_agent_reset timing.
 *
 * Connects two bridges: an observer and a subject. The subject deregisters
 * and we measure how long until the observer sees the peer go offline.
 *
 * Requires network access (connects to production conductor mesh).
 * The deregister message should trigger conductor_agent_reset on peers
 * within ~12s (vs 60-120s conductor_agent_expired without deregister).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConductorBridge } from "./conductor-bridge.js";

describe("deregister timing", () => {
  it("observer sees peer offline within 30s of deregister", async () => {
    const observerId = "cc-test-observer-" + Date.now().toString(36);
    const subjectId = "cc-test-subject-" + Date.now().toString(36);

    const observer = new ConductorBridge({
      agentId: observerId,
      label: "Observer",
    });

    const subject = new ConductorBridge({
      agentId: subjectId,
      label: "Subject",
    });

    try {
      // Connect both
      await observer.connect();
      await subject.connect();

      // Wait for both to be fully registered and see each other
      await new Promise<void>((resolve) => {
        const check = (): void => {
          const peers = observer.getPeers();
          if (Object.keys(peers).some((id) => id.startsWith("cc-test-subject-"))) {
            resolve();
          } else {
            setTimeout(check, 500);
          }
        };
        setTimeout(check, 1000);
      });

      // Subject deregisters — start timing
      const deregisterTime = Date.now();
      subject.close();

      // Wait for observer to see the peer go offline
      const offlineTime = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timeout: observer never saw peer go offline after 30s"));
        }, 30_000);

        observer.on("peer_offline", (peerId, reason) => {
          if (peerId.startsWith("cc-test-subject-")) {
            clearTimeout(timeout);
            // Deregister should trigger "reset", not "expired" (timeout)
            console.log(`Peer offline reason: ${reason}`);
            resolve(Date.now());
          }
        });
      });

      const gapMs = offlineTime - deregisterTime;
      const gapS = (gapMs / 1000).toFixed(1);

      // Log the measurement for CONDUCTOR-PROTOCOL.md
      console.log(`Deregister timing: ${gapS}s (${gapMs}ms)`);

      // The deregister path should be under 30s.
      // Office agents see ~12s for conductor_agent_reset.
      // We accept up to 30s to allow for mesh server variability.
      assert.ok(gapMs < 30_000, `Expected <30s, got ${gapS}s`);
    } finally {
      observer.close();
      // subject already closed
    }
  });
});
