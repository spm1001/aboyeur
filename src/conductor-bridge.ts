/**
 * conductor-bridge.ts — Connect a CC agent to Anthropic's conductor mesh.
 *
 * Maintains a persistent WebSocket connection to bridge.claudeusercontent.com.
 * Uses Node.js `ws` library — MUST be Node, not Python. The conductor mesh
 * server rejects Python WebSocket clients with "Stale connection (no pong)"
 * after 60 seconds. Node.js `ws` works perfectly (proven 15 Mar 2026).
 *
 * File-based IPC (same protocol as the Python bridge it replaces):
 *   {bridgeDir}/inbox.jsonl   — incoming messages (append-only)
 *   {bridgeDir}/outbox.jsonl  — write a line to send a message
 *   {bridgeDir}/peers.json    — snapshot of connected agents
 *   {bridgeDir}/status        — "connected" | "disconnected" | "reconnecting"
 *   {bridgeDir}/bridge.log    — activity log
 *
 * Standalone usage:
 *   npx tsx src/conductor-bridge.ts <agent_id> <label> [<color>]
 *
 * Programmatic usage:
 *   import { ConductorBridge } from "./conductor-bridge.js";
 *   const bridge = new ConductorBridge({ agentId: "cc-aboyeur", label: "Aboyeur" });
 *   await bridge.connect();
 *   bridge.send("cc-passe", "Hello from aboyeur");
 *   bridge.on("message", (from, message) => console.log(from, message));
 *   bridge.close();
 */

import WebSocket from "ws";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";

// --- Types ---

export interface PeerInfo {
  label: string;
  app: string;
  color: string;
}

export interface InboxMessage {
  ts: number;
  from: string;
  message: string;
}

export interface BridgeOptions {
  agentId: string;
  label: string;
  color?: string;
  bridgeDir?: string;
  /** Log to file instead of stdout. */
  logFile?: string;
}

interface BridgeEvents {
  message: [from: string, message: string];
  peer_online: [agentId: string, info: PeerInfo];
  peer_offline: [agentId: string];
  connected: [];
  disconnected: [];
  error: [error: string];
}

// --- Constants ---

const CREDS_PATH = join(homedir(), ".claude", ".credentials.json");
const DEFAULT_BRIDGE_DIR = "/tmp/conductor-bridge";
const PING_INTERVAL_MS = 25_000;
const OUTBOX_POLL_MS = 500;
const RECONNECT_DELAY_MS = 1_000;

// --- ConductorBridge ---

export class ConductorBridge extends EventEmitter<BridgeEvents> {
  private readonly agentId: string;
  private readonly label: string;
  private readonly color: string;
  private readonly bridgeDir: string;
  private readonly logFile: string | null;

  private ws: WebSocket | null = null;
  private closed = false;
  private peers: Record<string, PeerInfo> = {};
  private seenMessages = new Set<string>();
  private outboxCursor = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private outboxTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: BridgeOptions) {
    super();
    this.agentId = opts.agentId;
    this.label = opts.label;
    this.color = opts.color ?? "#7719AA";
    this.bridgeDir = opts.bridgeDir ?? join(DEFAULT_BRIDGE_DIR, opts.agentId);
    this.logFile = opts.logFile ?? null;

    // Ensure bridge directory exists
    mkdirSync(this.bridgeDir, { recursive: true });

    // Touch inbox
    const inboxPath = join(this.bridgeDir, "inbox.jsonl");
    if (!existsSync(inboxPath)) writeFileSync(inboxPath, "");

    // Touch outbox and set cursor to end (skip pre-existing)
    const outboxPath = join(this.bridgeDir, "outbox.jsonl");
    if (!existsSync(outboxPath)) writeFileSync(outboxPath, "");
    this.outboxCursor = statSync(outboxPath).size;

    this.writeStatus("disconnected");
  }

  // --- Public API ---

  async connect(): Promise<void> {
    if (this.closed) return;
    const { token, wsUrl } = await this.resolveAuth();
    this.log("Connecting to conductor mesh...");
    this.attemptConnect(token, wsUrl);
  }

  send(to: string, message: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log(`Cannot send — not connected`);
      return;
    }
    const wireMsg = {
      type: "conductor_send_message",
      to,
      message,
      _agent_id: this.agentId,
    };
    this.ws.send(JSON.stringify(wireMsg));
    this.log(`SENT to ${to}: ${message.slice(0, 100)}`);
  }

  getPeers(): Record<string, PeerInfo> {
    return { ...this.peers };
  }

  close(): void {
    this.closed = true;
    this.stopTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.writeStatus("disconnected");
    this.log("Closed");
  }

  // --- Private: connection lifecycle ---

  private async resolveAuth(): Promise<{ token: string; wsUrl: string }> {
    const creds = JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
    const token: string = creds.claudeAiOauth.accessToken;

    const resp = await fetch("https://api.anthropic.com/api/oauth/profile", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const profile = (await resp.json()) as { account: { uuid: string } };
    const uuid = profile.account.uuid;

    this.log(`Profile: ${uuid.slice(0, 8)}...`);
    return {
      token,
      wsUrl: `wss://bridge.claudeusercontent.com/v2/conductor/${uuid}`,
    };
  }

  private attemptConnect(token: string, wsUrl: string): void {
    if (this.closed) return;

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      // Register
      const reg = {
        type: "register",
        agentId: this.agentId,
        schema: {
          instructions: `I am ${this.label}, a Claude Code agent. Send me a task or message and I will respond.`,
          appName: "claude-code",
          version: "2",
          interface: "Claude Code",
          capabilities: {
            receive_message: {},
            file_sharing: { accept: ["json", "txt", "md", "ts", "js", "py"] },
          },
          display: { label: this.label, color: this.color },
        },
        oauth_token: token,
      };
      ws.send(JSON.stringify(reg));
      this.log("Registration sent");

      // Start ping and outbox timers
      this.startTimers(ws);
    });

    ws.on("message", (data: WebSocket.Data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.handleMessage(msg);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      const reasonStr = reason.toString();
      this.log(`WS closed: code=${code} reason='${reasonStr}'`);
      this.stopTimers();
      this.writeStatus("disconnected");
      this.emit("disconnected");

      if (!this.closed) {
        this.writeStatus("reconnecting");
        setTimeout(() => this.attemptConnect(token, wsUrl), RECONNECT_DELAY_MS);
      }
    });

    ws.on("error", (err: Error) => {
      this.log(`WS error: ${err.message}`);
    });
  }

  private handleMessage(data: any): void {
    const msgType: string = data.type ?? "";

    switch (msgType) {
      case "conductor_connected":
        this.writeStatus("connected");
        this.log(`Connected! Protocol v${data.protocol_version}`);
        this.emit("connected");
        break;

      case "conductor_replay_complete":
        this.log(`Replay complete (${data.events_replayed ?? 0} events)`);
        break;

      case "conductor_event": {
        const evt: string = data.event_type ?? "";
        const peerId: string = data.agent_id ?? "";
        const payload = data.payload ?? {};
        const replay: boolean = data.replay ?? false;

        if (evt === "connect") {
          this.peers[peerId] = {
            label: payload.display?.label ?? peerId,
            app: payload.appName ?? "?",
            color: payload.display?.color ?? "",
          };
          this.writePeers();
          if (!replay) this.log(`Peer joined: ${peerId}`);
        } else if (evt === "disconnect") {
          delete this.peers[peerId];
          this.writePeers();
          if (!replay) this.log(`Peer left: ${peerId}`);
        } else if (evt === "status" && peerId in this.peers) {
          (this.peers[peerId] as any).file = payload.fileName ?? "";
          this.writePeers();
        }
        break;
      }

      case "conductor_agent_online": {
        const peerId: string = data.agentId ?? "";
        const schema = data.schema ?? {};
        this.peers[peerId] = {
          label: schema.display?.label ?? peerId,
          app: schema.appName ?? "?",
          color: schema.display?.color ?? "",
        };
        this.writePeers();
        this.log(`Peer online: ${peerId} (${this.peers[peerId].label})`);
        this.emit("peer_online", peerId, this.peers[peerId]);
        break;
      }

      case "conductor_agent_offline": {
        const peerId: string = data.agentId ?? "";
        delete this.peers[peerId];
        this.writePeers();
        this.log(`Peer offline: ${peerId}`);
        this.emit("peer_offline", peerId);
        break;
      }

      case "conductor_message": {
        const fromId: string = data.from ?? "?";
        const message: string = data.message ?? "";
        const msgKey = `${fromId}:${message}`;
        if (this.seenMessages.has(msgKey)) break;
        this.seenMessages.add(msgKey);

        const entry: InboxMessage = { ts: Date.now() / 1000, from: fromId, message };
        appendFileSync(join(this.bridgeDir, "inbox.jsonl"), JSON.stringify(entry) + "\n");
        this.log(`MSG from ${fromId}: ${message.slice(0, 120)}`);
        this.emit("message", fromId, message);
        break;
      }

      case "pong":
        this.log("PONG received");
        break;

      case "conductor_error":
        this.log(`ERROR: ${data.error ?? JSON.stringify(data)}`);
        this.emit("error", data.error ?? "unknown error");
        break;

      default:
        this.log(`[${msgType}] ${JSON.stringify(data).slice(0, 200)}`);
        break;
    }
  }

  // --- Private: timers ---

  private startTimers(ws: WebSocket): void {
    this.stopTimers();

    // JSON ping every 25s (no _agent_id — Node.js ws library doesn't need it)
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
        this.log("PING sent");
      }
    }, PING_INTERVAL_MS);

    // Poll outbox every 500ms
    this.outboxTimer = setInterval(() => {
      this.pollOutbox(ws);
    }, OUTBOX_POLL_MS);
  }

  private stopTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }
  }

  // --- Private: outbox ---

  private pollOutbox(ws: WebSocket): void {
    const outboxPath = join(this.bridgeDir, "outbox.jsonl");
    try {
      const size = statSync(outboxPath).size;
      if (size <= this.outboxCursor) return;

      const content = readFileSync(outboxPath, "utf-8");
      const newContent = content.slice(this.outboxCursor);
      this.outboxCursor = content.length;

      for (const line of newContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (ws.readyState === WebSocket.OPEN) {
            const wireMsg = {
              type: "conductor_send_message",
              to: msg.to,
              message: msg.message,
              _agent_id: this.agentId,
            };
            ws.send(JSON.stringify(wireMsg));
            this.log(`SENT to ${msg.to}: ${(msg.message as string).slice(0, 100)}`);
          } else {
            this.log(`QUEUED (not connected): ${msg.to}`);
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // file not found etc
    }
  }

  // --- Private: file I/O ---

  private writeStatus(status: string): void {
    writeFileSync(join(this.bridgeDir, "status"), status);
  }

  private writePeers(): void {
    writeFileSync(join(this.bridgeDir, "peers.json"), JSON.stringify(this.peers, null, 2));
  }

  private log(msg: string): void {
    const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const line = `[${ts}] [${this.agentId}] ${msg}`;
    if (this.logFile) {
      appendFileSync(this.logFile, line + "\n");
    } else {
      console.log(line);
    }
  }
}

// --- CLI entry point ---

if (process.argv[1]?.endsWith("conductor-bridge.ts") || process.argv[1]?.endsWith("conductor-bridge.js")) {
  const agentId = process.argv[2];
  const label = process.argv[3];
  const color = process.argv[4] ?? "#7719AA";

  if (!agentId || !label) {
    console.error(`Usage: ${process.argv[1]} <agent_id> <label> [<color>]`);
    console.error(`  agent_id: unique identifier (e.g. cc-aboyeur)`);
    console.error(`  label: display name (e.g. 'Aboyeur (CC)')`);
    console.error(`  color: hex color (default: #7719AA)`);
    process.exit(1);
  }

  const bridge = new ConductorBridge({ agentId, label, color });
  bridge.connect().catch((err) => {
    console.error(`Failed to connect: ${err}`);
    process.exit(1);
  });

  process.on("SIGINT", () => {
    bridge.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    bridge.close();
    process.exit(0);
  });
}
