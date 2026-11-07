/**
 * session.test.ts — the durable transcript: <workspace>/.hz/state/hzcode.db
 * (canonical; a legacy workspace keeps <workspace>/.hzcode/db.sqlite in place —
 * see paths.ts and state-paths.test.ts).
 *
 * Every case works inside a temp workspace, so the real home and the repository
 * are never touched. Rows are also read with a second SQLite connection to prove
 * what the store actually persists (and what it deliberately leaves out).
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { ChatMsg, ToolCall } from "../../src/contracts";
import { SessionStore, rowToChatMsg } from "../../src/core/session";
import { cleanupTemps, tempDir } from "./helpers";

let workspace = "";
let store: SessionStore;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => {
  workspace = tempDir("hz-ws-session-");
  store = new SessionStore(workspace);
});

afterAll(() => {
  store?.close();
  cleanupTemps();
});

test("the database lives under <workspace>/.hz/state/hzcode.db (canonical)", () => {
  expect(store.dbPath).toBe(path.join(workspace, ".hz", "state", "hzcode.db"));
  expect(existsSync(store.dbPath)).toBe(true);
});

test("durability: journal_mode=WAL and synchronous=FULL at open, and they stick across reopen (RC-16)", () => {
  const journal = store.db.query("PRAGMA journal_mode").get() as { journal_mode: string };
  expect(journal.journal_mode.toLowerCase()).toBe("wal");
  const sync = store.db.query("PRAGMA synchronous").get() as { synchronous: number };
  expect(Number(sync.synchronous)).toBe(2); // 2 = FULL

  const reopened = new SessionStore(workspace);
  try {
    const journal2 = reopened.db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journal2.journal_mode.toLowerCase()).toBe("wal");
    const sync2 = reopened.db.query("PRAGMA synchronous").get() as { synchronous: number };
    expect(Number(sync2.synchronous)).toBe(2);
    // The busy wait survives alongside them.
    const busy = reopened.db.query("PRAGMA busy_timeout").get() as { timeout: number };
    expect(Number(busy.timeout)).toBe(5000);
  } finally {
    reopened.close();
  }
});

test("createSession round-trips and messages keep their order and tool wiring", () => {
  const session = store.createSession("First chat");
  expect(session.title).toBe("First chat");
  expect(session.id.length).toBeGreaterThan(10);
  expect(Date.parse(session.created)).toBeGreaterThan(0);
  expect(store.getSession(session.id)).toEqual(session);
  expect(store.messageCount(session.id)).toBe(0);

  const calls: ToolCall[] = [{ id: "call-1", name: "read", arguments: JSON.stringify({ path: "a.txt" }) }];
  const user: ChatMsg = { role: "user", content: "read a.txt" };
  const assistant: ChatMsg = { role: "assistant", content: "on it", toolCalls: calls };
  const tool: ChatMsg = { role: "tool", content: "hello", toolCallId: "call-1", toolName: "read" };

  const userId = store.appendMessage(session.id, user);
  const assistantId = store.appendMessage(session.id, assistant);
  const toolId = store.appendMessage(session.id, tool);
  expect(new Set([userId, assistantId, toolId]).size).toBe(3);

  expect(store.messageCount(session.id)).toBe(3);
  const history = store.history(session.id);
  expect(history.map((msg) => msg.role)).toEqual(["user", "assistant", "tool"]);
  expect(history).toEqual([user, assistant, tool]);
  expect(history[1].toolCalls).toEqual(calls);
  expect(history[1].toolCalls?.[0].arguments).toBe(JSON.stringify({ path: "a.txt" }));
  expect(history[2].toolCallId).toBe("call-1");
  expect(history[2].toolName).toBe("read");

  // What is on disk, verbatim: one meta column, nothing smuggled into content.
  const db = new Database(store.dbPath);
  try {
    const rows = db
      .query("SELECT session_id, role, content, meta FROM messages ORDER BY rowid ASC")
      .all() as Array<{ session_id: string; role: string; content: string; meta: string | null }>;
    expect(rows.map((row) => row.session_id)).toEqual([session.id, session.id, session.id]);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "tool"]);
    expect(rows[0].meta).toBeNull();
    expect(JSON.parse(rows[1].meta ?? "{}")).toEqual({ toolCalls: calls });
    expect(JSON.parse(rows[2].meta ?? "{}")).toEqual({ toolCallId: "call-1", toolName: "read" });
    expect(rows[1].content).toBe("on it");
  } finally {
    db.close();
  }
});

test("rowToChatMsg restores tool fields and defaults an unknown role to user", () => {
  expect(
    rowToChatMsg({
      role: "tool",
      content: "out",
      meta: JSON.stringify({ toolCallId: "c1", toolName: "grep", toolCalls: [{ id: "x", name: "y" }] }),
    }),
  ).toEqual({ role: "tool", content: "out", toolCallId: "c1", toolName: "grep", toolCalls: [{ id: "x", name: "y", arguments: "" }] });
  expect(rowToChatMsg({ role: "weird", content: "x", meta: null })).toEqual({ role: "user", content: "x" });
  expect(rowToChatMsg({ role: "assistant", content: "x", meta: "{ not json" })).toEqual({ role: "assistant", content: "x" });
  expect(
    rowToChatMsg({
      role: "assistant",
      content: null as unknown as string,
      meta: JSON.stringify({ toolCalls: [{ id: 1 }, { id: "ok", name: "n", arguments: "{}" }] }),
    }),
  ).toEqual({ role: "assistant", content: "", toolCalls: [{ id: "ok", name: "n", arguments: "{}" }] });
});

test("latestSession follows the most recently touched session", async () => {
  const solo = new SessionStore(tempDir("hz-ws-order-"));
  try {
    expect(solo.latestSession()).toBeNull();
    const older = solo.createSession("Older");
    await sleep(5);
    const newer = solo.createSession("Newer");
    expect(solo.latestSession()?.id).toBe(newer.id);
    expect(solo.listSessions().map((session) => session.id)).toEqual([newer.id, older.id]);

    await sleep(10);
    solo.appendMessage(older.id, { role: "user", content: "back to the first" });
    expect(solo.latestSession()?.id).toBe(older.id);
    expect(solo.listSessions()[0].id).toBe(older.id);

    await sleep(10);
    solo.touchSession(older.id, "Renamed");
    expect(solo.getSession(older.id)?.title).toBe("Renamed");
    expect(solo.latestSession()?.id).toBe(older.id);
    expect(solo.listSessions(1).map((session) => session.id)).toEqual([older.id]);
    expect(solo.getSession(newer.id)?.title).toBe("Newer");
    expect(solo.getSession("no-such-session")).toBeNull();
  } finally {
    solo.close();
  }
});

test("a second store on the same workspace sees the same transcript", () => {
  const session = store.createSession("Durable");
  store.appendMessage(session.id, { role: "user", content: "persist me" });

  const reopened = new SessionStore(workspace);
  try {
    const fromDisk = reopened.getSession(session.id);
    // `appendMessage` moves `updated`, so the freshly created copy is only
    // comparable on the fields that cannot move.
    expect(fromDisk).toMatchObject({ id: session.id, title: "Durable", created: session.created });
    expect(Date.parse(fromDisk?.updated ?? "")).toBeGreaterThanOrEqual(Date.parse(session.created));
    expect(reopened.history(session.id)).toEqual([{ role: "user", content: "persist me" }]);
    expect(reopened.messageCount(session.id)).toBe(1);
    expect(reopened.latestSession()?.id).toBe(session.id);
  } finally {
    reopened.close();
  }
});

test("another workspace has its own database and no sessions", () => {
  const other = new SessionStore(tempDir("hz-ws-other-"));
  try {
    expect(other.dbPath).not.toBe(store.dbPath);
    expect(existsSync(other.dbPath)).toBe(true);
    expect(other.latestSession()).toBeNull();
    expect(other.listSessions()).toEqual([]);
    expect(other.history("nope")).toEqual([]);
    expect(other.messageCount("nope")).toBe(0);
  } finally {
    other.close();
  }
});
