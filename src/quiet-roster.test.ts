/**
 * quiet-roster.test.ts — roster churn is quiet; only messages ring (aby-huciza).
 *
 * Decision 2026-07-26: presence is pull (mesh_peers), messages are push. A
 * 33-session churn day put 9-17 "Peer online" tags in every listening session,
 * so the channel server no longer surfaces peer_online/peer_offline as channel
 * notifications, and the bridge only emits peer_online on an absent→present
 * transition (a re-register — double-server birth, heartbeat re-fire — updates
 * the roster silently; retires aby-paluvu's mechanism).
 *
 * Two layers:
 *  1. Offline: ConductorBridge dedup — synthetic events through handleMessage,
 *     no network.
 *  2. Live: the real channel server process, driven over MCP stdio while a
 *     helper bridge churns and messages it. The message notification is the
 *     positive control — it proves the notification path works, so zero roster
 *     notifications is a finding, not a dead instrument.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { ConductorBridge } from "./conductor-bridge.js";

const NONCE = Date.now().toString(36);
const CHANNEL_SCRIPT = join(import.meta.dirname, "conductor-channel.ts");

describe("bridge roster dedup (offline)", () => {
  it("emits peer_online once per absent→present transition, never for re-announcements", () => {
    const id = `cc-test-dedup-${NONCE}`;
    const bridge = new ConductorBridge({ agentId: id, label: "dedup", bridgeDir: `/tmp/conductor-bridge/${id}` });
    const online: string[] = [];
    const offline: string[] = [];
    bridge.on("peer_online", (peerId) => online.push(peerId));
    bridge.on("peer_offline", (peerId) => offline.push(peerId));
    // Private method, deliberately: the dispatch seam is where dedup lives.
    const feed = (evt: unknown) => (bridge as unknown as { handleMessage(d: unknown): void }).handleMessage(evt);

    // First announcement: emit. Re-register (same peer, agent_online again): silent.
    feed({ type: "conductor_agent_online", agentId: "peer-P", schema: {} });
    feed({ type: "conductor_agent_online", agentId: "peer-P", schema: {} });
    // Live conductor_event connect for the already-known peer: still silent.
    feed({ type: "conductor_event", event_type: "connect", agent_id: "peer-P", payload: {}, replay: false });
    assert.deepEqual(online, ["peer-P"], "one emit for three announcements of one peer");

    // Replayed connect for a NEW peer: roster updated, no emit (pre-existing behaviour).
    feed({ type: "conductor_event", event_type: "connect", agent_id: "peer-R", payload: {}, replay: true });
    assert.deepEqual(online, ["peer-P"], "replay never emits");

    // Offline for a known peer: emit once; repeat: silent (already gone).
    feed({ type: "conductor_agent_expired", agentId: "peer-P" });
    feed({ type: "conductor_agent_expired", agentId: "peer-P" });
    // Offline for a never-known peer: silent.
    feed({ type: "conductor_agent_reset", agentId: "peer-Q" });
    feed({ type: "conductor_event", event_type: "disconnect", agent_id: "peer-Q", payload: {}, replay: false });
    assert.deepEqual(offline, ["peer-P"], "offline emits only for known peers, once each");

    bridge.close();
  });
});

describe("channel server quiet roster (live)", () => {
  const SERVER_ID = `cc-test-quiet-server-${NONCE}`;
  const PEER_ID = `cc-test-quiet-peer-${NONCE}`;
  const MESSAGE = `quiet-roster-probe-${NONCE}`;
  let server: ChildProcess | undefined;
  let helper: ConductorBridge | undefined;
  after(() => {
    try { helper?.close(); } catch { /* ignore */ }
    try { server?.stdin?.end(); } catch { /* ignore */ }
    try { server?.kill("SIGTERM"); } catch { /* ignore */ }
  });

  // ~9s of deliberate waits — bun's 5s default timeout kills it otherwise.
  it("peer churn produces no channel notifications; a message rings through", { timeout: 30_000 }, async () => {
    server = spawn("bun", [CHANNEL_SCRIPT], {
      env: { ...process.env, MESH_AGENT_ID: SERVER_ID, MESH_ROLE: "user" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const notifications: Array<{ content: string; meta?: Record<string, unknown> }> = [];
    let buf = "";
    server.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.method === "notifications/claude/channel") notifications.push(msg.params);
        } catch { /* non-JSON noise */ }
      }
    });

    // Minimal MCP handshake so notifications flow like they do under CC.
    server.stdin?.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "quiet-roster-test", version: "0" } },
    }) + "\n");
    server.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    // Let the server's bridge register on the mesh.
    await new Promise((r) => setTimeout(r, 3000));

    // Churn: a fresh peer joins (absent→present at the server — the loud case pre-fix)...
    helper = new ConductorBridge({ agentId: PEER_ID, label: "quiet-helper", bridgeDir: `/tmp/conductor-bridge/${PEER_ID}` });
    const up = new Promise<void>((r) => helper!.on("connected", () => r()));
    await helper.connect();
    await up;
    await new Promise((r) => setTimeout(r, 1500));

    // ...messages it (positive control)...
    const sent = await helper.sendAndConfirm(SERVER_ID, MESSAGE);
    assert.equal(sent.ok, true, `positive-control send failed: ${JSON.stringify(sent)}`);
    await new Promise((r) => setTimeout(r, 1500));

    // ...and leaves (more churn).
    helper.close();
    await new Promise((r) => setTimeout(r, 1500));

    const roster = notifications.filter(
      (n) => n.content.startsWith("Peer online:") || n.content.startsWith("Peer offline:"),
    );
    const rung = notifications.filter((n) => n.content === MESSAGE);
    // The birth summary ("Mesh connected. N peer(s) online") is allowed — the
    // live estate may have real peers at connect time.
    assert.equal(rung.length, 1, `expected exactly one message notification, got ${JSON.stringify(notifications)}`);
    assert.deepEqual(roster, [], `roster churn surfaced as notifications: ${JSON.stringify(roster)}`);
  });
});
