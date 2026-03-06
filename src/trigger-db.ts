/**
 * SQLite trigger queue — schema, insert, claim, cursor tracking, crash recovery.
 *
 * Pure database operations. No polling, no spawning — that's trigger-loop.ts.
 * Uses better-sqlite3 for synchronous, single-connection SQLite access.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";

// --- Types ---

export type TriggerStatus = "pending" | "claimed" | "done" | "failed";

export interface Trigger {
  id: number;
  source: string;
  context_group: string;
  payload: string;
  dedup_hash: string;
  status: TriggerStatus;
  created_at: string;
  claimed_at: string | null;
  done_at: string | null;
  error: string | null;
}

export interface InsertTriggerOpts {
  source: string;
  context_group: string;
  payload: string;
}

// --- Schema ---

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS triggers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    context_group TEXT NOT NULL,
    payload TEXT NOT NULL,
    dedup_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    done_at TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_triggers_status ON triggers(status);
  CREATE INDEX IF NOT EXISTS idx_triggers_dedup ON triggers(dedup_hash, status);
  CREATE INDEX IF NOT EXISTS idx_triggers_context ON triggers(context_group, status);

  CREATE TABLE IF NOT EXISTS cursors (
    source TEXT PRIMARY KEY,
    last_seen TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

// --- Dedup hash ---

function computeHash(source: string, payload: string): string {
  return createHash("sha256").update(`${source}:${payload}`).digest("hex").slice(0, 16);
}

// --- TriggerDB class ---

export class TriggerDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  /**
   * Insert a trigger into the queue. Returns the new row ID,
   * or null if a duplicate is already pending/claimed.
   */
  insert(opts: InsertTriggerOpts): number | null {
    const hash = computeHash(opts.source, opts.payload);
    const now = new Date().toISOString();

    // Dedup: skip if same hash is already pending or claimed
    const existing = this.db.prepare(
      `SELECT id FROM triggers WHERE dedup_hash = ? AND status IN ('pending', 'claimed')`,
    ).get(hash) as { id: number } | undefined;

    if (existing) return null;

    const result = this.db.prepare(
      `INSERT INTO triggers (source, context_group, payload, dedup_hash, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).run(opts.source, opts.context_group, opts.payload, hash, now);

    return result.lastInsertRowid as number;
  }

  /**
   * Claim up to `limit` pending triggers, oldest first.
   * Atomically sets status to 'claimed' and claimed_at to now.
   * Returns claimed triggers.
   */
  claimPending(limit: number = 10): Trigger[] {
    const now = new Date().toISOString();

    // Use a transaction to atomically select and update
    const claim = this.db.transaction(() => {
      const rows = this.db.prepare(
        `SELECT * FROM triggers WHERE status = 'pending' ORDER BY created_at LIMIT ?`,
      ).all(limit) as Trigger[];

      if (rows.length === 0) return [];

      const ids = rows.map(r => r.id);
      this.db.prepare(
        `UPDATE triggers SET status = 'claimed', claimed_at = ?
         WHERE id IN (${ids.map(() => "?").join(",")})`,
      ).run(now, ...ids);

      // Return with updated status
      return rows.map(r => ({ ...r, status: "claimed" as TriggerStatus, claimed_at: now }));
    });

    return claim();
  }

  /**
   * Mark a trigger as done.
   */
  markDone(id: number): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE triggers SET status = 'done', done_at = ? WHERE id = ?`,
    ).run(now, id);
  }

  /**
   * Mark a trigger as failed with an error message.
   */
  markFailed(id: number, error: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE triggers SET status = 'failed', done_at = ?, error = ? WHERE id = ?`,
    ).run(now, error, id);
  }

  /**
   * Crash recovery: re-queue triggers that were claimed but never completed.
   * Called on daemon startup. Any trigger with status='claimed' was in-flight
   * when the daemon died — reset to 'pending' for reprocessing.
   */
  recoverClaimed(): number {
    const result = this.db.prepare(
      `UPDATE triggers SET status = 'pending', claimed_at = NULL WHERE status = 'claimed'`,
    ).run();
    return result.changes;
  }

  /**
   * Get or set the cursor (last_seen timestamp) for a source.
   */
  getCursor(source: string): string | null {
    const row = this.db.prepare(
      `SELECT last_seen FROM cursors WHERE source = ?`,
    ).get(source) as { last_seen: string } | undefined;
    return row?.last_seen ?? null;
  }

  setCursor(source: string, lastSeen: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO cursors (source, last_seen, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET last_seen = excluded.last_seen, updated_at = excluded.updated_at`,
    ).run(source, lastSeen, now);
  }

  /**
   * Count triggers by status (for monitoring/debugging).
   */
  counts(): Record<TriggerStatus, number> {
    const rows = this.db.prepare(
      `SELECT status, COUNT(*) as count FROM triggers GROUP BY status`,
    ).all() as Array<{ status: TriggerStatus; count: number }>;

    const result: Record<TriggerStatus, number> = { pending: 0, claimed: 0, done: 0, failed: 0 };
    for (const row of rows) {
      result[row.status] = row.count;
    }
    return result;
  }

  /**
   * Get pending triggers for a specific context group (for the FIFO queue).
   */
  pendingForContext(contextGroup: string): Trigger[] {
    return this.db.prepare(
      `SELECT * FROM triggers WHERE context_group = ? AND status = 'pending' ORDER BY created_at`,
    ).all(contextGroup) as Trigger[];
  }

  close(): void {
    this.db.close();
  }
}
