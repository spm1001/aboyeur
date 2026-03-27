/**
 * beat.ts — The inner loop of the aboyeur.
 *
 * Reads bon state, spawns a worker to do the next action,
 * spawns a reflector to review it, routes the verdict.
 *
 * Usage:
 *   npx tsx src/beat.ts <outcome-id>              # one beat cycle
 *   npx tsx src/beat.ts <outcome-id> --watch       # loop until done or stuck
 *   npx tsx src/beat.ts <outcome-id> --max-cycles 5  # limit iterations
 */

import { spawnAgent, type SpawnAgentOptions } from "./spawn-agent.js";
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// --- Paths ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const PROMPTS_DIR = resolve(REPO_ROOT, "shared", "prompts");
const BEAT_STATE_DIR = ".beat";

// --- Types ---

interface BonBrief {
  why?: string;
  what?: string;
  done?: string;
}

interface BonAction {
  id: string;
  type: "action";
  title: string;
  brief?: BonBrief;
  status: string;
}

interface BonOutcome {
  id: string;
  type: "outcome";
  title: string;
  brief?: BonBrief;
  status: string;
  actions: BonAction[];
}

interface BonState {
  outcomes: BonOutcome[];
  standalone: BonAction[];
}

type BeatVerdict = "approved" | "issues" | "inconclusive";

interface BeatResult {
  outcomeId: string;
  actionId: string;
  actionTitle: string;
  verdict: BeatVerdict;
  workerStatus: string;
  reflectorStatus: string;
  issues?: string;
  justification?: string;
}

// --- Logging ---

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function die(msg: string): never {
  console.error(`[beat] ERROR: ${msg}`);
  process.exit(1);
}

// --- Bon integration ---

function bonListJson(): BonState {
  try {
    const output = execSync("bon list --json", { encoding: "utf-8", timeout: 10_000 });
    return JSON.parse(output);
  } catch (err) {
    die(`Failed to read bon state. Is bon installed? Error: ${err}`);
  }
}

function formatBrief(brief: BonBrief | undefined): string {
  if (!brief) return "No brief provided.";
  const parts: string[] = [];
  if (brief.why) parts.push(`**Why:** ${brief.why}`);
  if (brief.what) parts.push(`**What:** ${brief.what}`);
  if (brief.done) parts.push(`**Done when:** ${brief.done}`);
  return parts.join("\n\n") || "No brief provided.";
}

// --- Git helpers ---

function gitHead(): string {
  return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
}

function gitDirty(): boolean {
  return execSync("git status --porcelain", { encoding: "utf-8" }).trim().length > 0;
}

function gitDiffStat(fromSha: string): string {
  try {
    return execSync(`git diff ${fromSha}..HEAD --stat`, { encoding: "utf-8" });
  } catch {
    return "(no changes)";
  }
}

function gitDiffFiles(fromSha: string): string {
  try {
    return execSync(`git diff ${fromSha}..HEAD --name-only`, { encoding: "utf-8" });
  } catch {
    return "";
  }
}

// --- File helpers ---

function cleanBeatState(): void {
  const dir = resolve(BEAT_STATE_DIR);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
  mkdirSync(dir, { recursive: true });
  // Add to .gitignore if not already there
  const gitignore = ".gitignore";
  if (existsSync(gitignore)) {
    const content = readFileSync(gitignore, "utf-8");
    if (!content.includes(BEAT_STATE_DIR)) {
      writeFileSync(gitignore, content.trimEnd() + `\n${BEAT_STATE_DIR}/\n`);
    }
  }
}

function readPrompt(name: string): string {
  const path = resolve(PROMPTS_DIR, name);
  if (!existsSync(path)) {
    die(`Prompt not found: ${path}`);
  }
  return readFileSync(path, "utf-8");
}

// --- Beat cycle ---

async function runOneBeat(
  outcomeId: string,
  cwd: string,
  cycleNumber: number,
): Promise<BeatResult | null> {
  // 1. Read bon state
  log(`Reading bon state...`);
  const bonState = bonListJson();

  const outcome = bonState.outcomes.find(
    (o) => o.id === outcomeId && o.status !== "done",
  );
  if (!outcome) {
    const done = bonState.outcomes.find((o) => o.id === outcomeId);
    if (done) {
      log(`Outcome ${outcomeId} is already done.`);
      return null;
    }
    die(`Outcome not found: ${outcomeId}`);
  }

  // 2. Find next undone action
  const openActions = outcome.actions.filter((a) => a.status !== "done");
  if (openActions.length === 0) {
    log(`No open actions for ${outcomeId}. All actions may be complete.`);
    return null;
  }

  // Check for previous issues from last cycle
  const issuesPath = resolve(BEAT_STATE_DIR, "ISSUES.md");
  const previousIssues = existsSync(issuesPath)
    ? readFileSync(issuesPath, "utf-8")
    : null;

  const action = openActions[0];
  log(`Action: ${action.id} — ${action.title}`);
  log(`Open actions remaining: ${openActions.length}`);

  // 3. Clean beat state (but preserve ISSUES.md for the worker to read)
  const approvedPath = resolve(BEAT_STATE_DIR, "APPROVED");
  if (existsSync(approvedPath)) rmSync(approvedPath);

  // 4. Record pre-worker git state
  if (gitDirty()) {
    die(
      "Working tree has uncommitted changes. Commit or stash before running a beat.",
    );
  }
  const preWorkerSha = gitHead();

  // 5. Build worker prompt
  const workerTemplate = readPrompt("beat-worker.md");
  let workerPrompt =
    workerTemplate +
    `\n## Your Assignment\n\n` +
    `**Action ID:** \`${action.id}\`\n` +
    `**Action:** ${action.title}\n` +
    `**Outcome:** ${outcome.title}\n\n` +
    `### Brief\n\n${formatBrief(action.brief)}\n\n` +
    `**Working directory:** \`${cwd}\`\n`;

  if (previousIssues) {
    workerPrompt +=
      `\n### Issues from Previous Review\n\n` +
      `A reviewer found these issues in the last cycle. Fix them.\n\n` +
      `${previousIssues}\n`;
  }

  // 6. Spawn worker
  log("Spawning worker...");
  const workerSessionId = `worker-${action.id}-${String(cycleNumber).padStart(2, "0")}`;
  const workerResult = await spawnAgent({
    folder: cwd,
    prompt: workerPrompt,
    sessionId: workerSessionId,
    maxTurns: 80,
  });

  log(`Worker finished: ${workerResult.status}`);

  if (workerResult.status === "error") {
    log(`Worker errored. Output: ${workerResult.result.slice(0, 300)}`);
    return {
      outcomeId,
      actionId: action.id,
      actionTitle: action.title,
      verdict: "inconclusive",
      workerStatus: "error",
      reflectorStatus: "skipped",
    };
  }

  // 7. Check if worker made changes
  const postWorkerSha = gitHead();
  const hasCommits = preWorkerSha !== postWorkerSha;
  const hasDirtyFiles = gitDirty();

  if (!hasCommits && !hasDirtyFiles) {
    log("Worker made no changes. Nothing to review.");
    return {
      outcomeId,
      actionId: action.id,
      actionTitle: action.title,
      verdict: "inconclusive",
      workerStatus: "no-changes",
      reflectorStatus: "skipped",
    };
  }

  if (hasDirtyFiles) {
    log("Worker left uncommitted changes — reflector will flag this.");
  }

  const diffStat = gitDiffStat(preWorkerSha);
  const changedFiles = gitDiffFiles(preWorkerSha);
  log(`Changes:\n${diffStat}`);

  // 8. Build reflector prompt
  const reflectorTemplate = readPrompt("beat-reflector.md");
  const reflectorPrompt =
    reflectorTemplate +
    `\n## What You're Reviewing\n\n` +
    `**Action ID:** \`${action.id}\`\n` +
    `**Action:** ${action.title}\n` +
    `**Outcome:** ${outcome.title}\n\n` +
    `### Original Brief (the spec)\n\n${formatBrief(action.brief)}\n\n` +
    `### Changes Made\n\n` +
    `Pre-worker commit: \`${preWorkerSha}\`\n` +
    `Post-worker commit: \`${postWorkerSha}\`\n\n` +
    "To see the full diff: `git diff " + preWorkerSha + "..HEAD`\n\n" +
    `\`\`\`\n${diffStat}\`\`\`\n\n` +
    `Changed files:\n${changedFiles.split("\n").filter(Boolean).map((f) => `- \`${f}\``).join("\n")}\n\n` +
    `**Verdict directory:** \`${BEAT_STATE_DIR}/\`\n` +
    `Write \`${BEAT_STATE_DIR}/APPROVED\` or \`${BEAT_STATE_DIR}/ISSUES.md\`.\n`;

  // 9. Spawn reflector
  log("Spawning reflector...");
  const reflectorSessionId = `reflector-${action.id}-${String(cycleNumber).padStart(2, "0")}`;
  const reflectorResult = await spawnAgent({
    folder: cwd,
    prompt: reflectorPrompt,
    sessionId: reflectorSessionId,
    maxTurns: 40,
    disallowedTools: ["Edit", "WebFetch", "TodoWrite", "NotebookEdit"],
  });

  log(`Reflector finished: ${reflectorResult.status}`);

  // 10. Route verdict
  if (existsSync(resolve(BEAT_STATE_DIR, "APPROVED"))) {
    const justification = readFileSync(
      resolve(BEAT_STATE_DIR, "APPROVED"),
      "utf-8",
    ).trim();
    log("APPROVED.");
    if (justification) {
      log(`Justification: ${justification.slice(0, 300)}`);
    }

    // Mark action done in bon
    try {
      execSync(`bon done ${action.id}`, { encoding: "utf-8", timeout: 10_000 });
      log(`Marked ${action.id} done in bon.`);
    } catch (err) {
      log(`Warning: failed to mark bon done: ${err}`);
    }

    return {
      outcomeId,
      actionId: action.id,
      actionTitle: action.title,
      verdict: "approved",
      workerStatus: workerResult.status,
      reflectorStatus: reflectorResult.status,
      justification,
    };
  }

  if (existsSync(resolve(BEAT_STATE_DIR, "ISSUES.md"))) {
    const issues = readFileSync(
      resolve(BEAT_STATE_DIR, "ISSUES.md"),
      "utf-8",
    ).trim();
    log("ISSUES found:");
    log(issues);

    return {
      outcomeId,
      actionId: action.id,
      actionTitle: action.title,
      verdict: "issues",
      workerStatus: workerResult.status,
      reflectorStatus: reflectorResult.status,
      issues,
    };
  }

  log("Reflector didn't create APPROVED or ISSUES.md.");
  log(`Reflector output: ${reflectorResult.result.slice(0, 500)}`);

  return {
    outcomeId,
    actionId: action.id,
    actionTitle: action.title,
    verdict: "inconclusive",
    workerStatus: workerResult.status,
    reflectorStatus: reflectorResult.status,
  };
}

// --- Watch mode ---

async function watch(
  outcomeId: string,
  cwd: string,
  maxCycles: number,
): Promise<void> {
  log(`Watching ${outcomeId} (max ${maxCycles} cycles)`);

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    log(`\n=== Cycle ${cycle}/${maxCycles} ===\n`);

    const result = await runOneBeat(outcomeId, cwd, cycle);

    if (result === null) {
      log("Nothing to do. Stopping.");
      break;
    }

    if (result.verdict === "approved") {
      log(`Action ${result.actionId} approved. Checking for more actions...`);
      // Continue to next action
      continue;
    }

    if (result.verdict === "issues") {
      log("Issues found. Running fix cycle...");
      // Next iteration will pick up the same action with ISSUES.md context
      continue;
    }

    // Inconclusive — stop to avoid burning tokens on a broken loop
    log("Inconclusive result. Stopping to avoid wasting tokens.");
    break;
  }

  log("Watch complete.");
}

// --- CLI ---

function printUsage(): void {
  console.log(`
Usage:
  npx tsx src/beat.ts <outcome-id>                 Run one beat cycle
  npx tsx src/beat.ts <outcome-id> --watch         Loop until done or stuck
  npx tsx src/beat.ts <outcome-id> --max-cycles N  Limit watch iterations (default: 5)

Examples:
  npx tsx src/beat.ts aby-hibusa
  npx tsx src/beat.ts aby-hibusa --watch --max-cycles 3
`.trim());
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const outcomeId = args[0];
  const watchMode = args.includes("--watch");
  const maxCyclesIdx = args.indexOf("--max-cycles");
  const maxCycles =
    maxCyclesIdx !== -1 ? parseInt(args[maxCyclesIdx + 1], 10) || 5 : 5;

  const cwd = process.cwd();

  // Verify we're in a git repo
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {
    die("Not inside a git repository.");
  }

  // Verify bon is available
  try {
    execSync("bon --version", { encoding: "utf-8", stdio: "pipe" });
  } catch {
    die("bon CLI not found. Install bon first.");
  }

  cleanBeatState();

  if (watchMode) {
    await watch(outcomeId, cwd, maxCycles);
  } else {
    const result = await runOneBeat(outcomeId, cwd, 1);
    if (result) {
      log(`\nResult: ${result.verdict.toUpperCase()}`);
      if (result.verdict === "issues") {
        log("Run another beat cycle to address the issues.");
      }
    }
  }
}

main().catch((err) => {
  console.error(`[beat] Fatal: ${err}`);
  process.exit(1);
});
