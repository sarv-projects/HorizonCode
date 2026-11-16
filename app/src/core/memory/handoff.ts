/**
 * handoff.ts — Engram-style session handoffs (docs/30 §8 #3 ADAPT).
 *
 * SQLite rows + FTS5 BM25 over per-section text (no embeddings). Stored under
 * `.hz/state/handoffs.db`. Branch scope prefers git; non-git workspaces use
 * `detached:<id>`.
 */

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import {
  chmodSqliteFiles,
  ensurePrivateDir,
  ensureWorkspaceStateDir,
  existingWorkspaceStateFile,
  workspaceStateDir,
  workspaceStateFile,
} from "../paths";
import { mmrLiteSelect, type ScoredMemoryCandidate } from "./mmr-lite";

export const SECTION_SOFT_CAP_CHARS = 5000;
export const SECTION_ITEM_SOFT_CAP_CHARS = 1000;
export const HANDOFF_CHAIN_MAX = 5;
export const DEFAULT_RESUME_SECTION_CHARS = 1500;

const HANDOFFS = "handoffs";
const FTS = "handoff_section_fts";
export const DURABLE_TODOS = "durable_todos";

export type HandoffListSections = {
  tried?: string[];
  next?: string[];
  blockers?: string[];
  decisions?: string[];
};

export type HandoffInputSections = HandoffListSections & {
  summary: string;
  files?: string;
  context?: string;
  continues_from?: string | null;
  /** Refused at create time — durable todos use the todo tool. */
  todos?: unknown;
};

export type HandoffCreateResult = {
  id: string;
  branch: string;
  continues_from: string | null;
  /** Session that created this handoff (Engram session link). */
  session_id: string | null;
  warnings: string[];
};

export type HandoffSectionMatch = {
  handoff_id: string;
  section_name: string;
  section_text: string;
  score: number;
};

export type HandoffResumeResult = {
  branch: string;
  latest_handoff_id: string | null;
  /** Oldest → newest, capped at HANDOFF_CHAIN_MAX. */
  chain: string[];
  top_sections: HandoffSectionMatch[];
  open_blockers: string[];
  /** Open session todos snapshotted when the latest handoff was created (informational; not live todos). */
  snapshotted_todos: string[];
  /** Session that authored the resumed handoff row, when recorded. */
  source_session_id: string | null;
  message: string | null;
};

export type HandoffSearchResult = {
  matches: HandoffSectionMatch[];
};

/** The handoff store: `<workspace>/.hz/state/handoffs.db` (legacy `.hz/` copied on open). */
export function handoffDbPath(workspace: string): string {
  return path.join(workspaceStateDir(workspace), "handoffs.db");
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

function workspaceScopeId(workspace: string): string {
  const norm = path.resolve(workspace);
  return createHash("sha256").update(norm).digest("hex").slice(0, 12);
}

/** Prefer git branch; non-git → `detached:<hash>`. */
export function resolveHandoffBranch(workspace: string, override?: string): { branch: string; detached: boolean } {
  const o = override?.trim();
  if (o !== undefined && o !== "") return { branch: o, detached: false };
  try {
    const res = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 2000,
    });
    if (res.status === 0) {
      const b = res.stdout.trim();
      if (b !== "" && b !== "HEAD") return { branch: b, detached: false };
    }
  } catch {
    /* non-git or missing git */
  }
  return { branch: `detached:${workspaceScopeId(workspace)}`, detached: true };
}

function openDb(workspace: string, readonly = false): Database | null {
  const dbPath = readonly
    ? existingWorkspaceStateFile(workspace, "handoffs.db")
    : workspaceStateFile(workspace, "handoffs.db");
  // Diagnose-only callers (hzcode doctor) must not create `.hz/state` or the
  // self-ignore just to discover there is no handoff database. Check the file
  // before any directory creation; a read-only open of a missing DB is null.
  if (readonly && !existsSync(dbPath)) return null;
  ensureWorkspaceStateDir(workspace);
  ensurePrivateDir(path.dirname(dbPath));
  const db = new Database(dbPath, readonly ? { readonly: true } : { create: true });
  chmodSqliteFiles(dbPath);
  if (!readonly) {
    db.exec(`
CREATE TABLE IF NOT EXISTS ${HANDOFFS} (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  continues_from TEXT,
  summary TEXT NOT NULL,
  tried TEXT NOT NULL DEFAULT '[]',
  next_steps TEXT NOT NULL DEFAULT '[]',
  blockers TEXT NOT NULL DEFAULT '[]',
  decisions TEXT NOT NULL DEFAULT '[]',
  files TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  todos TEXT NOT NULL DEFAULT '[]',
  session_id TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS} USING fts5(
  handoff_id UNINDEXED,
  branch UNINDEXED,
  section_name,
  section_text,
  tokenize='porter'
);
CREATE TABLE IF NOT EXISTS ${DURABLE_TODOS} (
  branch TEXT NOT NULL,
  todo_id TEXT NOT NULL,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  dropped INTEGER NOT NULL DEFAULT 0,
  drop_reason TEXT,
  PRIMARY KEY (branch, todo_id)
);
`);
    migrateHandoffTodosColumn(db);
    migrateHandoffSessionColumn(db);
    chmodSqliteFiles(dbPath);
  }
  return db;
}

function closeDb(db: Database, dbPath: string): void {
  try {
    chmodSqliteFiles(dbPath);
  } finally {
    db.close();
  }
}

/** Run a callback against the workspace handoff DB (schema ensured on write). */
export function withHandoffDb<T>(
  workspace: string,
  readonly: boolean,
  fn: (db: Database) => T,
): T | null {
  const db = openDb(workspace, readonly);
  if (!db) return null;
  try {
    return fn(db);
  } finally {
    closeDb(db, handoffDbPath(workspace));
  }
}

function migrateHandoffTodosColumn(db: Database): void {
  const cols = db.query("PRAGMA table_info(handoffs)").all() as { name: string }[];
  if (cols.some((c) => c.name === "todos")) return;
  db.run("ALTER TABLE handoffs ADD COLUMN todos TEXT NOT NULL DEFAULT '[]'");
}

function migrateHandoffSessionColumn(db: Database): void {
  const cols = db.query("PRAGMA table_info(handoffs)").all() as { name: string }[];
  if (cols.some((c) => c.name === "session_id")) return;
  db.run("ALTER TABLE handoffs ADD COLUMN session_id TEXT");
}

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

type StoredHandoff = {
  id: string;
  branch: string;
  created_at: number;
  continues_from: string | null;
  summary: string;
  tried: string[];
  next_steps: string[];
  blockers: string[];
  decisions: string[];
  files: string;
  context: string;
  /** Open session todos snapshotted at create time (not accepted via tool `todos` args). */
  todos: string[];
  session_id: string | null;
};

function rowToHandoff(row: Record<string, unknown>): StoredHandoff {
  return {
    id: String(row.id),
    branch: String(row.branch),
    created_at: Number(row.created_at),
    continues_from: row.continues_from != null ? String(row.continues_from) : null,
    session_id: typeof row.session_id === "string" && row.session_id !== "" ? row.session_id : null,
    summary: String(row.summary),
    tried: parseJsonArray(String(row.tried)),
    next_steps: parseJsonArray(String(row.next_steps)),
    blockers: parseJsonArray(String(row.blockers)),
    decisions: parseJsonArray(String(row.decisions)),
    files: String(row.files ?? ""),
    context: String(row.context ?? ""),
    todos: parseJsonArray(String(row.todos ?? "[]")),
  };
}

function listSectionTexts(h: StoredHandoff): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  if (h.summary.trim() !== "") out.push({ name: "summary", text: h.summary });
  if (h.decisions.length > 0) out.push({ name: "decisions", text: h.decisions.join("\n") });
  if (h.blockers.length > 0) out.push({ name: "blockers", text: h.blockers.join("\n") });
  if (h.tried.length > 0) out.push({ name: "tried", text: h.tried.join("\n") });
  if (h.next_steps.length > 0) out.push({ name: "next", text: h.next_steps.join("\n") });
  if (h.files.trim() !== "") out.push({ name: "files", text: h.files });
  if (h.context.trim() !== "") out.push({ name: "context", text: h.context });
  if (h.todos.length > 0) out.push({ name: "todos", text: h.todos.join("\n") });
  return out;
}

export function collectSectionWarnings(sections: HandoffInputSections): string[] {
  const warnings: string[] = [];
  const texts = listSectionTexts(normalizeForWarnings(sections));
  const oversized = texts
    .filter(({ text }) => [...text].length > SECTION_SOFT_CAP_CHARS)
    .map(({ name, text }) => `${name} (${[...text].length} chars)`);
  if (oversized.length > 0) {
    warnings.push(
      `Oversized section(s): ${oversized.join(", ")}. Cap is ${SECTION_SOFT_CAP_CHARS} chars/section; stored anyway — keep sections as brief recaps.`,
    );
  }
  const lists: Array<[string, string[]]> = [
    ["decisions", sections.decisions ?? []],
    ["blockers", sections.blockers ?? []],
    ["tried", sections.tried ?? []],
    ["next", sections.next ?? []],
  ];
  const bigItems: string[] = [];
  for (const [key, list] of lists) {
    list.forEach((item, i) => {
      if ([...item].length > SECTION_ITEM_SOFT_CAP_CHARS) {
        bigItems.push(`${key}[${i}] (${[...item].length} chars)`);
      }
    });
  }
  if (bigItems.length > 0) {
    warnings.push(
      `Oversized list item(s): ${bigItems.join(", ")}. Cap ${SECTION_ITEM_SOFT_CAP_CHARS} chars/item; stored anyway.`,
    );
  }
  return warnings;
}

function normalizeForWarnings(sections: HandoffInputSections): StoredHandoff {
  return {
    id: "",
    branch: "",
    created_at: 0,
    continues_from: null,
    summary: sections.summary,
    tried: sections.tried ?? [],
    next_steps: sections.next ?? [],
    blockers: sections.blockers ?? [],
    decisions: sections.decisions ?? [],
    files: sections.files ?? "",
    context: sections.context ?? "",
    todos: [],
    session_id: null,
  };
}

function normalizeList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const t = value.trim();
    return t === "" ? [] : [t];
  }
  if (Array.isArray(value)) {
    return value.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter((s) => s !== "");
  }
  return undefined;
}

export function normalizeHandoffSections(raw: Record<string, unknown>): HandoffInputSections | { error: string } {
  if (raw.todos !== undefined) {
    return { error: "todos section is not supported; use the todo tool for durable work items" };
  }
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (summary === "") return { error: "summary is required" };
  const continues_from =
    raw.continues_from === null
      ? null
      : typeof raw.continues_from === "string"
        ? raw.continues_from.trim() || null
        : undefined;
  return {
    summary,
    tried: normalizeList(raw.tried),
    next: normalizeList(raw.next),
    blockers: normalizeList(raw.blockers),
    decisions: normalizeList(raw.decisions),
    files: typeof raw.files === "string" ? raw.files : undefined,
    context: typeof raw.context === "string" ? raw.context : undefined,
    continues_from,
  };
}

function indexHandoffSections(
  db: Database,
  handoffId: string,
  branch: string,
  sections: StoredHandoff,
): void {
  db.run(`DELETE FROM ${FTS} WHERE handoff_id = ?`, [handoffId]);
  const insert = db.prepare(
    `INSERT INTO ${FTS} (handoff_id, branch, section_name, section_text) VALUES (?, ?, ?, ?)`,
  );
  for (const { name, text } of listSectionTexts(sections)) {
    if (text.trim() === "") continue;
    insert.run(handoffId, branch, name, text);
  }
}

function latestHandoffIdOnBranch(db: Database, branch: string): string | null {
  const row = db
    .query(`SELECT id FROM ${HANDOFFS} WHERE branch = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(branch) as { id: string } | null;
  return row?.id ?? null;
}

/** Test hook: wipe handoff tables. */
export function resetHandoffsForTests(workspace: string): void {
  const db = openDb(workspace);
  try {
    db.exec(`DELETE FROM ${FTS}; DELETE FROM ${HANDOFFS}; DELETE FROM ${DURABLE_TODOS};`);
  } finally {
    closeDb(db, handoffDbPath(workspace));
  }
}

export function createHandoff(
  workspace: string,
  sections: HandoffInputSections,
  opts?: {
    branch?: string;
    continues_from?: string | null;
    auto_continue?: boolean;
    todos_snapshot?: string[];
    session_id?: string;
  },
): HandoffCreateResult {
  const { branch } = resolveHandoffBranch(workspace, opts?.branch);
  const warnings = collectSectionWarnings(sections);
  const id = `hnd_${randomUUID().replace(/-/g, "")}`;
  const now = Date.now();
  const tried = sections.tried ?? [];
  const next_steps = sections.next ?? [];
  const blockers = sections.blockers ?? [];
  const decisions = sections.decisions ?? [];
  const files = sections.files ?? "";
  const context = sections.context ?? "";
  const todos = (opts?.todos_snapshot ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  const sessionId =
    typeof opts?.session_id === "string" && opts.session_id.trim() !== "" ? opts.session_id.trim() : null;

  const db = openDb(workspace);
  try {
    let continues_from: string | null = null;
    if (opts?.continues_from !== undefined) {
      continues_from = opts.continues_from;
    } else if (sections.continues_from !== undefined) {
      continues_from = sections.continues_from;
    } else if (opts?.auto_continue !== false) {
      continues_from = latestHandoffIdOnBranch(db, branch);
    }

    db.transaction(() => {
      db.run(
        `INSERT INTO ${HANDOFFS}
         (id, branch, created_at, continues_from, session_id, summary, tried, next_steps, blockers, decisions, files, context, todos)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          branch,
          now,
          continues_from,
          sessionId,
          sections.summary,
          JSON.stringify(tried),
          JSON.stringify(next_steps),
          JSON.stringify(blockers),
          JSON.stringify(decisions),
          files,
          context,
          JSON.stringify(todos),
        ],
      );
      indexHandoffSections(
        db,
        id,
        branch,
        rowToHandoff({
          id,
          branch,
          created_at: now,
          continues_from,
          session_id: sessionId,
          summary: sections.summary,
          tried: JSON.stringify(tried),
          next_steps: JSON.stringify(next_steps),
          blockers: JSON.stringify(blockers),
          decisions: JSON.stringify(decisions),
          files,
          context,
          todos: JSON.stringify(todos),
        }),
      );
    })();
    return { id, branch, continues_from, session_id: sessionId, warnings };
  } finally {
    closeDb(db, handoffDbPath(workspace));
  }
}

function getHandoff(db: Database, id: string): StoredHandoff | null {
  const row = db.query(`SELECT * FROM ${HANDOFFS} WHERE id = ?`).get(id) as Record<string, unknown> | null;
  return row ? rowToHandoff(row) : null;
}

function latestHandoff(db: Database, branch: string): StoredHandoff | null {
  const row = db
    .query(`SELECT * FROM ${HANDOFFS} WHERE branch = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(branch) as Record<string, unknown> | null;
  return row ? rowToHandoff(row) : null;
}

function walkChain(db: Database, startId: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null = startId;
  while (current !== null && chain.length < HANDOFF_CHAIN_MAX) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    const h = getHandoff(db, current);
    if (h === null) break;
    current = h.continues_from;
  }
  chain.reverse();
  return chain;
}

function truncateSectionText(text: string, maxChars: number): string {
  const chars = [...text];
  if (maxChars <= 0 || chars.length <= maxChars) return text;
  const marker = `\n… [truncated, ${chars.length} chars total]`;
  const markerLen = [...marker].length;
  const budget = Math.max(0, maxChars - markerLen);
  const head = chars.slice(0, budget).join("");
  return `${head}${marker}`;
}

type HandoffMmrCandidate = ScoredMemoryCandidate & { match: HandoffSectionMatch };

function diversifyHandoffSections(matches: HandoffSectionMatch[], limit: number): HandoffSectionMatch[] {
  if (matches.length <= limit) return matches;
  const picked = mmrLiteSelect<HandoffMmrCandidate>(
    matches.map((m) => ({ content: m.section_text, rank: -m.score, match: m })),
    limit,
  );
  return picked.map((p) => p.match);
}

function bm25SectionSearch(
  db: Database,
  query: string,
  branch: string | null,
  handoffIds: readonly string[] | null,
  limit: number,
  sectionFilter?: readonly string[],
  diversify = false,
): HandoffSectionMatch[] {
  const match = ftsQuery(query);
  if (match === undefined) return [];
  const filterLower = sectionFilter?.map((s) => s.toLowerCase()) ?? null;
  try {
    let sql = `
SELECT handoff_id, section_name, section_text, bm25(${FTS}) AS rank
FROM ${FTS}
WHERE ${FTS} MATCH ?`;
    const params: Array<string | number> = [match];
    if (branch !== null) {
      sql += ` AND branch = ?`;
      params.push(branch);
    }
    if (handoffIds !== null && handoffIds.length > 0) {
      sql += ` AND handoff_id IN (${handoffIds.map(() => "?").join(",")})`;
      params.push(...handoffIds);
    }
    sql += ` ORDER BY rank LIMIT ?`;
    params.push(Math.min(limit * 4, 200));
    const rows = db.query(sql).all(...params) as Array<{
      handoff_id: string;
      section_name: string;
      section_text: string;
      rank: number;
    }>;
    const scored: HandoffSectionMatch[] = [];
    for (const r of rows) {
      if (filterLower !== null && !filterLower.includes(r.section_name.toLowerCase())) continue;
      scored.push({
        handoff_id: r.handoff_id,
        section_name: r.section_name,
        section_text: r.section_text,
        score: -Number(r.rank),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    if (diversify && scored.length > limit) return diversifyHandoffSections(scored, limit);
    return scored.slice(0, limit);
  } catch {
    return [];
  }
}

export function resumeHandoff(
  workspace: string,
  opts?: {
    branch?: string;
    handoff_id?: string;
    query?: string;
    max_sections?: number;
    max_chars_per_section?: number;
    /** Lexical MMR over BM25 candidates (default on when `query` is set). */
    diversify?: boolean;
  },
): HandoffResumeResult {
  const { branch, detached } = resolveHandoffBranch(workspace, opts?.branch);
  const maxSections = opts?.max_sections ?? 5;
  const charCap = opts?.max_chars_per_section ?? DEFAULT_RESUME_SECTION_CHARS;
  const db = openDb(workspace, true);
  if (db === null) {
    return {
      branch,
      latest_handoff_id: null,
      chain: [],
      top_sections: [],
      open_blockers: [],
      snapshotted_todos: [],
      source_session_id: null,
      message: detached
        ? "No git branch; using detached workspace scope. No handoffs found yet."
        : null,
    };
  }
  try {
    const start =
      opts?.handoff_id !== undefined && opts.handoff_id.trim() !== ""
        ? getHandoff(db, opts.handoff_id.trim())
        : latestHandoff(db, branch);
    if (start === null) {
      return {
        branch,
        latest_handoff_id: null,
        chain: [],
        top_sections: [],
        open_blockers: [],
        snapshotted_todos: [],
        source_session_id: null,
        message: detached
          ? "No git branch; using detached workspace scope. No handoffs found yet."
          : null,
      };
    }
    const chain = walkChain(db, start.id);
    const open_blockers = start.blockers;
    let top_sections: HandoffSectionMatch[] = [];
    const q = opts?.query?.trim() ?? "";
    if (q !== "") {
      const diversify = opts?.diversify !== false;
      top_sections = bm25SectionSearch(db, q, branch, chain, maxSections, undefined, diversify);
    } else {
      const texts = listSectionTexts(start);
      top_sections = texts.slice(0, maxSections).map((s) => ({
        handoff_id: start.id,
        section_name: s.name,
        section_text: s.text,
        score: 1,
      }));
    }
    if (charCap > 0) {
      top_sections = top_sections.map((m) => ({
        ...m,
        section_text: truncateSectionText(m.section_text, charCap),
      }));
    }
    return {
      branch,
      latest_handoff_id: start.id,
      chain,
      top_sections,
      open_blockers,
      snapshotted_todos: start.todos,
      source_session_id: start.session_id,
      message: detached ? "No git branch; using detached workspace scope." : null,
    };
  } finally {
    closeDb(db, handoffDbPath(workspace));
  }
}

export type HandoffStoreSummary = {
  branch: string;
  handoffRows: number;
  ftsRows: number;
  durableTodoRows: number;
  durableTodoBranches: number;
};

/** Read-only counts for doctor / status (no side effects). */
export function summarizeHandoffStore(workspace: string): HandoffStoreSummary | null {
  const { branch } = resolveHandoffBranch(workspace);
  const summary = withHandoffDb(workspace, true, (db) => {
    const handoffRows = Number((db.query(`SELECT COUNT(*) AS c FROM ${HANDOFFS}`).get() as { c: number }).c);
    const ftsRows = Number((db.query(`SELECT COUNT(*) AS c FROM ${FTS}`).get() as { c: number }).c);
    const durableTodoRows = Number((db.query(`SELECT COUNT(*) AS c FROM ${DURABLE_TODOS}`).get() as { c: number }).c);
    const durableTodoBranches = Number(
      (db.query(`SELECT COUNT(DISTINCT branch) AS c FROM ${DURABLE_TODOS}`).get() as { c: number }).c,
    );
    return { branch, handoffRows, ftsRows, durableTodoRows, durableTodoBranches };
  });
  return summary ?? null;
}

export function searchHandoffs(
  workspace: string,
  query: string,
  opts?: { branch?: string; limit?: number; section_filter?: string[]; diversify?: boolean },
): HandoffSearchResult {
  const { branch } = resolveHandoffBranch(workspace, opts?.branch);
  const limit = opts?.limit ?? 10;
  const diversify = opts?.diversify !== false;
  const db = openDb(workspace, true);
  if (db === null) return { matches: [] };
  try {
    const matches = bm25SectionSearch(db, query, branch, null, limit, opts?.section_filter, diversify);
    return { matches };
  } finally {
    closeDb(db, handoffDbPath(workspace));
  }
}
