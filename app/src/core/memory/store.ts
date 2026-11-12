/**
 * store.ts — SQLite FTS5 recall slice (docs/33 §5.4 partial).
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { stateRoot } from "../paths";
import { loadMemoryManifest } from "./manifest";

const TABLE = "memory_fts";

export function memoryDbPath(workspace: string): string {
  return path.join(stateRoot(workspace), "memory.db");
}

function escapeFtsToken(token: string): string {
  return token.replace(/["'*]/g, " ").trim();
}

function ftsQuery(userQuery: string): string | undefined {
  const terms = userQuery
    .split(/\s+/)
    .map(escapeFtsToken)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return undefined;
  return terms.map((t) => `"${t}"`).join(" AND ");
}

function openDb(workspace: string): Database {
  const dir = stateRoot(workspace);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(memoryDbPath(workspace), { create: true });
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING fts5(content, tokenize='porter');`);
  return db;
}

/** Test hook: replace the entire index with `facts`. */
export function replaceMemoryIndex(workspace: string, facts: readonly string[]): void {
  const db = openDb(workspace);
  db.exec(`DELETE FROM ${TABLE};`);
  const insert = db.prepare(`INSERT INTO ${TABLE}(content) VALUES (?)`);
  const tx = db.transaction((rows: readonly string[]) => {
    for (const row of rows) {
      const text = row.trim();
      if (text !== "") insert.run(text);
    }
  });
  tx(facts);
}

function reindexFromManifestIfEmpty(workspace: string, db: Database): void {
  const row = db.query(`SELECT count(*) as n FROM ${TABLE}`).get() as { n: number };
  if (row.n > 0) return;
  const manifest = loadMemoryManifest(workspace);
  if (manifest === undefined) return;
  const lines = manifest
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("["));
  if (lines.length === 0) return;
  const insert = db.prepare(`INSERT INTO ${TABLE}(content) VALUES (?)`);
  const tx = db.transaction((rows: string[]) => {
    for (const line of rows) insert.run(line);
  });
  tx(lines);
}

/** BM25-ranked lines from the workspace memory index. */
export function memorySearch(workspace: string, query: string, limit = 8): string[] {
  const match = ftsQuery(query);
  if (match === undefined) return [];
  const db = openDb(workspace);
  try {
    reindexFromManifestIfEmpty(workspace, db);
    const rows = db
      .query(`SELECT content FROM ${TABLE} WHERE ${TABLE} MATCH ? ORDER BY bm25(${TABLE}) LIMIT ?`)
      .all(match, limit) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  } catch {
    return [];
  } finally {
    db.close();
  }
}
