/**
 * handoff.ts — Engram-style session handoffs (docs/30 §8 #3 ADAPT).
 *
 * SQLite rows + FTS5 BM25 over per-section text (no embeddings). Stored under
 * `.hz/state/handoffs.db`. Branch scope prefers git; non-git workspaces use
 * `detached:<id>`.
 */

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { stateRoot } from "../paths";

export const SECTION_SOFT_CAP_CHARS = 5000;
export const SECTION_ITEM_SOFT_CAP_CHARS = 1000;
export const HANDOFF_CHAIN_MAX = 5;
export const DEFAULT_RESUME_SECTION_CHARS = 1500;

const HANDOFFS = "handoffs";
const FTS = "handoff_section_fts";

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
  message: string | null;
};

export type HandoffSearchResult = {
  matches: HandoffSectionMatch[];
};

export function handoffDbPath(workspace: string): string {
  return path.join(stateRoot(workspace), "handoffs.db");
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
  const dbPath = handoffDbPath(workspace);
  if (readonly && !existsSync(dbPath)) return null;
  const dir = stateRoot(workspace);
  if (!readonly && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath, readonly ? { readonly: true } : { create: true });
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
  context TEXT NOT NULL DEFAULT ''
);
CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS} USING fts5(
  handoff_id UNINDEXED,
  branch UNINDEXED,
  section_name,
  section_text,
  tokenize='porter'
);
`);
  }
  return db;
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
};

function rowToHandoff(row: Record<string, unknown>): StoredHandoff {
  return {
    id: String(row.id),
    branch: String(row.branch),
    created_at: Number(row.created_at),
    continues_from: row.continues_from != null ? String(row.continues_from) : null,
    summary: String(row.summary),
    tried: parseJsonArray(String(row.tried)),
    next_steps: parseJsonArray(String(row.next_steps)),
    blockers: parseJsonArray(String(row.blockers)),
    decisions: parseJsonArray(String(row.decisions)),
    files: String(row.files ?? ""),
    context: String(row.context ?? ""),
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
    db.exec(`DELETE FROM ${FTS}; DELETE FROM ${HANDOFFS};`);
  } finally {
    db.close();
  }
}

export function createHandoff(
  workspace: string,
  sections: HandoffInputSections,
  opts?: { branch?: string; continues_from?: string | null; auto_continue?: boolean },
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
         (id, branch, created_at, continues_from, summary, tried, next_steps, blockers, decisions, files, context)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          branch,
          now,
          continues_from,
          sections.summary,
          JSON.stringify(tried),
          JSON.stringify(next_steps),
          JSON.stringify(blockers),
          JSON.stringify(decisions),
          files,
          context,
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
          summary: sections.summary,
          tried: JSON.stringify(tried),
          next_steps: JSON.stringify(next_steps),
          blockers: JSON.stringify(blockers),
          decisions: JSON.stringify(decisions),
          files,
          context,
        }),
      );
    })();
    return { id, branch, continues_from, warnings };
  } finally {
    db.close();
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

function bm25SectionSearch(
  db: Database,
  query: string,
  branch: string | null,
  handoffIds: readonly string[] | null,
  limit: number,
  sectionFilter?: readonly string[],
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
      top_sections = bm25SectionSearch(db, q, branch, chain, maxSections);
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
      message: detached ? "No git branch; using detached workspace scope." : null,
    };
  } finally {
    db.close();
  }
}

export function searchHandoffs(
  workspace: string,
  query: string,
  opts?: { branch?: string; limit?: number; section_filter?: string[] },
): HandoffSearchResult {
  const { branch } = resolveHandoffBranch(workspace, opts?.branch);
  const limit = opts?.limit ?? 10;
  const db = openDb(workspace, true);
  if (db === null) return { matches: [] };
  try {
    const matches = bm25SectionSearch(db, query, branch, null, limit, opts?.section_filter);
    return { matches };
  } finally {
    db.close();
  }
}
