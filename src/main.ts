/**
 * Daemon entry point — the lizard brain.
 *
 * Wires: trigger sources → SQLite queue → context queue → spawn aboyeur.
 * No intelligence. Just plumbing.
 *
 * Usage:
 *   node dist/main.js [--db-path /path/to/triggers.db]
 *
 * Environment:
 *   ABOYEUR_DB_PATH — SQLite database path (default: ~/.local/share/aboyeur/triggers.db)
 *   ABOYEUR_POLL_MS — trigger loop interval in ms (default: 2000)
 *   ABOYEUR_DIR     — aboyeur working directory (default: repo root)
 */

import { startDaemon } from "./daemon.js";
import { resolveSpawn } from "./router.js";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- Config ---

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const dbPath = process.env.ABOYEUR_DB_PATH
  ?? join(homedir(), ".local", "share", "aboyeur", "triggers.db");
const pollMs = Number(process.env.ABOYEUR_POLL_MS) || 2000;
const aboyeurDir = process.env.ABOYEUR_DIR ?? repoRoot;

// Ensure DB directory exists
mkdirSync(dirname(dbPath), { recursive: true });

// --- Start ---

console.log(`[aboyeur-daemon] Starting`);
console.log(`  DB: ${dbPath}`);
console.log(`  Poll: ${pollMs}ms`);
console.log(`  Dir: ${aboyeurDir}`);

const daemon = startDaemon({
  dbPath,
  pollIntervalMs: pollMs,
  resolveSpawn: (trigger) => resolveSpawn(trigger, { aboyeurDir }),
  onDispatch: (trigger) => {
    console.log(`[dispatch] ${trigger.source}/${trigger.context_group} → aboyeur`);
  },
  onComplete: (trigger, result) => {
    console.log(`[complete] ${trigger.source}/${trigger.context_group} — ${result.status}: ${result.result.slice(0, 120)}`);
  },
  onError: (trigger, error) => {
    console.error(`[error] ${trigger.source}/${trigger.context_group}:`, error);
  },
});

// NOTE: The HEARTBEAT cron schedule that used to be wired here now rides a native
// CronCreate loop — see HEARTBEAT.md. trigger-cron.ts has no consumers left;
// its deletion is tracked as aby-cazete.

// --- Graceful shutdown ---

function shutdown(signal: string) {
  console.log(`[aboyeur-daemon] Received ${signal}, shutting down...`);
  daemon.stop();
  console.log(`[aboyeur-daemon] Stopped`);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Keep alive
console.log(`[aboyeur-daemon] Running. PID ${process.pid}`);
