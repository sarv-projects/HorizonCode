/**
 * session-search.ts — FTS5 sidecar over session titles + user prompts (docs/12 F8).
 *
 * Adapted from Grok `xai-grok-session-search` (sidecar SQLite, title+content BM25,
 * content_hash skip) and Codex/omp resume-picker list+filter UX. Rebuildable
 * cache only — authority remains `session.ts`. Schema shape matches
 * `memory/store.ts` (single fts5 virtual table; no external-content triggers).
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { stateRoot } from "./paths";

const FTS = "session_search_fts";
const META = "session_search_meta";

export interface SessionSearchDoc {
  sessionId: string;
  title: string;
  updated: string;
  /** Concatenated user prompts (searchable body). */
  content: string;
}

export interface SessionSearchHit {
  sessionId: string;
  title: string;
  updated: string;
  score: number;
  snippet: string;
}

export function sessionSearchDbPath(workspace: string): string {
  return path.join(stateRoot(workspace), "session_search.db");
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

function contentHash(title: string, content: string): string {
  return createHash("sha256").update(title).update("\0").update(content).digest("hex");
}

function openDb(workspace: string): Database {
  const dir = stateRoot(workspace);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(sessionSearchDbPath(workspace), { create: true });
  db.exec(`
CREATE TABLE IF NOT EXISTS ${META} (
  session_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS} USING fts5(
  session_id UNINDEXED,
  title,
  content,
  updated UNINDEXED,
  tokenize='porter'
);
`);
  return db;
}

/** Upsert one session document; no-op when title+content hash unchanged. */
export function upsertSessionSearch(workspace: string, doc: SessionSearchDoc): void {
  const hash = contentHash(doc.title, doc.content);
  const db = openDb(workspace);
  try {
    const prev = db
      .query(`SELECT content_hash FROM ${META} WHERE session_id = ?`)
      .get(doc.sessionId) as { content_hash: string } | null;
    if (prev?.content_hash === hash) return;
    db.transaction(() => {
      db.run(`DELETE FROM ${FTS} WHERE session_id = ?`, [doc.sessionId]);
      db.run(`INSERT INTO ${FTS} (session_id, title, content, updated) VALUES (?, ?, ?, ?)`, [
        doc.sessionId,
        doc.title,
        doc.content,
        doc.updated,
      ]);
      db.run(
        `INSERT INTO ${META} (session_id, content_hash) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET content_hash = excluded.content_hash`,
        [doc.sessionId, hash],
      );
    })();
  } finally {
    db.close();
  }
}

export function removeSessionSearch(workspace: string, sessionId: string): void {
  const db = openDb(workspace);
  try {
    db.transaction(() => {
      db.run(`DELETE FROM ${FTS} WHERE session_id = ?`, [sessionId]);
      db.run(`DELETE FROM ${META} WHERE session_id = ?`, [sessionId]);
    })();
  } finally {
    db.close();
  }
}

/** BM25 rank score with a small recency boost (lower = better, ADAPT ruling **273**). */
export function sessionSearchRankScore(bm25Score: number, updatedIso: string, nowMs = Date.now()): number {
  const updated = Date.parse(updatedIso);
  if (!Number.isFinite(updated)) return bm25Score;
  const ageMs = Math.max(0, nowMs - updated);
  const halfLifeMs = 7 * 86_400_000;
  const recency = 0.12 * Math.exp(-ageMs / halfLifeMs);
  return bm25Score - recency;
}

function snippetFor(content: string, query: string, max = 120): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  const first = query.trim().split(/\s+/).find((t) => t.length > 0)?.toLowerCase();
  if (first) {
    const idx = flat.toLowerCase().indexOf(first);
    if (idx >= 0) {
      const start = Math.max(0, idx - 24);
      const slice = flat.slice(start, start + max);
      return (start > 0 ? "…" : "") + slice + (start + max < flat.length ? "…" : "");
    }
  }
  return flat.length <= max ? flat : flat.slice(0, max) + "…";
}

/** BM25-ranked sessions matching `query` against title + user-prompt body. */
export function searchSessions(workspace: string, query: string, limit = 20): SessionSearchHit[] {
  const match = ftsQuery(query);
  if (match === undefined) return [];
  const db = openDb(workspace);
  try {
    const rows = db
      .query(
        `SELECT session_id, title, content, updated, bm25(${FTS}) AS score
         FROM ${FTS}
         WHERE ${FTS} MATCH ?
         ORDER BY score
         LIMIT ?`,
      )
      .all(match, Math.max(1, limit)) as Array<{
      session_id: string;
      title: string;
      content: string;
      updated: string;
      score: number;
    }>;
    const nowMs = Date.now();
    const ranked = rows
      .map((r) => ({
        sessionId: r.session_id,
        title: r.title,
        updated: r.updated,
        score: Number(r.score),
        snippet: snippetFor(r.content, query),
        rank: sessionSearchRankScore(Number(r.score), r.updated, nowMs),
      }))
      .sort(
        (a, b) =>
          a.rank - b.rank || Date.parse(b.updated) - Date.parse(a.updated) || a.sessionId.localeCompare(b.sessionId),
      );
    return ranked.map(({ rank: _rank, ...hit }) => hit);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Rebuild from a listing + per-session user-prompt extractor (bootstrap / heal). */
export function reindexSessionSearch(
  workspace: string,
  sessions: ReadonlyArray<{ id: string; title: string; updated: string }>,
  userContentFor: (sessionId: string) => string,
): number {
  let n = 0;
  for (const s of sessions) {
    upsertSessionSearch(workspace, {
      sessionId: s.id,
      title: s.title,
      updated: s.updated,
      content: userContentFor(s.id),
    });
    n += 1;
  }
  return n;
}
