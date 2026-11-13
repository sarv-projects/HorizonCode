/**
 * store.ts — SQLite FTS5 recall with partitioned banks (docs/33 §5.4 partial).
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { stateRoot } from "../paths";
import {
  PROJECT_BANK,
  SHARED_RECALL_BANKS,
  type MemoryBankId,
  bankStorageKind,
  userMemoryDbPath,
} from "./banks";
import { loadMemoryManifest, loadMemoryTopicBodies } from "./manifest";
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
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath, { create: true });
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
  return db;
}

function openWorkspaceDb(workspace: string): Database {
  return openDbAt(memoryDbPath(workspace));
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
  db.close();
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
    db.close();
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
