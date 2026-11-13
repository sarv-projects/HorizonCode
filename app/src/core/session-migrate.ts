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
export const SESSION_DB_USER_VERSION = 1;

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
