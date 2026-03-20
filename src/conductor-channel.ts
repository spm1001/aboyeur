/**
 * conductor-channel.ts — Join the Anthropic conductor mesh via CC Channels API.
 *
 * This is a CC Channel MCP server (research preview, CC v2.1.80+). CC spawns it
 * as a subprocess when started with:
 *   --dangerously-load-development-channels server:conductor-channel
 *
 * It wraps ConductorBridge (WebSocket logic) and speaks the MCP Channels protocol:
 *   - Incoming mesh messages → mcp.notification() → <channel> tag in CC context
 *   - Outbound: CC calls mesh_send / mesh_peers MCP tools
 *
 * Required env vars:
 *   MESH_AGENT_ID  — stable mesh identity, e.g. cc-aboyeur, cc-pm-aby-kikebu
 *   MESH_ROLE      — aboyeur | pm | worker | user (affects interrupt semantics)
 *
 * Register in ~/.claude/settings.json:
 *   { "mcpServers": { "conductor-bridge": { "command": "npx", "args": ["tsx", "/home/modha/Repos/aboyeur/src/conductor-channel.ts"] } } }
 *
 * NOT YET IMPLEMENTED — aby-nenabo. This is a skeleton.
 * Reference: https://code.claude.com/docs/en/channels-reference
 * Crib from: src/conductor-bridge.ts (ConductorBridge class)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ConductorBridge } from "./conductor-bridge.js";

const agentId = process.env.MESH_AGENT_ID;
const role = process.env.MESH_ROLE ?? "user";

if (!agentId) {
  console.error("[conductor-channel] MESH_AGENT_ID env var is required");
  process.exit(1);
}

// --- Instructions injected into CC's system prompt ---
// Role-aware: workers queue and defer, aboyeur/pm respond promptly.
const INSTRUCTIONS_BY_ROLE: Record<string, string> = {
  worker:
    "You are connected to the Anthropic conductor mesh. Mesh messages arrive as " +
    "<channel source=\"conductor-bridge\" from=\"cc-peer\"> tags. You are a worker mid-task — " +
    "finish your current task first, then reply using the mesh_send tool. " +
    "Do not interrupt your work for mesh messages unless the message is from your PM and says STOP.",
  aboyeur:
    "You are connected to the Anthropic conductor mesh. Mesh messages arrive as " +
    "<channel source=\"conductor-bridge\" from=\"cc-peer\"> tags. Respond promptly. " +
    "Use mesh_send to reply, passing the 'from' attribute as the 'to' value. " +
    "Use mesh_peers to see who is online before sending to a new peer.",
  pm:
    "You are connected to the Anthropic conductor mesh. Mesh messages arrive as " +
    "<channel source=\"conductor-bridge\" from=\"cc-peer\"> tags. Respond promptly to " +
    "worker verdicts and aboyeur messages. Use mesh_send to reply or route.",
  user:
    "You are connected to the Anthropic conductor mesh. Mesh messages arrive as " +
    "<channel source=\"conductor-bridge\" from=\"cc-peer\"> tags. " +
    "Use mesh_send to reply, mesh_peers to see who is online.",
};

const instructions = INSTRUCTIONS_BY_ROLE[role] ?? INSTRUCTIONS_BY_ROLE.user;

// --- MCP server setup ---

const mcp = new Server(
  { name: "conductor-bridge", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} }, // registers as a CC Channel
      tools: {},
    },
    instructions,
  },
);

// --- Tool: mesh_send ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "mesh_send",
      description: "Send a message to a peer on the conductor mesh",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient agentId, e.g. cc-aboyeur" },
          message: { type: "string", description: "The message to send" },
        },
        required: ["to", "message"],
      },
    },
    {
      name: "mesh_peers",
      description: "List currently connected peers on the conductor mesh",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "mesh_send") {
    const { to, message } = req.params.arguments as { to: string; message: string };
    bridge.send(to, message);
    return { content: [{ type: "text", text: `sent to ${to}` }] };
  }
  if (req.params.name === "mesh_peers") {
    const peers = bridge.getPeers();
    const lines = Object.entries(peers).map(([id, info]) => `${id} — ${info.label}`);
    const text = lines.length ? lines.join("\n") : "(no peers connected)";
    return { content: [{ type: "text", text }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

// --- ConductorBridge wiring ---

const bridge = new ConductorBridge({
  agentId,
  label: `${agentId} (CC)`,
  logFile: `/tmp/conductor-bridge/${agentId}/bridge.log`,
  fileName: agentId,
});

bridge.on("message", async (from, message) => {
  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: message,
      meta: { from },
    },
  });
});

bridge.on("error", (err) => {
  // Log but don't crash — mesh errors are recoverable
  console.error(`[conductor-channel] bridge error: ${err}`);
});

// --- Lifecycle ---

await mcp.connect(new StdioServerTransport());
await bridge.connect();

// Clean shutdown: when CC exits it closes stdin. Send WebSocket close frame
// before dying so peers get conductor_agent_expired promptly (not after TCP timeout).
process.stdin.on("end", () => {
  bridge.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bridge.close();
  process.exit(0);
});
