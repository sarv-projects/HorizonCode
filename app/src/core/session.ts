/**
 * session.ts — the durable conversation.
 *
 * One SQLite database per workspace at `<workspace>/.hz/state/hzcode.db`
 * (canonical, docs/12 §4.1) or `<workspace>/.hzcode/db.sqlite` (legacy, honoured
 * in place — see paths.ts) holds the sessions and the messages that make up their
 * history. The event log in the kernel state directory is the audit trail; this
 * database is the readable transcript the agent loop rebuilds its context from.
 *
 * Opening is fail-closed about corruption. A present-but-empty file — the shape
 * a crash or a bad truncate leaves behind, which SQLite would otherwise treat
 * as a brand-new database — or a file SQLite rejects with "file is not a
 * database"/"database disk image is malformed" on the one integrity probe this
 * constructor runs is renamed `<db>.corrupt-<epochMillis>` (with its `-wal` and
 * `-shm` sidecars), and a fresh database takes its place; the store then
 * carries `recovered: { quarantined: <new path> }`. A missing file is the
 * normal fresh-create path, a healthy database is never quarantined, and
 * `recovered` stays `null`.
 *
 * State is owner-only (docs/03 D12): after every open (Unix only, umask-proof,
 * best-effort) the state directory is chmod 0700 and the database with its WAL
 * sidecars 0600, so an older loose-mode file is tightened the next time it is
 * opened.
 */

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import * as path from "node:path";
import type { ChatMsg, ToolCall } from "../contracts";
import { newId, nowIso } from "../contracts";
import { sessionDbPath } from "./paths";

export interface SessionInfo {
  id: string;
  title: string;
  created: string;
  updated: string;
}

/** What an open found and had to recover from; `null` on a healthy open. */
export interface SessionRecovery {
  /** Where the corrupt database was moved (`<db>.corrupt-<epochMillis>`). */
  quarantined: string;
}

/** Owner-only modes for the state dir and the database files (docs/03 D12). */
const STATE_DIR_MODE = 0o700;
const STATE_FILE_MODE = 0o600;

const isUnix = process.platform !== "win32";

/**
 * Post-create chmod so the mode is exact regardless of umask. Best-effort: a
 * target that vanished between the write and the chmod is not an error, and on
 * non-Unix the call is a no-op (POSIX modes do not exist there).
 */
function setOwnerOnly(target: string, mode: number): void {
  if (!isUnix) return;
  try {
    chmodSync(target, mode);
  } catch {
    /* best effort */
  }
}

/** SQLite's two "this file is not a healthy database" messages. */
function isCorruptDatabaseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /file is not a database|database disk image is malformed/i.test(message);
}

/**
 * Quarantine a corrupt database: rename it — and its WAL sidecars, when present
 * — aside so the bytes survive for inspection, and return the new path. The
 * caller creates the fresh database afterwards.
 */
function quarantineDatabase(dbPath: string): string {
  const dest = `${dbPath}.corrupt-${Date.now()}`;
  renameSync(dbPath, dest);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) renameSync(sidecar, `${dest}${suffix}`);
  }
  return dest;
}

interface MessageRow {
  role: string;
  content: string;
  meta: string | null;
}

/** A full message row, as the mid-turn repair reads and rewrites it. */
interface RepairRow {
  id: string;
  role: string;
  content: string | null;
  ts: string;
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
-- NF-071: the durable per-session admission FIFO (semantics in admission.ts).
-- Additive and migration-safe: CREATE TABLE IF NOT EXISTS on every open.
CREATE TABLE IF NOT EXISTS admissions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  input TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','done','unknown','failed','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  evidence TEXT
);
CREATE INDEX IF NOT EXISTS idx_admissions_session ON admissions (session_id);
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

/**
 * What a repaired (interrupted) tool call tells the model.
 *
 * A crash or SIGKILL between "append the assistant message with its tool calls"
 * and "append the tool result" leaves the transcript with a call that is never
 * answered. Every real provider refuses to replay that history — OpenAI answers
 * `Invalid 'messages': assistant tool_call 'c1' (shell) has no following tool
 * message`, Anthropic rejects a `tool_use` with no `tool_result` — so the
 * session is permanently unusable: every later turn fails the same way, and the
 * only escape is abandoning it.
 *
 * The repair states the honest answer rather than a convenient one. The effect
 * may genuinely have happened (the process could have died after the write
 * landed), so the result is UNKNOWN — the same vocabulary the run exit already
 * uses — and the model is told to verify rather than to assume either way.
 * Fabricating "the tool failed" would be as wrong as fabricating a success.
 */
export function interruptedToolResult(toolName: string): string {
  const name = typeof toolName === "string" && toolName !== "" ? toolName : "the tool";
  return (
    `UNKNOWN: the run was interrupted while ${name} was executing (the process died), so no result was recorded. ` +
    `The effect may or may not have happened. Check the actual state (re-read the file, re-run the command, inspect the diff) before relying on it, ` +
    `and do not assume ${name} did or did not run.`
  );
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
  /**
   * The shared SQLite handle. Public so additive stores in this directory can
   * use the same database — the NF-071 admission FIFO (`admission.ts`) reads
   * and writes the `admissions` table through it. Schema creation stays in this
   * class, so a reopened store always migrates before anyone else touches it.
   */
  readonly db: Database;

  /**
   * Set when this open quarantined a corrupt database (see the module header);
   * `null` on every healthy open, including a fresh create. A caller that
   * surfaces it must tell the human the transcript moved to `quarantined`.
   */
  readonly recovered: SessionRecovery | null;

  constructor(workspace: string) {
    // Canonical `<workspace>/.hz/state/hzcode.db`, or the legacy
    // `<workspace>/.hzcode/db.sqlite` in place (paths.ts owns the rule).
    this.dbPath = sessionDbPath(workspace);
    const dir = path.dirname(this.dbPath);
    mkdirSync(dir, { recursive: true });
    // Docs/03 D12: the state directory and everything in it are owner-only.
    setOwnerOnly(dir, STATE_DIR_MODE);

    let recovered: SessionRecovery | null = null;
    // A present-but-empty file is the silent-loss shape: SQLite would treat it
    // as a brand-new database, so nothing downstream could tell the transcript
    // was lost. Quarantine it before opening. A missing file is the normal
    // fresh-create path and is left to `new Database(..., { create: true })`.
    if (existsSync(this.dbPath) && statSync(this.dbPath).size === 0) {
      recovered = { quarantined: quarantineDatabase(this.dbPath) };
    }

    let db: Database | undefined;
    try {
      db = new Database(this.dbPath, { create: true });
      // The single integrity probe at open: the empty-file shape was handled
      // above; every other corrupt shape surfaces here (SQLite validates the
      // header and reads page 1 / the schema table). A healthy open pays one
      // cheap query.
      db.exec("SELECT count(*) FROM sqlite_master;");
    } catch (err) {
      if (!isCorruptDatabaseError(err)) throw err;
      try {
        db?.close();
      } catch {
        /* the handle never opened */
      }
      db = undefined;
      recovered = { quarantined: quarantineDatabase(this.dbPath) };
    }
    this.db = db ?? new Database(this.dbPath, { create: true });
    this.recovered = recovered;

    // Two hzcode windows may share a workspace: wait instead of failing.
    try {
      this.db.exec("PRAGMA busy_timeout = 5000;");
      // RC-16(e) / docs/12 §4.3: strict durability is the default. WAL keeps
      // readers unblocked beside the writer; synchronous=FULL fsyncs every
      // commit, so a committed transcript survives a crash. Both are set on
      // every open (migration-safe: an existing rollback-journal database is
      // converted in place; a database already in WAL stays there).
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = FULL;");
    } catch {
      /* pragma support is best-effort */
    }
    this.db.exec(SCHEMA);

    // Owner-only state, applied after the schema and WAL pragmas so the file
    // and any sidecar they created are covered. Re-applied on every open, so a
    // loose older file is tightened the next time it is touched.
    setOwnerOnly(this.dbPath, STATE_FILE_MODE);
    setOwnerOnly(`${this.dbPath}-wal`, STATE_FILE_MODE);
    setOwnerOnly(`${this.dbPath}-shm`, STATE_FILE_MODE);
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

  /**
   * Repair a transcript left mid-turn by a crash, an OOM kill or a SIGKILL: an
   * assistant message whose tool calls were never answered (see
   * `interruptedToolResult` for why this bricks the session).
   *
   * One synthetic UNKNOWN tool result is inserted per unanswered call, in the
   * assistant's declared call order, immediately after that assistant message —
   * which is what the providers require. Answered calls keep their real results
   * and their position; nothing is ever deleted. Idempotent: a call that already
   * has a result is left alone, so running this on every open is safe.
   *
   * Ordering note: SQLite assigns a fresh rowid on insert, so a repair that only
   * appended the synthetic rows would sort them after every later message and
   * leave the pairing broken again. The affected session's rows are therefore
   * rewritten in order inside one transaction, preserving every `id`, `content`
   * and `ts` exactly — only rowids change, and `history()` orders by rowid.
   */
  repairDanglingToolCalls(sessionId: string): { repaired: number; calls: string[] } {
    const rows = this.db
      .query("SELECT id, role, content, ts, meta FROM messages WHERE session_id = ? ORDER BY rowid ASC")
      .all(sessionId) as RepairRow[];
    if (rows.length === 0) return { repaired: 0, calls: [] };

    const ordered: RepairRow[] = [];
    const inserted: string[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i] as RepairRow;
      ordered.push(row);
      if (row.role !== "assistant") continue;
      const calls = (parseMeta(row.meta).toolCalls ?? []).filter(isToolCall);
      if (calls.length === 0) continue;

      // The tool rows that immediately follow this assistant message answer it.
      const following: RepairRow[] = [];
      let j = i + 1;
      while (j < rows.length && (rows[j] as RepairRow).role === "tool") {
        following.push(rows[j] as RepairRow);
        j += 1;
      }
      const byCallId = new Map<string, RepairRow>();
      for (const toolRow of following) {
        const callId = parseMeta(toolRow.meta).toolCallId;
        if (typeof callId === "string" && callId !== "" && !byCallId.has(callId)) byCallId.set(callId, toolRow);
      }

      const consumed = new Set<string>();
      for (const call of calls) {
        const answered = byCallId.get(call.id);
        if (answered !== undefined) {
          ordered.push(answered);
          consumed.add(call.id);
          continue;
        }
        // Unanswered: the honest UNKNOWN, positioned where the result belongs.
        ordered.push({
          id: newId(),
          role: "tool",
          content: interruptedToolResult(call.name),
          // The interruption happened in this turn, not at repair time.
          ts: row.ts,
          meta: JSON.stringify({ toolCallId: call.id, toolName: call.name, interrupted: true }),
        });
        inserted.push(`${call.name}#${call.id}`);
      }
      // A tool row that answers no call of this assistant message is preserved
      // rather than dropped: a repair must never lose a recorded result.
      for (const toolRow of following) {
        const callId = parseMeta(toolRow.meta).toolCallId;
        if (typeof callId === "string" && consumed.has(callId)) continue;
        ordered.push(toolRow);
      }
      i = j - 1;
    }

    if (inserted.length === 0) return { repaired: 0, calls: [] };

    const rewrite = this.db.transaction(() => {
      this.db.run("DELETE FROM messages WHERE session_id = ?", [sessionId]);
      for (const row of ordered) {
        this.db.run("INSERT INTO messages (id, session_id, role, content, ts, meta) VALUES (?, ?, ?, ?, ?, ?)", [
          row.id,
          sessionId,
          row.role,
          row.content ?? "",
          row.ts,
          row.meta,
        ]);
      }
    });
    rewrite();
    this.touchSession(sessionId);
    return { repaired: inserted.length, calls: inserted };
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
