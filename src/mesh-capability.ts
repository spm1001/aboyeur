/**
 * mesh-capability.ts — can THIS session surface inbound mesh messages? (aby-masogo)
 *
 * Sending and peer discovery work from any session that loads the channel server.
 * RECEIVING does not: CC only turns transport arrivals into <channel> tags for a
 * session launched with the channels flag, on Teams billing, interactive, fresh.
 * Every other shape is send-only — and until now indistinguishable, which is how
 * two handoff messages were lost on 2026-07-26 to a peer that looked reachable.
 *
 * Measured 2026-07-26 (aby-masogo), four headless/interactive probes:
 *   - getClientCapabilities() does NOT discriminate. Once read from oninitialized
 *     (not right after connect(), where it is still undefined — that universal
 *     undefined was the instrument's limit, not an answer) it returns the SAME
 *     {elicitation, roots} for plain, flagged-Vertex and flagged-Teams sessions.
 *     Clean negative with a working instrument; don't re-probe it.
 *   - The parent's argv DOES carry the flag, and CLAUDE_CODE_ENTRYPOINT
 *     distinguishes interactive ("cli") from headless ("sdk-cli") and Desktop
 *     ("claude-desktop"). Those, plus CLAUDE_CODE_USE_VERTEX, are the signals.
 *
 * Consumers: registration schema + mesh_peers + send-time warnings (aby-sahifi),
 * and the statusline glyph (aby-kisemi). statusline.sh mirrors this logic in bash,
 * the same lockstep arrangement as mesh-id.ts.
 */

import { readFileSync } from "node:fs";

export const CHANNELS_FLAG = "--dangerously-load-development-channels";

/** Why a session cannot receive — ordered by how early the gate bites. */
export type SendOnlyReason =
  | "vertex"      // third-party provider: CC refuses to bind channels at all
  | "headless"    // -p / SDK: inbound never surfaces, flag or no flag
  | "no-flag"     // launched without the channels flag (or a non-allowlisted plugin ref)
  | "resumed";    // -c/--resume: transport survives, tag-surfacing does not (aby-wodagu)

export interface MeshCapability {
  /** True only when inbound messages will actually surface as <channel> tags. */
  canReceive: boolean;
  /** Absent when canReceive; otherwise the first gate that bit. */
  reason?: SendOnlyReason;
  /** Human-readable, for logs, statusline tooltips and peer warnings. */
  detail: string;
}

/** Parent process argv as discrete elements (Linux /proc). Empty when unreadable. */
function parentArgv(ppid: number): string[] {
  try {
    return readFileSync(`/proc/${ppid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Detect whether this session can surface inbound mesh messages.
 *
 * Deliberately conservative: every unknown resolves to send-only. Over-claiming
 * receive is the failure that loses messages silently; under-claiming only costs
 * a peer an unnecessary "coordinate via files" note.
 *
 * @param env    process env (injectable for tests)
 * @param argv   parent argv (injectable for tests; read from /proc by default)
 */
export function detectMeshCapability(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = parentArgv(process.ppid),
): MeshCapability {
  // Vertex/Bedrock/Foundry: "Channels are not available on third-party providers"
  // — CC declines to bind them however the session was launched (aby-pafada).
  if (env.CLAUDE_CODE_USE_VERTEX === "1" || env.CLAUDE_CODE_USE_BEDROCK === "1") {
    return { canReceive: false, reason: "vertex", detail: "third-party provider: CC does not bind channels" };
  }

  // Headless (-p / SDK). Entrypoint is the reliable signal — argv is the backstop
  // for launchers that set neither. Interactive is "cli"; Desktop is its own case
  // and has never been measured surfacing tags, so it stays send-only.
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT ?? "";
  const headlessArgv = argv.includes("-p") || argv.includes("--print");
  if (entrypoint !== "cli" || headlessArgv) {
    return {
      canReceive: false,
      reason: "headless",
      detail: `non-interactive session (entrypoint=${entrypoint || "unset"}): inbound never surfaces`,
    };
  }

  // Exact-token match, not substring: this estate's wrappers pass a --settings
  // JSON blob in argv, and a substring test could match text inside it.
  if (!argv.includes(CHANNELS_FLAG)) {
    return { canReceive: false, reason: "no-flag", detail: "launched without the channels flag" };
  }

  // A flag-born session RESUMED is outbound-only: -c reuses the MCP snapshot but
  // never re-registers the listener that turns arrivals into tags (aby-wodagu).
  // Inferred from the launch flags, not measured for this detector — if a resumed
  // session ever shows tags, this branch is the first thing to re-test.
  if (argv.includes("-c") || argv.includes("--continue") || argv.includes("--resume")) {
    return { canReceive: false, reason: "resumed", detail: "resumed session: inbound surfacing dies on resume" };
  }

  return { canReceive: true, detail: "flag-born interactive session" };
}
