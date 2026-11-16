/**
 * store.ts — SQLite FTS5 recall with partitioned banks (docs/33 §5.4 partial).
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import * as path from "node:path";
import {
  chmodSqliteFiles,
  ensurePrivateDir,
  ensureWorkspaceStateDir,
  stateRoot,
  workspaceStateDir,
  workspaceStateFile,
} from "../paths";
import {
  MEMORY_BANKS,
  PROJECT_BANK,
  SHARED_RECALL_BANKS,
  type MemoryBankId,
  bankStorageKind,
  userMemoryDbPath,
} from "./banks";
import { appendRememberedFactToMemoryIndex, loadMemoryManifest, loadMemoryTopicBodies } from "./manifest";
import { mmrLiteSelect } from "./mmr-lite";

const TABLE = "memory_fts";

export type MemoryHit = {
  bank: MemoryBankId;
  content: string;
};

export type MemorySearchOptions = {
  limit?: number;
  /** When set, search only these banks. Default: `[project]`. */
  banks?: readonly MemoryBankId[];
  /**
   * When true, rerank BM25 candidates with lexical MMR-lite diversity (no embeddings).
   * `sharedMemorySearch` enables this by default.
   */
  diversify?: boolean;
};

export const MEMORY_FACT_MAX_CHARS = 5000;

/** The recall index: `<workspace>/.hz/state/memory.db` (legacy `.hz/` copied on open). */
export function memoryDbPath(workspace: string): string {
  return path.join(workspaceStateDir(workspace), "memory.db");
}

export function memoryDbPathForBank(workspace: string, bank: MemoryBankId, home?: string): string {
  return bankStorageKind(bank) === "workspace" ? memoryDbPath(workspace) : userMemoryDbPath(home);
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

function tableHasBankColumn(db: Database): boolean {
  const row = db
    .query(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
    .get(TABLE) as { sql: string } | null;
  if (row === null) return false;
  return row.sql.includes("bank");
}

function migrateLegacyFtsIfNeeded(db: Database): void {
  if (tableHasBankColumn(db)) return;
  const legacy = db.query(`SELECT content FROM ${TABLE}`).all() as Array<{ content: string }>;
  db.exec(`DROP TABLE ${TABLE};`);
  db.exec(
    `CREATE VIRTUAL TABLE ${TABLE} USING fts5(content, bank UNINDEXED, tokenize='porter');`,
  );
  if (legacy.length === 0) return;
  const insert = db.prepare(`INSERT INTO ${TABLE}(content, bank) VALUES (?, ?)`);
  const tx = db.transaction((rows: Array<{ content: string }>) => {
    for (const r of rows) {
      const text = r.content.trim();
      if (text !== "") insert.run(text, PROJECT_BANK);
    }
  });
  tx(legacy);
}

function openDbAt(dbPath: string): Database {
  ensurePrivateDir(path.dirname(dbPath));
  const db = new Database(dbPath, { create: true });
  chmodSqliteFiles(dbPath);
  const exists = db
    .query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(TABLE) as { name: string } | null;
  if (exists === null) {
    db.exec(
      `CREATE VIRTUAL TABLE ${TABLE} USING fts5(content, bank UNINDEXED, tokenize='porter');`,
    );
  } else {
    migrateLegacyFtsIfNeeded(db);
  }
  chmodSqliteFiles(dbPath);
  return db;
}

function closeDb(db: Database, dbPath: string): void {
  try {
    chmodSqliteFiles(dbPath);
  } finally {
    db.close();
  }
}

function openWorkspaceDb(workspace: string): Database {
  ensureWorkspaceStateDir(workspace);
  return openDbAt(workspaceStateFile(workspace, "memory.db"));
}

function openUserDb(home?: string): Database {
  return openDbAt(userMemoryDbPath(home));
}

function dbForBank(workspace: string, bank: MemoryBankId, home?: string): Database {
  return bankStorageKind(bank) === "workspace" ? openWorkspaceDb(workspace) : openUserDb(home);
}

/** Test hook: replace one bank's facts in the appropriate db file. */
export function replaceMemoryIndex(
  workspace: string,
  facts: readonly string[],
  bank: MemoryBankId = PROJECT_BANK,
  home?: string,
): void {
  const dbPath = memoryDbPathForBank(workspace, bank, home);
  const db = dbForBank(workspace, bank, home);
  db.prepare(`DELETE FROM ${TABLE} WHERE bank=?`).run(bank);
  const insert = db.prepare(`INSERT INTO ${TABLE}(content, bank) VALUES (?, ?)`);
  const tx = db.transaction((rows: readonly string[]) => {
    for (const row of rows) {
      const text = row.trim();
      if (text !== "") insert.run(text, bank);
    }
  });
  tx(facts);
  closeDb(db, dbPath);
}

function reindexProjectFromManifestIfEmpty(workspace: string, db: Database): void {
  const row = db
    .query(`SELECT count(*) as n FROM ${TABLE} WHERE bank=?`)
    .get(PROJECT_BANK) as { n: number };
  if (row.n > 0) return;
  const facts: string[] = [];
  const manifest = loadMemoryManifest(workspace);
  if (manifest !== undefined) {
    for (const l of manifest.split(/\r?\n/)) {
      const line = l.replace(/^[-*]\s+/, "").trim();
      if (line.length === 0 || line.startsWith("[") || line.startsWith("> WARNING:")) continue;
      facts.push(line);
    }
  }
  for (const topic of loadMemoryTopicBodies(workspace)) facts.push(topic);
  if (facts.length === 0) return;
  const insert = db.prepare(`INSERT INTO ${TABLE}(content, bank) VALUES (?, ?)`);
  const tx = db.transaction((rows: string[]) => {
    for (const line of rows) insert.run(line, PROJECT_BANK);
  });
  tx(facts);
}

type ScoredRow = { content: string; bank: string; rank: number };

function searchOneBankScored(
  workspace: string,
  bank: MemoryBankId,
  match: string,
  limit: number,
  home?: string,
): ScoredRow[] {
  const db = dbForBank(workspace, bank, home);
  const dbPath = memoryDbPathForBank(workspace, bank, home);
  try {
    if (bank === PROJECT_BANK) reindexProjectFromManifestIfEmpty(workspace, db);
    const rows = db
      .query(
        `SELECT content, bank, bm25(${TABLE}) AS rank FROM ${TABLE} WHERE bank=? AND ${TABLE} MATCH ? ORDER BY bm25(${TABLE}) LIMIT ?`,
      )
      .all(bank, match, limit) as ScoredRow[];
    return rows;
  } catch {
    return [];
  } finally {
    closeDb(db, dbPath);
  }
}

function searchOneBank(
  workspace: string,
  bank: MemoryBankId,
  match: string,
  limit: number,
  home?: string,
  diversify = false,
): MemoryHit[] {
  const fetchLimit = diversify ? Math.max(limit * 4, limit + 4) : limit;
  const rows = searchOneBankScored(workspace, bank, match, fetchLimit, home);
  const picked = diversify
    ? mmrLiteSelect(
        rows.map((r) => ({ content: r.content, rank: r.rank, bank: r.bank })),
        limit,
      )
    : rows.slice(0, limit);
  return picked.map((r) => ({ bank: bank, content: r.content }));
}

/** BM25-ranked hits from one or more banks (default: project only). */
export function memorySearchHits(
  workspace: string,
  query: string,
  opts: MemorySearchOptions = {},
  home?: string,
): MemoryHit[] {
  const match = ftsQuery(query);
  if (match === undefined) return [];
  const limit = opts.limit ?? 8;
  const banks = opts.banks ?? [PROJECT_BANK];
  const diversify = opts.diversify === true;
  const perBank = Math.max(1, Math.ceil(limit / banks.length));
  const merged: MemoryHit[] = [];
  for (const bank of banks) {
    merged.push(...searchOneBank(workspace, bank, match, perBank, home, diversify));
  }
  return merged.slice(0, limit);
}

/** Back-compat: content strings only (project bank). */
export function memorySearch(workspace: string, query: string, limit = 8): string[] {
  return memorySearchHits(workspace, query, { limit, banks: [PROJECT_BANK] }).map((h) => h.content);
}

/** mnemopi `shared_*` ADAPT: recall across project + user + shared with bank labels. */
export function sharedMemorySearch(
  workspace: string,
  query: string,
  limit = 8,
  home?: string,
): MemoryHit[] {
  return memorySearchHits(
    workspace,
    query,
    { limit, banks: SHARED_RECALL_BANKS, diversify: true },
    home,
  );
}

export type RememberMemoryResult =
  | { ok: true; bank: MemoryBankId; memoryIndex?: "appended" | "duplicate" | "skipped" }
  | { ok: false; reason: "empty" | "too_long" | "duplicate" };

/** Append one fact to a bank's FTS partition (does not edit MEMORY.md). */
export function rememberMemoryFact(
  workspace: string,
  content: string,
  bank: MemoryBankId = PROJECT_BANK,
  home?: string,
): RememberMemoryResult {
  const text = content.trim();
  if (text === "") return { ok: false, reason: "empty" };
  if ([...text].length > MEMORY_FACT_MAX_CHARS) return { ok: false, reason: "too_long" };
  const db = dbForBank(workspace, bank, home);
  try {
    const dupe = db
      .prepare(`SELECT 1 AS n FROM ${TABLE} WHERE bank=? AND content=? LIMIT 1`)
      .get(bank, text) as { n: number } | null;
    if (dupe !== null) return { ok: false, reason: "duplicate" };
    db.prepare(`INSERT INTO ${TABLE}(content, bank) VALUES (?, ?)`).run(text, bank);
    const memoryIndex = bank === PROJECT_BANK ? appendRememberedFactToMemoryIndex(workspace, text) : "skipped";
    return { ok: true, bank, memoryIndex };
  } finally {
    closeDb(db, memoryDbPathForBank(workspace, bank, home));
  }
}

export type ForgetMemoryResult = { deleted: number; removed: string[] };

/** Remove facts by exact content and/or BM25 query (default limit 8 per call). */
export function forgetMemoryFacts(
  workspace: string,
  opts: { bank?: MemoryBankId; query?: string; content?: string; limit?: number },
  home?: string,
): ForgetMemoryResult {
  const bank = opts.bank ?? PROJECT_BANK;
  const limit = opts.limit ?? 8;
  const exact = opts.content?.trim() ?? "";
  const q = opts.query?.trim() ?? "";
  if (exact === "" && q === "") return { deleted: 0, removed: [] };

  const toDelete = new Set<string>();
  if (exact !== "") toDelete.add(exact);
  if (q !== "") {
    const match = ftsQuery(q);
    if (match !== undefined) {
      for (const row of searchOneBankScored(workspace, bank, match, limit, home)) {
        toDelete.add(row.content);
      }
    }
  }
  if (toDelete.size === 0) return { deleted: 0, removed: [] };

  const db = dbForBank(workspace, bank, home);
  try {
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE bank=? AND content=?`);
    const removed: string[] = [];
    let deleted = 0;
    const tx = db.transaction((contents: string[]) => {
      for (const c of contents) {
        const r = del.run(bank, c);
        if (r.changes > 0) {
          deleted += r.changes;
          removed.push(c);
        }
      }
    });
    tx([...toDelete]);
    return { deleted, removed };
  } finally {
    closeDb(db, memoryDbPathForBank(workspace, bank, home));
  }
}

/** Paths that must be readable for a given search scope (guard helper). */
export function memorySearchReadTargets(
  workspace: string,
  banks: readonly MemoryBankId[],
): string[] {
  const targets = new Set<string>();
  for (const bank of banks) {
    if (bankStorageKind(bank) === "workspace") {
      targets.add(memoryDbPath(workspace));
      targets.add(path.join(stateRoot(workspace), "MEMORY.md"));
    } else {
      targets.add(userMemoryDbPath());
    }
  }
  return [...targets];
}

/** Doctor / status: per-bank FTS row counts (mnemopi partitions). */
export function summarizeMemoryBanks(workspace: string, home?: string): string {
  const parts: string[] = [];
  for (const bank of MEMORY_BANKS) {
    const dbPath =
      bankStorageKind(bank) === "workspace"
        ? workspaceStateFile(workspace, "memory.db")
        : userMemoryDbPath(home);
    if (!existsSync(dbPath)) {
      parts.push(`${bank}: (no db)`);
      continue;
    }
    try {
      const db = dbForBank(workspace, bank, home);
      const row = db.query(`SELECT count(*) as n FROM ${TABLE} WHERE bank=?`).get(bank) as { n: number };
      closeDb(db, dbPath);
      parts.push(`${bank}: ${row.n} facts`);
    } catch {
      parts.push(`${bank}: unreadable`);
    }
  }
  return parts.join("; ");
}
