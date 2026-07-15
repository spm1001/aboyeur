/**
 * send-confirm.test.ts — sendAndConfirm reports delivery TRUTH (aby-nowabu).
 *
 * The mesh has NO store-and-forward: a send to an absent/ghost peer is rejected
 * synchronously with conductor_error "Agent not found" (aby-nevejo). Before this,
 * bridge.send() returned void and the MCP tool minted "sent to <peer>"
 * unconditionally — actively contradicting an error the client already had.
 *
 * sendAndConfirm races a bounded window against that error:
 *   - to a LIVE peer  -> { ok: true }                    (server accepted)
 *   - to a GHOST id   -> { ok: false, error ~ /not found/ }
 *
 * Live test — connects to bridge.claudeusercontent.com, same as the supersede
 * test. Two bridges give a deterministic live recipient (positive control first).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { ConductorBridge } from "./conductor-bridge.js";

const NONCE = Date.now().toString(36);
const A_ID = `cc-test-sendconfirm-a-${NONCE}`;
const B_ID = `cc-test-sendconfirm-b-${NONCE}`;

describe("sendAndConfirm delivery truth (aby-nowabu)", () => {
  const bridges: ConductorBridge[] = [];
  after(() => {
    for (const b of bridges) {
      try { b.close(); } catch { /* ignore */ }
    }
  });

  it("delivers to a live peer; reports NOT delivered to a ghost", async () => {
    const a = new ConductorBridge({ agentId: A_ID, label: "A", bridgeDir: `/tmp/conductor-bridge/${A_ID}` });
    const b = new ConductorBridge({ agentId: B_ID, label: "B", bridgeDir: `/tmp/conductor-bridge/${B_ID}` });
    bridges.push(a, b);

    const aUp = new Promise<void>((r) => a.on("connected", () => r()));
    const bUp = new Promise<void>((r) => b.on("connected", () => r()));
    await a.connect();
    await b.connect();
    await Promise.all([aUp, bUp]);
    // Let the server register both before we send.
    await new Promise((r) => setTimeout(r, 800));

    // POSITIVE CONTROL first: A -> B (live) must be accepted (no conductor_error).
    const live = await a.sendAndConfirm(B_ID, `hello-${NONCE}`);
    assert.equal(live.ok, true, `expected delivered to live peer, got ${JSON.stringify(live)}`);

    // GHOST: A -> never-registered id must be rejected with "Agent not found".
    const ghost = await a.sendAndConfirm(`cc-ghost-${NONCE}`, "anyone there?");
    assert.equal(ghost.ok, false, `expected NOT delivered to ghost, got ${JSON.stringify(ghost)}`);
    assert.match(String(ghost.error), /not found/i, `expected an 'Agent not found' error, got: ${ghost.error}`);
  });

  it("reports NOT delivered when the bridge is not connected", async () => {
    const c = new ConductorBridge({ agentId: `cc-test-sendconfirm-c-${NONCE}`, label: "C", bridgeDir: `/tmp/conductor-bridge/cc-test-sendconfirm-c-${NONCE}` });
    bridges.push(c);
    // Never call connect() — ws is null.
    const res = await c.sendAndConfirm(B_ID, "into the void");
    assert.equal(res.ok, false);
    assert.match(String(res.error), /not connected/i);
  });
});
