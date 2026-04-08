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
 *                    When unset, auto-derived from CC session: cc-{folder}-{first 8 of session UUID}.
 *                    The session UUID comes from the most recent JSONL in ~/.claude/projects/{path}/.
 *                    This is stable across resume (same JSONL) and unique per concurrent session.
 *   MESH_ROLE      — aboyeur | pm | worker | user (affects interrupt semantics)
 *   MESH_DISABLED  — set to "1" to suppress mesh (for subagents inheriting MCP config)
 *
 * Status files written to /tmp/conductor-bridge/{agentId}/ for statusline.sh.
 *
 * Register in .mcp.json: { "mcpServers": { "conductor-channel": { "command": "node", "args": ["dist/conductor-channel.js"] } } }
 * Then: claude --dangerously-load-development-channels server:conductor-channel
 */

import { basename, join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ConductorBridge } from "./conductor-bridge.js";

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
 * Derive a stable, unique mesh identity from the CC session's JSONL file.
 *
 * CC writes session data to ~/.claude/projects/{encoded-path}/{session-uuid}.jsonl.
 * The encoded path is the CWD with '/' replaced by '-'. The session UUID is stable
 * across resume and unique per concurrent session.
 *
 * Returns cc-{folder}-{first8} when a session JSONL is found, cc-{folder} as fallback.
 */
function deriveAgentId(): string {
  const folder = basename(process.cwd());
  const base = `cc-${folder}`;

  try {
    const encodedPath = process.cwd().replace(/\//g, "-");
    const projectDir = join(homedir(), ".claude", "projects", encodedPath);

    // Find the most recently modified JSONL — that's our session.
    // Race: two concurrent sessions may each pick the other's JSONL. The identities
    // are still unique (different UUIDs), just potentially swapped. Cosmetic, not functional.
    const entries = readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (entries.length > 0) {
      const sessionId = entries[0].name.replace(/\.jsonl$/, "");
      const short = sessionId.slice(0, 8);
      const derived = `${base}-${short}`;
      appendFileSync(`/tmp/conductor-channel-env-${process.pid}.txt`,
        `\n--- Agent ID ---\nDerived: ${derived} (from ${entries[0].name})\n`);
      return derived;
    }
  } catch { /* fall through to bare folder name */ }

  appendFileSync(`/tmp/conductor-channel-env-${process.pid}.txt`,
    `\n--- Agent ID ---\nFallback: ${base} (no session JSONL found)\n`);
  return base;
}

const agentId = process.env.MESH_AGENT_ID || deriveAgentId();
const role = process.env.MESH_ROLE ?? "user";

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
    "You are connected to the Anthropic conductor mesh. Mesh messages arrive as " +
    '<channel source="conductor-channel"> tags with a "from" field. ' +
    "Use send_message to reply, mesh_peers to see who is online.",
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
      description: "Send a message to a peer on the conductor mesh",
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
    bridge.send(to, message);
    return { content: [{ type: "text", text: `sent to ${to}` }] };
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

// Peer joins/leaves → push as channel notification so CC sees mesh changes.
bridge.on("peer_online", async (peerId, info) => {
  await notify(`Peer online: ${peerId} (${info.label}, ${info.app})`, { event: "peer_online", peerId });
});

bridge.on("peer_offline", async (peerId, reason) => {
  await notify(`Peer offline: ${peerId} (${reason})`, { event: "peer_offline", peerId, reason });
});

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

await mcp.connect(new StdioServerTransport());

// Diagnostic: capture MCP client info (looking for session ID)
try {
  const clientVersion = mcp.getClientVersion();
  const clientCaps = mcp.getClientCapabilities();
  appendFileSync(`/tmp/conductor-channel-env-${process.pid}.txt`,
    `\n--- MCP clientInfo ---\n${JSON.stringify(clientVersion, null, 2)}\n` +
    `\n--- MCP clientCapabilities ---\n${JSON.stringify(clientCaps, null, 2)}\n`);
} catch { /* ignore */ }

await bridge.connect();

// --- Bridge health recovery ---
// The bridge yields permanently on supersession (prevents flap loops between
// dual-path processes). But CC sometimes restarts the MCP server mid-session:
// the new process supersedes us, then CC kills the new process. We're the
// survivor with a dead bridge.
//
// Recovery: poll bridge health. If it's closed but our stdin is still open,
// we're the process CC kept — reconnect.
const HEALTH_CHECK_MS = 10_000;
let stdinClosed = false;

const healthCheck = setInterval(() => {
  if (stdinClosed) {
    clearInterval(healthCheck);
    return;
  }
  if (bridge.isClosed) {
    bridge.reconnect().catch(() => {});
  }
}, HEALTH_CHECK_MS);

// Clean shutdown: when CC exits it closes stdin → deregister + close WebSocket.
process.stdin.on("end", () => {
  stdinClosed = true;
  clearInterval(healthCheck);
  bridge.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  clearInterval(healthCheck);
  bridge.close();
  process.exit(0);
});
