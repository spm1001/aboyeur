/**
 * Router — resolves a trigger into spawn options for the aboyeur or one-shot.
 *
 * Two-tier routing:
 *   1. Daemon → Aboyeur: every trigger wakes the aboyeur (this module)
 *   2. Aboyeur → One-shot/PM: the aboyeur prompt handles second-tier routing
 *
 * For now, the daemon always spawns the aboyeur with the trigger payload.
 * The aboyeur's own prompt (aboyeur-open.md) decides one-shot vs PM.
 * When we add PM routing, it'll be an aboyeur concern, not the daemon's.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Trigger } from "./trigger-db.js";
import type { SpawnAgentOptions } from "./spawn-agent.js";

// --- Types ---

export interface RouterOptions {
  /** Aboyeur working directory (defaults to cwd). */
  aboyeurDir?: string;
  /** Path to prompts directory (defaults to shared/prompts in aboyeurDir). */
  promptsDir?: string;
  /** Max turns for aboyeur sessions (default: 20 — routing should be fast). */
  maxTurns?: number;
}

// --- Session naming ---

function timeStamp(): string {
  const now = new Date();
  return [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
}

function aboyeurSessionName(trigger: Trigger): string {
  return `aboyeur-${trigger.source}-${timeStamp()}`;
}

// --- Prompt loading ---

function loadPrompt(promptsDir: string, name: string): string {
  try {
    return readFileSync(join(promptsDir, name), "utf-8");
  } catch {
    return "";
  }
}

// --- Trigger formatting ---

function formatTriggerPayload(trigger: Trigger): string {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(trigger.payload);
  } catch {
    payload = { raw: trigger.payload };
  }

  return [
    `## Trigger`,
    `- **Source:** ${trigger.source}`,
    `- **Context:** ${trigger.context_group}`,
    `- **Received:** ${trigger.created_at}`,
    ``,
    `### Payload`,
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}

// --- Router ---

export function resolveSpawn(
  trigger: Trigger,
  opts: RouterOptions = {},
): SpawnAgentOptions {
  const aboyeurDir = opts.aboyeurDir ?? process.cwd();
  const promptsDir = opts.promptsDir ?? join(aboyeurDir, "shared", "prompts");
  const maxTurns = opts.maxTurns ?? 20;

  const systemPrompt = loadPrompt(promptsDir, "aboyeur-open.md");
  const sessionName = aboyeurSessionName(trigger);
  const triggerBlock = formatTriggerPayload(trigger);

  const prompt = [
    `A trigger has arrived. Route it.`,
    ``,
    triggerBlock,
  ].join("\n");

  return {
    folder: aboyeurDir,
    prompt,
    sessionId: sessionName,
    systemPrompt: systemPrompt || undefined,
    maxTurns,
  };
}
