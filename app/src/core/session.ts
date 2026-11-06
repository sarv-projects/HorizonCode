/**
 * session.ts — the durable conversation.
 *
 * One SQLite database per workspace at <workspace>/.hzcode/db.sqlite holds the
 * sessions and the messages that make up their history. The event log in the
 * kernel state directory is the audit trail; this database is the readable
 * transcript the agent loop rebuilds its context from.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import type { ChatMsg, ToolCall } from "../contracts";
import { newId, nowIso } from "../contracts";

export interface SessionInfo {
  id: string;
  title: string;
  created: string;
  updated: string;
}

interface MessageRow {
  role: string;
  content: string;
  meta: string | null;
}

interface SessionRow extends SessionInfo {}

interface MessageMeta {
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCall[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  created TEXT,
  updated TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  role TEXT,
  content TEXT,
  ts TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, ts);
`;

function parseMeta(raw: string | null): MessageMeta {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return {};
    return value as MessageMeta;
  } catch {
    return {};
  }
}

function isToolCall(value: unknown): value is ToolCall {
  if (value === null || typeof value !== "object") return false;
  const call = value as Partial<ToolCall>;
  return typeof call.id === "string" && typeof call.name === "string";
}

/** Rows -> ChatMsg, restoring the fields the providers need to replay a turn. */
export function rowToChatMsg(row: MessageRow): ChatMsg {
  const role: ChatMsg["role"] =
    row.role === "system" || row.role === "assistant" || row.role === "tool" ? row.role : "user";
  const msg: ChatMsg = { role, content: row.content ?? "" };
  const meta = parseMeta(row.meta);
  if (typeof meta.toolCallId === "string" && meta.toolCallId !== "") msg.toolCallId = meta.toolCallId;
  if (typeof meta.toolName === "string" && meta.toolName !== "") msg.toolName = meta.toolName;
  if (Array.isArray(meta.toolCalls)) {
    const calls = meta.toolCalls.filter(isToolCall).map((call) => ({
      id: call.id,
      name: call.name,
      arguments: typeof call.arguments === "string" ? call.arguments : "",
    }));
    if (calls.length > 0) msg.toolCalls = calls;
  }
  return msg;
}

function metaFor(msg: ChatMsg): string | null {
  const meta: MessageMeta = {};
  if (msg.toolCallId) meta.toolCallId = msg.toolCallId;
  if (msg.toolName) meta.toolName = msg.toolName;
  if (msg.toolCalls && msg.toolCalls.length > 0) meta.toolCalls = msg.toolCalls;
  return Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;
}

/** The session store: create sessions, append messages, read history back. */
export class SessionStore {
  readonly dbPath: string;
  private readonly db: Database;

  constructor(workspace: string) {
    const dir = path.join(workspace, ".hzcode");
    mkdirSync(dir, { recursive: true });
    this.dbPath = path.join(dir, "db.sqlite");
    this.db = new Database(this.dbPath, { create: true });
    // Two hzcode windows may share a workspace: wait instead of failing.
    try {
      this.db.exec("PRAGMA busy_timeout = 5000;");
    } catch {
      /* pragma support is best-effort */
    }
    this.db.exec(SCHEMA);
  }

  createSession(title = "New chat"): SessionInfo {
    const session: SessionInfo = {
      id: newId(),
      title,
      created: nowIso(),
      updated: nowIso(),
    };
    this.db.run("INSERT INTO sessions (id, title, created, updated) VALUES (?, ?, ?, ?)", [
      session.id,
      session.title,
      session.created,
      session.updated,
    ]);
    return session;
  }

  getSession(id: string): SessionInfo | null {
    const row = this.db
      .query("SELECT id, title, created, updated FROM sessions WHERE id = ?")
      .get(id) as SessionRow | null | undefined;
    return row ?? null;
  }

  /** The most recently touched session in this workspace, if there is one. */
  latestSession(): SessionInfo | null {
    const row = this.db
      .query("SELECT id, title, created, updated FROM sessions ORDER BY updated DESC, rowid DESC LIMIT 1")
      .get() as SessionRow | null | undefined;
    return row ?? null;
  }

  listSessions(limit = 20): SessionInfo[] {
    return this.db
      .query("SELECT id, title, created, updated FROM sessions ORDER BY updated DESC, rowid DESC LIMIT ?")
      .all(Math.max(1, limit)) as SessionInfo[];
  }

  /** Retitle a session (the chat loop names it from the first user message). */
  touchSession(id: string, title?: string): void {
    const updated = nowIso();
    if (title !== undefined) {
      this.db.run("UPDATE sessions SET updated = ?, title = ? WHERE id = ?", [updated, title, id]);
      return;
    }
    this.db.run("UPDATE sessions SET updated = ? WHERE id = ?", [updated, id]);
  }

  appendMessage(sessionId: string, msg: ChatMsg): string {
    const id = newId();
    const ts = nowIso();
    this.db.run("INSERT INTO messages (id, session_id, role, content, ts, meta) VALUES (?, ?, ?, ?, ?, ?)", [
      id,
      sessionId,
      msg.role,
      msg.content ?? "",
      ts,
      metaFor(msg),
    ]);
    this.db.run("UPDATE sessions SET updated = ? WHERE id = ?", [ts, sessionId]);
    return id;
  }

  /** Full transcript in insertion order; tool messages keep their call wiring. */
  history(sessionId: string): ChatMsg[] {
    const rows = this.db
      .query("SELECT role, content, meta FROM messages WHERE session_id = ? ORDER BY rowid ASC")
      .all(sessionId) as MessageRow[];
    return rows.map(rowToChatMsg);
  }

  messageCount(sessionId: string): number {
    const row = this.db.query("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(sessionId) as
      | { n: number }
      | null
      | undefined;
    return typeof row?.n === "number" ? row.n : 0;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
