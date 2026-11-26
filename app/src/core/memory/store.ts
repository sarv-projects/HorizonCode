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
import { loadMemoryManifest, loadMemoryTopicBodies } from "./manifest";
import { mmrLiteSelect } from "./mmr-lite";
import { assertSqliteReconcileBarrierClear } from "../session";
import { metricContract } from "../metrics";
import { sha256Hex } from "../canon";
import { reciprocalRankFusion } from "./rrf";
import { storeDayDecay } from "./decay";
import { applySupersession, factKey, type MemoryFactRow } from "./supersession";

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
  /** When true, fuse RRF + store-day decay + supersession (opt-in; default false). */
  rank?: boolean;
  /** Optional content→storedAtMs overrides used by ranked decay/supersession. */
  storedAt?: Map<string, number>;
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
  // ADDITIVE (plan Task 24): optional store-day metadata. No backfill of
  // existing FTS rows; an absent row means "unknown age" = no decay.
  db.exec(
    `CREATE TABLE IF NOT EXISTS memory_fact_meta (content_sha256 TEXT PRIMARY KEY, stored_at TEXT NOT NULL);`,
  );
  // V-20: per-bank freshness watermark for a fully rebuilt recall index.
  db.exec(
    `CREATE TABLE IF NOT EXISTS memory_index_meta (bank TEXT PRIMARY KEY, watermark TEXT NOT NULL, model_fingerprint TEXT NOT NULL);`,
  );
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

/**
 * V-20: stable fingerprint of the model that produced a recall index. Derived
 * from the active provider/model ids, not a hash of weights (which the runtime
 * cannot observe). Both ids are additive config and may be absent.
 */
export function modelVersionFingerprint(
  provider: string | undefined,
  model: string | undefined,
): string {
  return `${provider?.trim() || "unknown"}:${model?.trim() || "unknown"}`;
}

/** V-20: deterministic watermark of the facts and the model fingerprint. */
export function memoryIndexWatermark(
  facts: readonly string[],
  modelFingerprint: string,
): string {
  const normalized = [...facts].map((f) => f.trim()).filter((f) => f !== "").sort();
  return sha256Hex(JSON.stringify({ facts: normalized, modelFingerprint }));
}

/** V-20: freshness metadata for a bank's rebuilt recall index, or undefined. */
export function memoryIndexMeta(
  workspace: string,
  bank: MemoryBankId = PROJECT_BANK,
  home?: string,
): { watermark: string; modelFingerprint: string } | undefined {
  const dbPath = memoryDbPathForBank(workspace, bank, home);
  const db = dbForBank(workspace, bank, home);
  try {
    const row = db
      .query(`SELECT watermark, model_fingerprint FROM memory_index_meta WHERE bank=?`)
      .get(bank) as { watermark: string; model_fingerprint: string } | null;
    return row === null
      ? undefined
      : { watermark: row.watermark, modelFingerprint: row.model_fingerprint };
  } finally {
    closeDb(db, dbPath);
  }
}

/**
 * V-20 (ruling 930): refresh a bank's watermark once per incremental call,
 * preserving whatever model fingerprint a full rebuild recorded. The rescan is
 * per CALL, not per fact (a per-fact scan was rejected as a perf regression).
 */
function refreshIndexWatermark(db: Database, bank: MemoryBankId): void {
  const meta = db
    .query(`SELECT model_fingerprint FROM memory_index_meta WHERE bank=?`)
    .get(bank) as { model_fingerprint: string } | null;
  const fingerprint = meta?.model_fingerprint ?? "unknown";
  const rows = db
    .query(`SELECT content FROM ${TABLE} WHERE bank=?`)
    .all(bank) as Array<{ content: string }>;
  db.prepare(
    `INSERT INTO memory_index_meta(bank, watermark, model_fingerprint) VALUES (?, ?, ?)
     ON CONFLICT(bank) DO UPDATE SET watermark=excluded.watermark, model_fingerprint=excluded.model_fingerprint`,
  ).run(bank, memoryIndexWatermark(rows.map((row) => row.content), fingerprint), fingerprint);
}

/** Test hook: replace one bank's facts in the appropriate db file. */
export function replaceMemoryIndex(
  workspace: string,
  facts: readonly string[],
  bank: MemoryBankId = PROJECT_BANK,
  home?: string,
  opts?: { modelFingerprint?: string },
): void {
  assertSqliteReconcileBarrierClear("memory.store.replaceMemoryIndex");
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
  const fingerprint =
    opts?.modelFingerprint ??
    modelVersionFingerprint(process.env.HZ_PROVIDER, process.env.HZ_MODEL);
  db.prepare(
    `INSERT INTO memory_index_meta(bank, watermark, model_fingerprint) VALUES (?, ?, ?)
     ON CONFLICT(bank) DO UPDATE SET watermark=excluded.watermark, model_fingerprint=excluded.model_fingerprint`,
  ).run(bank, memoryIndexWatermark(facts, fingerprint), fingerprint);
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

/** Store-day lookup by content hash; absent row or bad timestamp = unknown. */
function metaStoredAt(
  workspace: string,
  bank: MemoryBankId,
  content: string,
  home?: string,
): number | undefined {
  const db = dbForBank(workspace, bank, home);
  try {
    const row = db
      .query("SELECT stored_at FROM memory_fact_meta WHERE content_sha256 = ?")
      .get(sha256Hex(content)) as { stored_at: string } | null;
    if (row === null) return undefined;
    const ms = Date.parse(row.stored_at);
    return Number.isNaN(ms) ? undefined : ms;
  } catch {
    return undefined;
  } finally {
    closeDb(db, memoryDbPathForBank(workspace, bank, home));
  }
}

/**
 * Opt-in additive ranking (plan Task 24): RRF-fuse per-bank BM25 lists, apply
 * store-day decay and lexical supersession. `rank` absent/false delegates to
 * `memorySearchHits` byte-identically. No embeddings, no contract change.
 */
export function memorySearchRanked(
  workspace: string,
  query: string,
  opts: MemorySearchOptions & { nowMs?: number } = {},
  home?: string,
): MemoryHit[] {
  if (opts.rank !== true) return memorySearchHits(workspace, query, opts, home);
  const match = ftsQuery(query);
  if (match === undefined) return [];
  const limit = opts.limit ?? 8;
  const banks = opts.banks ?? [PROJECT_BANK];
  const perBank = Math.max(1, Math.ceil(limit / banks.length));

  const rankings: string[][] = [];
  const bankByContent = new Map<string, MemoryBankId>();
  for (const bank of banks) {
    const rows = searchOneBankScored(workspace, bank, match, perBank, home);
    rankings.push(rows.map((r) => r.content));
    for (const row of rows) {
      if (!bankByContent.has(row.content)) bankByContent.set(row.content, bank);
    }
  }

  const nowMs = opts.nowMs ?? Date.now();
  const scored = reciprocalRankFusion(rankings)
    .map((fused) => {
      const override = opts.storedAt?.get(fused.id);
      const storedAtMs = override ?? metaStoredAt(
        workspace,
        bankByContent.get(fused.id) ?? PROJECT_BANK,
        fused.id,
        home,
      );
      const score = fused.score * (storedAtMs === undefined ? 1 : storeDayDecay(1, storedAtMs, nowMs));
      return { id: fused.id, score, storedAtMs };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const factRows: MemoryFactRow[] = scored.map((s) => ({
    id: s.id,
    content: s.id,
    storedAtMs: s.storedAtMs ?? 0,
  }));
  const { active } = applySupersession(factRows);
  return active.slice(0, limit).map((fact) => ({
    bank: bankByContent.get(fact.id) ?? PROJECT_BANK,
    content: fact.content,
  }));
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
  assertSqliteReconcileBarrierClear("memory.store.rememberMemoryFact");
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
    db.prepare(
      `INSERT INTO memory_fact_meta (content_sha256, stored_at) VALUES (?, ?) ON CONFLICT(content_sha256) DO NOTHING`,
    ).run(sha256Hex(text), new Date().toISOString());
    refreshIndexWatermark(db, bank);
    // MEMORY.md sync is opt-in and must be Guard-admitted by the tool layer
    // (`memory_remember`) — never append from the store path.
    return { ok: true, bank, memoryIndex: "skipped" as const };
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
  assertSqliteReconcileBarrierClear("memory.store.forgetMemoryFacts");
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
    if (deleted > 0) refreshIndexWatermark(db, bank);
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

export type MemoryBankFactCount =
  | { bank: MemoryBankId; status: "missing" }
  | { bank: MemoryBankId; status: "unreadable" }
  | { bank: MemoryBankId; status: "ok"; facts: number };

/** Shared inspect for doctor human + H-7 publication. */
export function inspectMemoryBanks(workspace: string, home?: string): MemoryBankFactCount[] {
  const out: MemoryBankFactCount[] = [];
  for (const bank of MEMORY_BANKS) {
    const dbPath =
      bankStorageKind(bank) === "workspace"
        ? workspaceStateFile(workspace, "memory.db")
        : userMemoryDbPath(home);
    if (!existsSync(dbPath)) {
      out.push({ bank, status: "missing" });
      continue;
    }
    try {
      const db = dbForBank(workspace, bank, home);
      const row = db.query(`SELECT count(*) as n FROM ${TABLE} WHERE bank=?`).get(bank) as { n: number };
      closeDb(db, dbPath);
      out.push({ bank, status: "ok", facts: row.n });
    } catch {
      out.push({ bank, status: "unreadable" });
    }
  }
  return out;
}

/** Doctor / status: per-bank FTS row counts (mnemopi partitions). */
export function summarizeMemoryBanks(workspace: string, home?: string): string {
  return inspectMemoryBanks(workspace, home)
    .map((row) => {
      if (row.status === "missing") return `${row.bank}: (no db)`;
      if (row.status === "unreadable") return `${row.bank}: unreadable`;
      return `${row.bank}: ${row.facts} facts`;
    })
    .join("; ");
}

/**
 * H-7 parallel surface for memory bank fact counts (ruling 546).
 * Human `summarizeMemoryBanks` stays byte-identical.
 */
export function memoryBanksPublication(workspace: string, home?: string): string[] {
  const rows = inspectMemoryBanks(workspace, home);
  const anchor = "none — first memory-banks inspect (no prior report of this workspace to compare against)";
  const population = `memory FTS banks for workspace ${workspace}`;
  const excludes = "missing/unreadable banks report status rather than a fact count; nothing discarded from the bank list";
  const blocks: string[] = [
    metricContract({
      metric: "memory banks inspected",
      anchor,
      population,
      excludes,
      value: rows.length,
    }),
  ];
  for (const row of rows) {
    if (row.status === "ok") {
      blocks.push(
        metricContract({
          metric: `memory bank ${row.bank} facts`,
          anchor,
          population,
          excludes,
          value: row.facts,
        }),
      );
    } else {
      blocks.push(
        metricContract({
          metric: `memory bank ${row.bank} status`,
          anchor,
          population,
          excludes,
          value: row.status,
        }),
      );
    }
  }
  return blocks;
}

export interface StoredMemoryFact {
  /** Stable SHA-256 content identifier. */
  id: string;
  bank: MemoryBankId;
  content: string;
  storedAt?: string;
  storedAtMs: number;
}

/** Read all indexed facts (with optional store-day timestamps) for a bank. */
export function listMemoryFacts(
  workspace: string,
  bank: MemoryBankId = PROJECT_BANK,
  home?: string,
): StoredMemoryFact[] {
  const dbPath = memoryDbPathForBank(workspace, bank, home);
  if (!existsSync(dbPath)) return [];
  const db = dbForBank(workspace, bank, home);
  try {
    const rows = db
      .query(`SELECT content FROM ${TABLE} WHERE bank=?`)
      .all(bank) as Array<{ content: string }>;
    const metaRows = db
      .query(`SELECT content_sha256, stored_at FROM memory_fact_meta`)
      .all() as Array<{ content_sha256: string; stored_at: string }>;
    const metaByHash = new Map<string, string>();
    for (const m of metaRows) metaByHash.set(m.content_sha256, m.stored_at);
    return rows
      .map((r) => r.content.trim())
      .filter((c) => c.length > 0)
      .map((content) => {
        const id = sha256Hex(content);
        const storedAt = metaByHash.get(id);
        const parsed = storedAt !== undefined ? Date.parse(storedAt) : Number.NaN;
        return {
          id,
          bank,
          content,
          ...(storedAt !== undefined ? { storedAt } : {}),
          storedAtMs: Number.isNaN(parsed) ? 0 : parsed,
        };
      });
  } finally {
    closeDb(db, dbPath);
  }
}

export type MemoryDeltaOp = "UPSERT" | "SUPERSEDE" | "DELETE";

export interface MemoryDelta {
  op: MemoryDeltaOp;
  /** Optional content SHA-256 id (or exact content) of the target fact. */
  id?: string;
  /** Normalized lexical key (from `factKey`). */
  key: string;
  /** Fact content (new text for UPSERT/SUPERSEDE, target text for DELETE). */
  text: string;
  /** Human-readable reason for emitting this delta. */
  reason: string;
  /** Optional previous content being replaced by SUPERSEDE. */
  replaces?: string;
  /** Optional ISO-8601 timestamp to store in `memory_fact_meta`. */
  storedAt?: string;
}

export interface ApplyMemoryDeltasResult {
  applied: number;
  upserted: number;
  superseded: number;
  deleted: number;
  skipped: number;
}

/**
 * Apply itemized SQLite memory deltas (`UPSERT` | `SUPERSEDE` | `DELETE`)
 * atomically in a single transaction, respecting `HZ_R170_SQLITE_BARRIER=1`.
 * Never rewrites monolithic Markdown files.
 */
export function applyMemoryDeltas(
  workspace: string,
  deltas: readonly MemoryDelta[],
  opts: { bank?: MemoryBankId; home?: string; nowIso?: string } = {},
): ApplyMemoryDeltasResult {
  assertSqliteReconcileBarrierClear("memory.store.applyMemoryDeltas");
  if (deltas.length === 0) {
    return { applied: 0, upserted: 0, superseded: 0, deleted: 0, skipped: 0 };
  }
  const bank = opts.bank ?? PROJECT_BANK;
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const dbPath = memoryDbPathForBank(workspace, bank, opts.home);
  const db = dbForBank(workspace, bank, opts.home);

  try {
    const selectAll = db.prepare(`SELECT content FROM ${TABLE} WHERE bank=?`);
    const existsStmt = db.prepare(`SELECT 1 AS n FROM ${TABLE} WHERE bank=? AND content=? LIMIT 1`);
    const insertFts = db.prepare(`INSERT INTO ${TABLE}(content, bank) VALUES (?, ?)`);
    const deleteFts = db.prepare(`DELETE FROM ${TABLE} WHERE bank=? AND content=?`);
    const upsertMeta = db.prepare(
      `INSERT INTO memory_fact_meta (content_sha256, stored_at) VALUES (?, ?)
       ON CONFLICT(content_sha256) DO UPDATE SET stored_at=excluded.stored_at`,
    );
    const deleteMeta = db.prepare(`DELETE FROM memory_fact_meta WHERE content_sha256=?`);

    let applied = 0;
    let upserted = 0;
    let superseded = 0;
    let deleted = 0;
    let skipped = 0;

    const findById = (id: string): string[] => {
      const rows = selectAll.all(bank) as Array<{ content: string }>;
      return rows
        .map((r) => r.content)
        .filter((c) => c === id || sha256Hex(c) === id);
    };

    const findByKey = (key: string): string[] => {
      if (key === "") return [];
      const rows = selectAll.all(bank) as Array<{ content: string }>;
      return rows.map((r) => r.content).filter((c) => factKey(c) === key);
    };

    const tx = db.transaction((items: readonly MemoryDelta[]) => {
      for (const delta of items) {
        const text = delta.text.trim();
        const ts = delta.storedAt ?? nowIso;

        if (delta.op === "UPSERT") {
          if (text === "" || [...text].length > MEMORY_FACT_MAX_CHARS) {
            skipped += 1;
            continue;
          }
          const dupe = existsStmt.get(bank, text) as { n: number } | null;
          if (dupe !== null) {
            skipped += 1;
            continue;
          }
          insertFts.run(text, bank);
          upsertMeta.run(sha256Hex(text), ts);
          upserted += 1;
          applied += 1;
          continue;
        }

        if (delta.op === "SUPERSEDE") {
          if (text === "" || [...text].length > MEMORY_FACT_MAX_CHARS) {
            skipped += 1;
            continue;
          }
          const targets = new Set<string>();
          if (delta.replaces && delta.replaces.trim() !== "") {
            targets.add(delta.replaces.trim());
          } else if (delta.id && delta.id.trim() !== "") {
            for (const c of findById(delta.id.trim())) targets.add(c);
          } else if (delta.key.trim() !== "") {
            for (const c of findByKey(delta.key.trim())) targets.add(c);
          }
          for (const oldContent of targets) {
            if (oldContent === text) continue;
            deleteFts.run(bank, oldContent);
            deleteMeta.run(sha256Hex(oldContent));
          }
          const dupe = existsStmt.get(bank, text) as { n: number } | null;
          if (dupe === null) {
            insertFts.run(text, bank);
          }
          upsertMeta.run(sha256Hex(text), ts);
          superseded += 1;
          applied += 1;
          continue;
        }

        if (delta.op === "DELETE") {
          const targets = new Set<string>();
          if (text !== "") targets.add(text);
          if (delta.id && delta.id.trim() !== "") {
            for (const c of findById(delta.id.trim())) targets.add(c);
          }
          let removedHere = 0;
          for (const target of targets) {
            const res = deleteFts.run(bank, target);
            if (res.changes > 0) {
              removedHere += res.changes;
              deleteMeta.run(sha256Hex(target));
            }
          }
          if (removedHere > 0) {
            deleted += removedHere;
            applied += 1;
          } else {
            skipped += 1;
          }
        }
      }
    });

    tx(deltas);
    if (applied > 0) refreshIndexWatermark(db, bank);
    return { applied, upserted, superseded, deleted, skipped };
  } finally {
    closeDb(db, dbPath);
  }
}

export {
  buildStartupMemoryMap,
  maybeScheduleAutoDream,
  runAutoDream,
  shouldRunAutoDream,
  type AutoDreamGateDecision,
  type AutoDreamHandle,
  type AutoDreamRunOptions,
  type AutoDreamRunResult,
  type AutoDreamScheduleOptions,
  type StartupMemoryMapOptions,
  type StartupMemoryMapResult,
} from "./auto-dream";
