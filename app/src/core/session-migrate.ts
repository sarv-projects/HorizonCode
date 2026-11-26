/**
 * session-migrate.ts — ordered SQLite migrations for the session store (F5).
 *
 * ADAPT opencode `database/migration.ts`: `PRAGMA user_version` plus idempotent
 * steps under the existing `<db>.migrate.lock` (session.ts). Rebuild/projectors
 * are out of scope; migration 1 only adds the `projection_watermark` stub table
 * from docs/12 §4.2 so future projectors have a home.
 */

import type { Database } from "bun:sqlite";

/** Latest `PRAGMA user_version` after all migrations in this module run. */
export const SESSION_DB_USER_VERSION = 5;

export function readSessionDbUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
  return Number(row?.user_version ?? 0);
}

type MigrationFn = (db: Database) => void;

const MIGRATIONS: Record<number, MigrationFn> = {
  1: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projection_watermark (
        projector TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        applied_through_seq INTEGER NOT NULL DEFAULT 0,
        digest TEXT,
        PRIMARY KEY (projector, aggregate_id)
      );
    `);
  },
  2: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS saved_allows (
        kind TEXT NOT NULL,
        target TEXT NOT NULL,
        action TEXT,
        saved_at TEXT NOT NULL,
        PRIMARY KEY (kind, target)
      );
      CREATE INDEX IF NOT EXISTS idx_saved_allows_saved_at ON saved_allows(saved_at);
    `);
  },
  3: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS steering_drain (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        framing TEXT,
        enqueued_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_steering_drain_session_time
        ON steering_drain(session_id, enqueued_at);
    `);
  },
  4: (db) => {
    // New parallel typed event stream; legacy `messages` rows are NOT rewritten.
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_event (
        id TEXT PRIMARY KEY,
        aggregate_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        prev_digest TEXT,
        digest TEXT NOT NULL,
        UNIQUE(aggregate_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_session_event_aggregate_seq
        ON session_event(aggregate_id, seq);
      CREATE TABLE IF NOT EXISTS session_lifecycle (
        aggregate_id TEXT PRIMARY KEY,
        started_at TEXT,
        ended_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0
      );
    `);
  },
  5: (db) => {
    // Group-commit metadata (Group H / chord port). Idempotent group ids.
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_group (
        group_id TEXT PRIMARY KEY,
        aggregate_id TEXT NOT NULL,
        group_digest TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        committed_at TEXT NOT NULL
      );
    `);
  },
};

/**
 * Apply every migration with version > current `user_version`, bumping the
 * pragma after each step inside one SQLite transaction.
 */
export function migrateSessionDb(db: Database): void {
  let version = readSessionDbUserVersion(db);
  while (version < SESSION_DB_USER_VERSION) {
    const next = version + 1;
    const step = MIGRATIONS[next];
    if (step === undefined) break;
    const run = db.transaction(() => {
      step(db);
      db.exec(`PRAGMA user_version = ${next}`);
    });
    run();
    version = next;
  }
}
