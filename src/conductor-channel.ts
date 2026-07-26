/**
 * conductor-channel.ts — Join the Anthropic conductor mesh via CC Channels API.
 *
 * This is a CC Channel MCP server (research preview, CC v2.1.80+). CC spawns it
 * as a subprocess when started with:
 *   --dangerously-load-development-channels server:conductor-channel
 *
 * It wraps ConductorBridge (WebSocket logic) and speaks the MCP Channels protocol:
 *   - Incoming mesh messages → mcp.notification() → <channel> tag in CC context
 *   - Outbound: CC calls send_message / mesh_peers MCP tools
 *
 * Env vars:
 *   MESH_AGENT_ID  — explicit mesh identity override, e.g. cc-pm-aby-kikebu.
 *                    When unset, auto-derived: cc-{folder}-{first 8 of session UUID}.
 *                    The session UUID is read from CLAUDE_CODE_SESSION_ID (CC sets it at
 *                    MCP-spawn time) — race-free and stable across resume, so two sessions
 *                    in one cwd get distinct ids (fixes aby-pupaso). Falls back to a
 *                    most-recent-JSONL scan only if that env var is absent (older CC).
 *   MESH_ROLE      — aboyeur | pm | worker | user (affects interrupt semantics)
 *   MESH_DISABLED  — set to "1" to suppress mesh (for subagents inheriting MCP config)
 *
 * Status files written to /tmp/conductor-bridge/{agentId}/ for statusline.sh.
 *
 * Register in .mcp.json: { "mcpServers": { "conductor-channel": { "command": "bun", "args": ["src/conductor-channel.ts"] } } }
 * Then: claude --dangerously-load-development-channels server:conductor-channel
 * (bun runs the .ts directly — no build step; Phase 3/aby-bosuwa.)
 */

import { basename, join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, statSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ConductorBridge } from "./conductor-bridge.js";
import { meshAgentId } from "./mesh-id.js";
import { detectMeshCapability } from "./mesh-capability.js";

// Diagnostic: dump env + MCP init info
try {
  const claudeVars = Object.entries(process.env)
    .filter(([k]) => k.startsWith("CLAUDE") || k.startsWith("MCP") || k.startsWith("MESH") || k === "CLAUDECODE")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(`/tmp/conductor-channel-env-${process.pid}.txt`, claudeVars + "\n");
} catch { /* ignore */ }

if (process.env.MESH_DISABLED === "1") {
  // Explicit opt-out (e.g. subagent inheriting MCP config).
  process.exit(0);
}

/**
 * Derive this session's mesh identity: cc-{folder}-{first8 of session uuid}.
 * Preferred source is CLAUDE_CODE_SESSION_ID (race-free, resume-stable, distinct
 * per concurrent session); falls back to a most-recent-JSONL scan for older CC
 * (NOT collision-free — aby-pupaso), then bare cc-{folder}.
 */
function deriveAgentId(): string {
  const folder = basename(process.cwd());
  const base = `cc-${folder}`;

  // Preferred: CC passes the session's OWN uuid via CLAUDE_CODE_SESSION_ID at
  // MCP-spawn time (verified 2026-07-15, aby-pupaso). This is race-free — each
  // session has a distinct uuid — and stable across resume (same session = same
  // uuid), so two sessions in one cwd no longer collide as they did with the
  // JSONL-scan fallback below.
  const ownSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (ownSessionId) {
    const derived = meshAgentId(folder, ownSessionId);
    appendFileSync(`/tmp/conductor-channel-env-${process.pid}.txt`,
      `\n--- Agent ID ---\nDerived: ${derived} (from CLAUDE_CODE_SESSION_ID)\n`);
    return derived;
  }

  try {
    // Fallback (older CC without CLAUDE_CODE_SESSION_ID): most-recently-modified
    // JSONL in the project dir. NOT collision-free for two sessions in one cwd
    // (aby-pupaso) — retained only so nothing regresses when the env var is absent.
    const encodedPath = process.cwd().replace(/\//g, "-");
    const projectDir = join(homedir(), ".claude", "projects", encodedPath);

    const entries = readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (entries.length > 0) {
      const sessionId = entries[0].name.replace(/\.jsonl$/, "");
      const derived = meshAgentId(folder, sessionId);
      appendFileSync(`/tmp/conductor-channel-env-${process.pid}.txt`,
        `\n--- Agent ID ---\nDerived: ${derived} (from ${entries[0].name}, JSONL-scan fallback)\n`);
      return derived;
    }
  } catch { /* fall through to bare folder name */ }

  appendFileSync(`/tmp/conductor-channel-env-${process.pid}.txt`,
    `\n--- Agent ID ---\nFallback: ${base} (no session JSONL found)\n`);
  return base;
}

const agentId = process.env.MESH_AGENT_ID || deriveAgentId();
const role = process.env.MESH_ROLE ?? "user";

// Can this session actually surface inbound messages, or is it send-only?
// Consumed by the registration schema, mesh_peers and send-time warnings
// (aby-sahifi) and the statusline glyph (aby-kisemi). Daemon-spawned roles are
// channel-bound by construction via spawnAgent, so they are trusted as receivers.
const capability = role === "user"
  ? detectMeshCapability()
  : { canReceive: true, detail: `daemon-spawned role=${role}: channel-bound by construction` };

// --- Instructions injected into CC's system prompt ---
// Role-aware: workers queue and defer, aboyeur/pm respond promptly.
const INSTRUCTIONS_BY_ROLE: Record<string, string> = {
  worker:
    "You are connected to the Anthropic conductor mesh. Mesh messages arrive as " +
    '<channel source="conductor-channel"> tags with a "from" field. You are a worker mid-task — ' +
    "finish your current task first, then reply using the send_message tool. " +
    "Do not interrupt your work for mesh messages unless the message is from your PM and says STOP.",
  aboyeur:
    "You are connected to the Anthropic conductor mesh. Mesh messages arrive as " +
    '<channel source="conductor-channel"> tags with a "from" field. Respond promptly. ' +
    "Use send_message to reply, passing the 'from' value as the 'to' argument. " +
    "Use mesh_peers to see who is online before sending to a new peer.",
  pm:
    "You are connected to the Anthropic conductor mesh. Mesh messages arrive as " +
    '<channel source="conductor-channel"> tags with a "from" field. Respond promptly to ' +
    "worker verdicts and aboyeur messages. Use send_message to reply or route.",
  user:
    "You are connected to the Anthropic conductor mesh. Use mesh_peers to see " +
    "who is online and send_message to message a peer. Sending works from any " +
    "session; receiving does not: inbound messages arrive as " +
    '<channel source="conductor-channel"> tags with a "from" field ONLY in ' +
    "sessions launched with the channels flag " +
    "(--dangerously-load-development-channels). If this session was not, you " +
    "are send-only — replies cannot reach you, so do not wait on them; ask " +
    "the human to relay, or coordinate via files.",
};

const instructions = INSTRUCTIONS_BY_ROLE[role] ?? INSTRUCTIONS_BY_ROLE.user;

// --- MCP server setup ---

const mcp = new Server(
  { name: "conductor-channel", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions,
  },
);

// --- Tools: send_message + mesh_peers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send_message",
      description:
        "Send a message to a peer on the conductor mesh. Returns 'delivered' only if the " +
        "server accepted it (no rejection within ~200ms); returns 'NOT delivered' with the " +
        "reason if the peer is absent/gone (the mesh has no store-and-forward). 'delivered' " +
        "means the server accepted the send, not an end-to-end receipt.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Recipient agentId (from mesh_peers or channel tag 'from' field)" },
          message: { type: "string", description: "The message to send" },
        },
        required: ["to", "message"],
      },
    },
    {
      name: "mesh_peers",
      description: "List currently connected peers on the conductor mesh",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "send_message") {
    const { to, message } = req.params.arguments as { to: string; message: string };
    // Report delivery TRUTH, not a mint: the mesh rejects absent/ghost peers
    // synchronously (aby-nevejo), so race that error before answering (aby-nowabu).
    const res = await bridge.sendAndConfirm(to, message);
    if (res.ok) {
      return { content: [{ type: "text", text: `delivered to ${to} (server accepted — not an end-to-end receipt)` }] };
    }
    return { content: [{ type: "text", text: `NOT delivered to ${to}: ${res.error}` }], isError: true };
  }
  if (req.params.name === "mesh_peers") {
    const peers = bridge.getPeers();
    const lines = Object.entries(peers).map(
      ([id, info]) => `${id} — ${info.label} (${info.app})`,
    );
    const text = lines.length ? lines.join("\n") : "(no peers connected)";
    return { content: [{ type: "text", text }] };
  }
  return { content: [{ type: "text", text: `unknown tool: ${req.params.name}` }], isError: true };
});

// --- ConductorBridge wiring ---

const bridge = new ConductorBridge({
  agentId,
  label: `${agentId} (CC)`,
  logFile: `/tmp/conductor-bridge/${agentId}/bridge.log`,
  fileName: agentId,
});

// Publish the capability verdict beside the bridge's other status files, so
// statusline.sh and any other out-of-process consumer can read it without
// re-deriving the rules. Written once — capability is fixed at session birth.
try {
  writeFileSync(`/tmp/conductor-bridge/${agentId}/capability`,
    JSON.stringify({ canReceive: capability.canReceive, detail: capability.detail }) + "\n");
} catch { /* bridge dir not writable — non-fatal, detection still works in-process */ }

// Push a channel notification to CC, swallowing errors if stdin is already closing.
async function notify(content: string, meta: Record<string, unknown>) {
  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content, meta },
    });
  } catch { /* CC may have closed stdin — safe to ignore */ }
}

// Incoming mesh message → push as channel notification to CC.
// The bridge already deduplicates replays — we only see genuinely new messages.
//
// NOTE: The notification shape (method + params) is from the CC Channels reference.
// If CC doesn't surface these as <channel> tags, this is the first place to check.
// The Channels API is a research preview (CC v2.1.80+) — the shape may change.
bridge.on("message", async (from, message) => {
  await notify(message, { from });
});

// Roster churn (peer_online/peer_offline) deliberately does NOT surface as
// channel tags: presence is pull (mesh_peers), only messages push (aby-huciza,
// 2026-07-26 — a 33-session day put 9-17 join/leave tags in every listening
// session). The bridge still tracks the roster for mesh_peers and peers.json.

// On successful connection: push a peer summary (replay filtering).
// The bridge processes replayed events internally (building peers map) but
// does NOT emit "message" events for replayed conductor_messages (dedup catches them).
// So we just push a one-time summary after replay completes.
bridge.on("connected", async () => {
  const peers = bridge.getPeers();
  const count = Object.keys(peers).length;
  if (count > 0) {
    const lines = Object.entries(peers).map(
      ([id, info]) => `${id} — ${info.label}`,
    );
    await notify(`Mesh connected. ${count} peer(s) online:\n${lines.join("\n")}`, { event: "connected" });
  }
});

bridge.on("error", (err) => {
  console.error(`[conductor-channel] bridge error: ${err}`);
});

// --- Lifecycle ---

// Diagnostic: capture what the client declared at initialize (aby-masogo probe).
// Registered BEFORE connect so the callback can't miss the event — the old
// version read getClientCapabilities() right after mcp.connect(), which resolves
// on transport start, BEFORE the client's initialize arrives; every dump showed
// "undefined", which was the instrument's limit, not a finding.
mcp.oninitialized = () => {
  try {
    let cmdline = "(unreadable)";
    try {
      cmdline = readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\0").join(" ").trim();
    } catch { /* non-Linux or gone */ }
    appendFileSync(`/tmp/conductor-channel-env-${process.pid}.txt`,
      `\n--- MCP clientInfo (oninitialized) ---\n${JSON.stringify(mcp.getClientVersion(), null, 2)}\n` +
      `--- MCP clientCapabilities (oninitialized) ---\n${JSON.stringify(mcp.getClientCapabilities(), null, 2)}\n` +
      `--- parent cmdline (ppid ${process.ppid}) ---\n${cmdline}\n`);
  } catch { /* ignore */ }
};

await mcp.connect(new StdioServerTransport());

const HEALTH_CHECK_MS = 10_000;
let stdinClosed = false;
let healthCheck: ReturnType<typeof setInterval> | null = null;

// Clean shutdown: when CC exits it closes our stdin (EOF) → deregister + close WS.
// Registered HERE — right after mcp.connect() (stdin is now flowing, read by the
// StdioServerTransport) and BEFORE the network-bound bridge.connect() below — so an
// EOF arriving during connect is not missed. Attaching it after bridge.connect (as
// it was) lost that race and leaked a hung process holding a mesh connection when CC
// spawned the channel then disconnected quickly (early-EOF hang, reproduced under
// BOTH bun and node — node's faster startup merely masked it; aby-pizufo 2026-07-15).
const shutdown = () => {
  if (stdinClosed) return;
  stdinClosed = true;
  if (healthCheck) clearInterval(healthCheck);
  bridge.close();
  process.exit(0);
};
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
// Guard the already-ended case: an EOF that landed before the listeners above
// (stdin closed at spawn — CC never really connected) fires no future event.
if (process.stdin.readableEnded) shutdown();

await bridge.connect();

// --- Bridge health recovery ---
// The bridge yields permanently on supersession (prevents flap loops between
// dual-path processes). But CC sometimes restarts the MCP server mid-session:
// the new process supersedes us, then CC kills the new process. We're the
// survivor with a dead bridge.
//
// Recovery: poll bridge health. If it's closed but our stdin is still open,
// we're the process CC kept — reconnect. (Skipped if stdin already closed above.)
if (!stdinClosed) {
  healthCheck = setInterval(() => {
    // Stop polling once stdin closed OR we've yielded permanently to a live
    // same-id sibling (aby-suwawo) — otherwise we'd re-call reconnect() every
    // 10s and just log "declined" forever. A genuine survivor never yields, so
    // its health check keeps running (aby-tarafo revive preserved).
    if (stdinClosed || bridge.isPermanentlyYielded) {
      if (healthCheck) clearInterval(healthCheck);
      return;
    }
    if (bridge.isClosed) {
      bridge.reconnect().catch(() => {});
    }
  }, HEALTH_CHECK_MS);
}
