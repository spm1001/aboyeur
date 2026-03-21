/**
 * spawnAgent() — spawn a Claude Code session and collect structured output.
 *
 * Extracted from Gueridon's spawnCC() pattern (bridge.ts:326-345).
 * Uses the `claude` CLI directly with stream-json — no Agent SDK dependency.
 * Max subscription auth (no API keys).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";

// --- Types ---

export interface SpawnAgentOptions {
  /** Working directory for the Claude session. */
  folder: string;
  /** Initial prompt to send. */
  prompt: string;
  /** Session ID for fresh sessions, or to resume. */
  sessionId?: string;
  /** Resume an existing session instead of starting fresh. */
  resume?: boolean;
  /** Maximum turns before the session stops. */
  maxTurns?: number;
  /** Additional system prompt appended via --append-system-prompt. */
  systemPrompt?: string;
  /** Allowed tools (defaults to a sensible set). */
  allowedTools?: string[];
  /** Disallowed tools (defaults to WebFetch, TodoWrite, NotebookEdit). */
  disallowedTools?: string[];
  /** Permission mode (default: "default" — uses --allowed-tools whitelist). */
  permissionMode?: string;
  /** MCP config path (defaults to ~/.claude/settings.json). */
  mcpConfigPath?: string;
  /** Mesh agent ID — if set, enables conductor mesh via Channels MCP. */
  meshAgentId?: string;
  /** Mesh role — aboyeur | pm | worker | user (default: user). */
  meshRole?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /**
   * Called immediately after spawn with the child PID.
   * The daemon uses this to register the PID for orphan tracking —
   * if the daemon crashes, it can kill orphaned claudes on restart.
   */
  onSpawn?: (pid: number) => void;
  /**
   * Init timeout in ms. If claude doesn't emit a system:init event
   * within this window, the process is killed. Default: 30_000.
   * Gueridon observed 90s stalls on third concurrent resume — this
   * prevents infinite hangs.
   */
  initTimeoutMs?: number;
}

export interface SpawnAgentResult {
  /** "success" | "error" | "aborted" — mirrors CC result subtypes. */
  status: "success" | "error" | "aborted";
  /** Final text output from the assistant (last assistant message text). */
  result: string;
  /** Session ID — use this to resume later. */
  sessionId: string;
  /** All CC events received, in order. */
  events: CCEvent[];
  /** Exit code of the claude process. */
  exitCode: number | null;
  /** Last lines of stderr (for diagnostics). */
  stderr: string[];
}

/** A parsed CC stdout event. Kept loose — CC's event schema evolves. */
export type CCEvent = Record<string, unknown>;

// --- Constants ---

const DEFAULT_ALLOWED_TOOLS = [
  "Bash", "Read", "Edit", "Write", "Glob", "Grep",
  "WebSearch",
  "Task", "TaskOutput", "TaskStop",
  "Skill", "AskUserQuestion",
  "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ToolSearch",
  "mcp__*",
];

const DEFAULT_DISALLOWED_TOOLS = ["WebFetch", "TodoWrite", "NotebookEdit"];

const MCP_CONFIG_DEFAULT = join(homedir(), ".claude", "settings.json");

/** Env vars to strip — prevents "Claude spawning Claude" block. */
const STRIP_ENV_VARS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

/** Env vars to set for headless operation. */
const HEADLESS_ENV: Record<string, string> = {
  CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_HIDE_ACCOUNT_INFO: "1",
};

const MAX_STDERR_LINES = 20;
const DEFAULT_INIT_TIMEOUT_MS = 30_000;

// --- Build CLI args ---

function buildArgs(opts: SpawnAgentOptions, sessionId: string): string[] {
  const allowed = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  const disallowed = opts.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS;
  const permissionMode = opts.permissionMode ?? "default";
  const mcpConfig = opts.mcpConfigPath ?? MCP_CONFIG_DEFAULT;

  const args = [
    "-p",
    "--verbose",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--allowed-tools", allowed.join(","),
    "--disallowedTools", disallowed.join(","),
    "--permission-mode", permissionMode,
    "--mcp-config", mcpConfig,
  ];

  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }

  if (opts.maxTurns !== undefined) {
    args.push("--max-turns", String(opts.maxTurns));
  }

  // Mesh: load conductor-channel as a CC Channel if agent ID is set
  if (opts.meshAgentId) {
    args.push("--dangerously-load-development-channels", "server:conductor-channel");
  }

  // Session resume vs fresh
  if (opts.resume && opts.sessionId) {
    args.push("--resume", sessionId);
  } else {
    args.push("--session-id", sessionId);
  }

  return args;
}

// --- Build env ---

function buildEnv(opts: SpawnAgentOptions): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!STRIP_ENV_VARS.includes(k)) {
      env[k] = v;
    }
  }
  const meshEnv: Record<string, string> = {};
  if (opts.meshAgentId) {
    meshEnv.MESH_AGENT_ID = opts.meshAgentId;
    meshEnv.MESH_ROLE = opts.meshRole ?? "user";
  }
  return { ...env, ...HEADLESS_ENV, ...meshEnv };
}

// --- Event extraction helpers ---

/** Extract the final assistant text from collected events. */
function extractResult(events: CCEvent[]): string {
  let lastText = "";
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== "assistant") continue;
    const message = ev.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const content = message.content;
    if (typeof content === "string") {
      lastText = content;
      break;
    }
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          texts.push(b.text);
        }
      }
      if (texts.length > 0) {
        lastText = texts.join("\n");
        break;
      }
    }
  }
  return lastText;
}

/** Extract session ID from init event, falling back to the one we passed. */
function extractSessionId(events: CCEvent[], fallback: string): string {
  for (const ev of events) {
    if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
      return ev.session_id;
    }
  }
  return fallback;
}

/** Extract result status from the result event. */
function extractStatus(events: CCEvent[]): "success" | "error" | "aborted" {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "result") {
      if (ev.is_error) return "error";
      if (ev.subtype === "aborted") return "aborted";
      return "success";
    }
  }
  return "error"; // no result event = something went wrong
}

// --- Main function ---

export function spawnAgent(opts: SpawnAgentOptions): Promise<SpawnAgentResult> {
  const sessionId = opts.sessionId ?? crypto.randomUUID();
  const args = buildArgs(opts, sessionId);
  const env = buildEnv(opts);

  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        cwd: opts.folder,
      });
    } catch (err) {
      reject(new Error(`Failed to spawn claude: ${err}`));
      return;
    }

    // Notify caller of PID immediately — daemon uses this for orphan tracking
    if (opts.onSpawn && proc.pid !== undefined) {
      opts.onSpawn(proc.pid);
    }

    const events: CCEvent[] = [];
    const stderrBuffer: string[] = [];
    let initReceived = false;

    // Init timeout: kill if claude doesn't emit system:init in time.
    // Gueridon observed 90s stalls on third concurrent resume.
    const initTimeoutMs = opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    const initTimer = setTimeout(() => {
      if (!initReceived) {
        stderrBuffer.push(`[spawnAgent] init timeout after ${initTimeoutMs}ms`);
        proc.kill("SIGTERM");
      }
    }, initTimeoutMs);

    // Parse stdout as newline-delimited JSON
    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event: CCEvent = JSON.parse(trimmed);
        // Skip subagent events — they contaminate parent state
        if (event.parent_tool_use_id != null) return;
        if (event.type === "system" && event.subtype === "init") {
          initReceived = true;
          clearTimeout(initTimer);
        }
        events.push(event);
      } catch {
        // Non-JSON line — ignore (CC sometimes emits debug output)
      }
    });

    // Buffer stderr for diagnostics
    const stderrRl = createInterface({ input: proc.stderr! });
    stderrRl.on("line", (line) => {
      stderrBuffer.push(line);
      if (stderrBuffer.length > MAX_STDERR_LINES) stderrBuffer.shift();
    });

    // Send the initial prompt as a stream-json message
    const promptMessage = JSON.stringify({
      type: "user",
      message: { role: "user", content: opts.prompt },
    });
    proc.stdin!.write(promptMessage + "\n");
    proc.stdin!.end();

    proc.on("error", (err) => {
      reject(new Error(`claude process error: ${err.message}`));
    });

    // Track whether we aborted via our signal
    let abortedBySignal = false;
    if (opts.signal) {
      const onAbort = (): void => {
        abortedBySignal = true;
        proc.kill("SIGTERM");
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
      proc.on("exit", () => {
        opts.signal!.removeEventListener("abort", onAbort);
      });
    }

    proc.on("exit", (code, signal) => {
      clearTimeout(initTimer);
      const resolvedSessionId = extractSessionId(events, sessionId);
      const status = abortedBySignal || signal
        ? "aborted"
        : extractStatus(events);

      resolve({
        status,
        result: extractResult(events),
        sessionId: resolvedSessionId,
        events,
        exitCode: code,
        stderr: [...stderrBuffer],
      });
    });
  });
}
