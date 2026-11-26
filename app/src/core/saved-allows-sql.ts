/**
 * saved-allows-sql.ts — workspace-scoped SQLite rows (OpenCode permission/sql ADAPT).
 *
 * Primary store: `saved_allows` in `sessionDbPath(workspace)` (project = workspace).
 * `saved-allows.json` remains a 0600 export mirror for inspection and legacy tooling.
 */

import { existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import type { GuardKind } from "../contracts";
import { withFileLockSync } from "./file-lock";
import { migrateSessionDb } from "./session-migrate";
import { sessionDbPath } from "./paths";
import { assertSqliteReconcileBarrierClear } from "./session";
import type { SavedAllowRow } from "./saved-allows";

const SAVE_LOCK_SUFFIX = ".saved-allows.lock";

function openSavedAllowsDb(workspace: string, readonly = false): Database | null {
  const dbPath = sessionDbPath(workspace);
  const dir = path.dirname(dbPath);
  // A presentation/doctor read must never create `.hz/state` (or fail on a
  // read-only workspace). Only a writer creates the directory and schema.
  if (readonly && (!existsSync(dir) || !existsSync(dbPath))) return null;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath, readonly ? { readonly: true } : { create: true });
  if (!readonly) {
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = FULL;");
    } catch {
      /* best effort */
    }
    migrateSessionDb(db);
  }
  return db;
}

function rowFromSql(row: {
  kind: string;
  target: string;
  action: string | null;
  saved_at: string;
}): SavedAllowRow | null {
  const kind = row.kind?.trim() ?? "";
  const target = row.target?.trim() ?? "";
  if (kind === "" || target === "" || target.endsWith("*")) return null;
  const out: SavedAllowRow = { kind: kind as GuardKind, target, savedAt: row.saved_at };
  if (typeof row.action === "string" && row.action !== "") out.action = row.action;
  return out;
}

/** Load rows from SQLite (newest `saved_at` first). */
export function loadSavedAllowsSql(workspace: string): SavedAllowRow[] {
  const db = openSavedAllowsDb(workspace, true);
  if (db === null) return [];
  try {
    const raw = db
      .query(
        `SELECT kind, target, action, saved_at FROM saved_allows ORDER BY saved_at DESC, kind, target`,
      )
      .all() as Array<{ kind: string; target: string; action: string | null; saved_at: string }>;
    return raw.map(rowFromSql).filter((r): r is SavedAllowRow => r !== null);
  } finally {
    db.close();
  }
}

function enforceCap(db: Database, cap: number): void {
  db.run(
  `DELETE FROM saved_allows WHERE rowid NOT IN (
    SELECT rowid FROM saved_allows ORDER BY saved_at DESC LIMIT ?
  )`,
    [cap],
  );
}

/** Upsert one row and enforce cap inside a file lock + transaction. */
export function upsertSavedAllowsSql(workspace: string, rows: SavedAllowRow[], cap: number): void {
  assertSqliteReconcileBarrierClear("saved-allows-sql.upsertSavedAllowsSql");
  const dbPath = sessionDbPath(workspace);
  withFileLockSync(`${dbPath}${SAVE_LOCK_SUFFIX}`, () => {
    const db = openSavedAllowsDb(workspace);
    if (db === null) throw new Error("saved-allows: cannot open the workspace database for writing");
    try {
      const run = db.transaction(() => {
        const upsert = db.prepare(
          `INSERT INTO saved_allows (kind, target, action, saved_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(kind, target) DO UPDATE SET action = excluded.action, saved_at = excluded.saved_at`,
        );
        for (const row of rows) {
          if (row.target === "" || row.target.endsWith("*")) continue;
          upsert.run(row.kind, row.target, row.action ?? null, row.savedAt);
        }
        enforceCap(db, cap);
      });
      run();
    } finally {
      db.close();
    }
  });
}

/** Import JSON rows when the SQL table is empty (legacy workspaces). */
export function importJsonIntoSqlIfEmpty(workspace: string, jsonRows: SavedAllowRow[], cap: number): boolean {
  if (jsonRows.length === 0) return false;
  assertSqliteReconcileBarrierClear("saved-allows-sql.importJsonIntoSqlIfEmpty");
  const dbPath = sessionDbPath(workspace);
  let imported = false;
  withFileLockSync(`${dbPath}${SAVE_LOCK_SUFFIX}`, () => {
    const db = openSavedAllowsDb(workspace);
    if (db === null) throw new Error("saved-allows: cannot open the workspace database for import");
    try {
      const count = (db.query("SELECT COUNT(*) AS c FROM saved_allows").get() as { c: number }).c;
      if (count > 0) return;
      const run = db.transaction(() => {
        for (const row of jsonRows.slice(-cap)) {
          if (row.target === "" || row.target.endsWith("*")) continue;
          db.run(
            `INSERT OR REPLACE INTO saved_allows (kind, target, action, saved_at) VALUES (?, ?, ?, ?)`,
            [row.kind, row.target, row.action ?? null, row.savedAt],
          );
        }
      });
      run();
      imported = true;
    } finally {
      db.close();
    }
  });
  return imported;
}