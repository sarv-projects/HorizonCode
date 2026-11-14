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
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ChatMsg, ToolCall } from "../../src/contracts";
import { AdmissionIdCollisionError, AdmissionQueue, admissionToolDispatchRefusal } from "../../src/core/admission";
import { SESSION_DB_USER_VERSION, readSessionDbUserVersion } from "../../src/core/session-migrate";
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

test("F5: user_version and projection_watermark migrate on open", () => {
  expect(readSessionDbUserVersion(store.db)).toBe(SESSION_DB_USER_VERSION);
  const row = store.db
    .query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='projection_watermark'`,
    )
    .get() as { name: string } | null;
  expect(row?.name).toBe("projection_watermark");
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

/* --------------------------- corruption quarantine --------------------------- */

/** Quarantine-named files in the canonical state directory of `workspace`. */
function quarantinedFiles(workspace: string): string[] {
  return readdirSync(path.join(workspace, ".hz", "state")).filter((name) => name.includes(".corrupt-"));
}

function zeroByteDbWorkspace(): { workspace: string; dbPath: string } {
  const workspace = tempDir("hz-ws-zero-");
  const dbPath = path.join(workspace, ".hz", "state", "hzcode.db");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, "");
  return { workspace, dbPath };
}

describe("database corruption quarantine", () => {
  test("a 0-byte database is quarantined, a fresh one takes its place, and recovered names the old file", () => {
    const { workspace, dbPath } = zeroByteDbWorkspace();

    const recovered = new SessionStore(workspace);
    try {
      // The confirmed loss shape: SQLite silently recreates the schema over a
      // truncated file. The store must say so instead.
      expect(recovered.recovered).not.toBeNull();
      const quarantined = recovered.recovered?.quarantined ?? "";
      expect(quarantined.startsWith(dbPath)).toBe(true);
      expect(path.basename(quarantined)).toMatch(/^hzcode\.db\.corrupt-\d+$/);
      expect(existsSync(quarantined)).toBe(true);
      expect(statSync(quarantined).size).toBe(0); // the old bytes (none) survive in the renamed file

      // A fresh, usable database took its place: the schema exists and accepts a session.
      expect(existsSync(dbPath)).toBe(true);
      const session = recovered.createSession("after recovery");
      expect(recovered.getSession(session.id)).not.toBeNull();
      expect(recovered.messageCount(session.id)).toBe(0);
    } finally {
      recovered.close();
    }
  });

  test("a garbage file is quarantined with its bytes preserved, and the reopened store is usable", () => {
    const workspace = tempDir("hz-ws-garbage-");
    const dbPath = path.join(workspace, ".hz", "state", "hzcode.db");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const garbage = Buffer.from("HZCODE IS NOT SQLITE\n\u0000\u0001\u0002 not a header\n", "utf8");
    writeFileSync(dbPath, garbage);

    const recovered = new SessionStore(workspace);
    try {
      expect(recovered.recovered).not.toBeNull();
      const quarantined = recovered.recovered?.quarantined ?? "";
      expect(path.basename(quarantined)).toMatch(/^hzcode\.db\.corrupt-\d+$/);
      // The bytes are preserved for inspection — quarantined, never dropped.
      expect(readFileSync(quarantined).equals(garbage)).toBe(true);
      expect(existsSync(dbPath)).toBe(true);
      const session = recovered.createSession("fresh after garbage");
      expect(recovered.history(session.id)).toEqual([]);
    } finally {
      recovered.close();
    }
  });

  test("a file SQLite reports as malformed (junk in page 1) is quarantined too", () => {
    const workspace = tempDir("hz-ws-malformed-");
    const first = new SessionStore(workspace);
    try {
      first.createSession("to be damaged");
    } finally {
      first.close();
    }
    const dbPath = path.join(workspace, ".hz", "state", "hzcode.db");
    const bytes = readFileSync(dbPath);
    // Keep the SQLite magic, trash page 1's b-tree header: a real database
    // file SQLite rejects with "database disk image is malformed".
    for (let i = 100; i < bytes.length; i += 1) bytes[i] = 0xee;
    writeFileSync(dbPath, bytes);

    const damaged = new SessionStore(workspace);
    try {
      expect(damaged.recovered).not.toBeNull();
      const quarantined = damaged.recovered?.quarantined ?? "";
      expect(readFileSync(quarantined).equals(bytes)).toBe(true);
      expect(damaged.createSession("fresh after malformed").id.length).toBeGreaterThan(10);
    } finally {
      damaged.close();
    }
  });

  test("a corrupt database's -wal/-shm sidecars are renamed alongside it", () => {
    const workspace = tempDir("hz-ws-sidecars-");
    const dbPath = path.join(workspace, ".hz", "state", "hzcode.db");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, "");
    writeFileSync(`${dbPath}-wal`, "wal bytes");
    writeFileSync(`${dbPath}-shm`, "shm bytes");

    const store = new SessionStore(workspace);
    try {
      const quarantined = store.recovered?.quarantined ?? "";
      expect(quarantined).not.toBe("");
      expect(readFileSync(`${quarantined}-wal`, "utf8")).toBe("wal bytes");
      expect(readFileSync(`${quarantined}-shm`, "utf8")).toBe("shm bytes");
    } finally {
      store.close();
    }
  });

  test("a healthy database reopens with no quarantine (recovered stays null)", () => {
    const workspace = tempDir("hz-ws-healthy-");
    const first = new SessionStore(workspace);
    let sessionId = "";
    try {
      expect(first.recovered).toBeNull();
      const session = first.createSession("healthy");
      sessionId = session.id;
      first.appendMessage(session.id, { role: "user", content: "kept" });
    } finally {
      first.close();
    }

    const reopened = new SessionStore(workspace);
    try {
      expect(reopened.recovered).toBeNull();
      expect(reopened.history(sessionId)).toEqual([{ role: "user", content: "kept" }]);
    } finally {
      reopened.close();
    }
    expect(quarantinedFiles(workspace)).toEqual([]);
  });

  test("a normal fresh create never quarantines", () => {
    const workspace = tempDir("hz-ws-fresh-");
    const fresh = new SessionStore(workspace);
    try {
      expect(fresh.recovered).toBeNull();
      expect(existsSync(fresh.dbPath)).toBe(true);
    } finally {
      fresh.close();
    }
    expect(quarantinedFiles(workspace)).toEqual([]);
  });
});

/* ----------------------------- admission order ----------------------------- */

describe("admission ids are scoped to a session", () => {
  test("a cross-session id collision is refused, typed, naming the id and both sessions", () => {
    const workspace = tempDir("hz-ws-adm-");
    const admissionStore = new SessionStore(workspace);
    try {
      const queue = new AdmissionQueue(admissionStore);
      expect(queue.admit("session-a", "first input", "adm-shared")).toBe("adm-shared");

      let collision: AdmissionIdCollisionError | undefined;
      try {
        queue.admit("session-b", "other input", "adm-shared");
      } catch (err) {
        expect(err).toBeInstanceOf(AdmissionIdCollisionError);
        collision = err as AdmissionIdCollisionError;
      }
      expect(collision).toBeDefined();
      expect(collision?.name).toBe("AdmissionIdCollisionError");
      expect(collision?.id).toBe("adm-shared");
      expect(collision?.existingSessionId).toBe("session-a");
      expect(collision?.sessionId).toBe("session-b");
      expect(collision?.message).toContain("adm-shared");
      expect(collision?.message).toContain("session-a");
      expect(collision?.message).toContain("session-b");

      // Nothing was admitted for session-b, and session-a's row is untouched.
      expect(queue.list("session-b")).toEqual([]);
      const rows = queue.list("session-a");
      expect(rows.length).toBe(1);
      expect(rows[0]?.input).toBe("first input");
      expect(rows[0]?.state).toBe("queued");

      // Same-session re-admit remains the documented silent no-op.
      expect(queue.admit("session-a", "a different text", "adm-shared")).toBe("adm-shared");
      const after = queue.list("session-a");
      expect(after.length).toBe(1);
      expect(after[0]?.input).toBe("first input");
      expect(after[0]?.state).toBe("queued");
    } finally {
      admissionStore.close();
    }
  });
});

describe("admissionToolDispatchRefusal", () => {
  test("allows dispatch only while the turn admission row is running", () => {
    const workspace = tempDir("hz-adm-dispatch-");
    const store = new SessionStore(workspace);
    try {
      const queue = new AdmissionQueue(store);
      const sessionId = "sess-1";
      const a1 = queue.admit(sessionId, "first");
      const a2 = queue.admit(sessionId, "second");
      expect(queue.begin(a1)).toBe(true);
      expect(admissionToolDispatchRefusal(queue, sessionId, a1)).toBeUndefined();
      queue.settle(a1, "unknown", "simulated halt");
      expect(admissionToolDispatchRefusal(queue, sessionId, a1)).toContain("unknown");
      expect(queue.begin(a2)).toBe(false);
      expect(admissionToolDispatchRefusal(queue, sessionId, a2)).toContain("halted");
    } finally {
      store.close();
    }
  });
});
