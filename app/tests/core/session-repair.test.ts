/**
 * session-repair.test.ts — a run killed mid-turn must not brick the session.
 *
 * The failure this covers: the loop appends the assistant message carrying its
 * tool calls, then runs the tools, then appends each result. A crash, OOM kill
 * or SIGKILL inside that window leaves a call that is never answered, and every
 * real provider refuses to replay such a history (OpenAI: `assistant tool_call
 * 'c1' (shell) has no following tool message`; Anthropic: a `tool_use` with no
 * `tool_result`). Before this repair existed, the session failed on every later
 * turn forever and the only escape was abandoning it.
 *
 * The repair must be honest (the effect may or may not have happened, so the
 * result is UNKNOWN), positioned where the provider requires it, and lossless —
 * every previously recorded row survives with its id, content and timestamp.
 *
 * Every case works in a temp workspace and reads rows back through a second
 * SQLite connection, so the assertions are about bytes on disk rather than
 * about the object the store happens to hold.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import { SessionStore, interruptedToolResult, unpairedToolCallTail } from "../../src/core/session";
import { cleanupTemps, tempDir } from "./helpers";

let workspace = "";
let store: SessionStore;

beforeAll(() => {
  workspace = tempDir("hz-ws-repair-");
  store = new SessionStore(workspace);
});

afterAll(() => {
  store?.close();
  cleanupTemps();
});

interface RawRow {
  id: string;
  role: string;
  content: string;
  ts: string;
  meta: string | null;
}

/** Rows straight from SQLite, in transcript order. */
function rawRows(sessionId: string): RawRow[] {
  const db = new Database(store.dbPath, { readonly: true });
  try {
    return db
      .query("SELECT id, role, content, ts, meta FROM messages WHERE session_id = ? ORDER BY rowid ASC")
      .all(sessionId) as RawRow[];
  } finally {
    db.close();
  }
}

function metaOf(row: RawRow): Record<string, unknown> {
  if (!row.meta) return {};
  try {
    const parsed: unknown = JSON.parse(row.meta);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toolCallIds(row: RawRow): string[] {
  const calls = metaOf(row).toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls
    .map((call) => (call !== null && typeof call === "object" ? (call as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id !== "");
}

/**
 * The provider's rule, stated as a checker: every assistant tool call must be
 * answered by a tool message with a matching toolCallId, and the answers must
 * follow immediately. This is what a real API enforces on replay — the reason a
 * dangling call is fatal rather than merely untidy.
 */
function providerShapeProblems(rows: RawRow[]): string[] {
  const problems: string[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] as RawRow;
    if (row.role !== "assistant") continue;
    for (const callId of toolCallIds(row)) {
      let j = i + 1;
      let answered = false;
      while (j < rows.length && (rows[j] as RawRow).role === "tool") {
        const answerId = metaOf(rows[j] as RawRow).toolCallId;
        if (answerId === callId) answered = true;
        j += 1;
      }
      if (!answered) problems.push(`assistant tool_call '${callId}' has no following tool message`);
    }
  }
  return problems;
}

function user(content: string): ChatMsg {
  return { role: "user", content };
}

function assistantWithCalls(content: string, calls: { id: string; name: string }[]): ChatMsg {
  return {
    role: "assistant",
    content,
    toolCalls: calls.map((call) => ({ id: call.id, name: call.name, arguments: "{}" })),
  };
}

function toolResult(callId: string, name: string, content: string): ChatMsg {
  return { role: "tool", content, toolCallId: callId, toolName: name };
}

describe("mid-turn repair — a killed run must not brick the session", () => {
  test("a dangling tool call is answered with UNKNOWN, positioned immediately after its assistant message", () => {
    const session = store.createSession("killed mid-tool");
    store.appendMessage(session.id, user("run a long command"));
    store.appendMessage(session.id, assistantWithCalls("", [{ id: "c1", name: "shell" }]));

    // This is the state a SIGKILL leaves: the call is recorded, the result is not.
    expect(providerShapeProblems(rawRows(session.id)).length).toBe(1);

    const result = store.repairDanglingToolCalls(session.id);
    expect(result.repaired).toBe(1);
    expect(result.calls).toEqual(["shell#c1"]);

    const rows = rawRows(session.id);
    expect(rows.length).toBe(3);
    expect(rows[2]?.role).toBe("tool");
    expect(metaOf(rows[2] as RawRow).toolCallId).toBe("c1");
    expect(metaOf(rows[2] as RawRow).toolName).toBe("shell");
    // Honest, not convenient: the effect may or may not have happened.
    expect(rows[2]?.content.startsWith("UNKNOWN:")).toBe(true);
    expect(rows[2]?.content).toContain("shell");
    // And the transcript now satisfies the provider's rule.
    expect(providerShapeProblems(rows)).toEqual([]);
  });

  test("repair is idempotent: a second pass changes nothing and reports zero", () => {
    const session = store.createSession("idempotent");
    store.appendMessage(session.id, user("go"));
    store.appendMessage(session.id, assistantWithCalls("", [{ id: "c1", name: "shell" }]));

    expect(store.repairDanglingToolCalls(session.id).repaired).toBe(1);
    const after = rawRows(session.id);
    expect(store.repairDanglingToolCalls(session.id).repaired).toBe(0);
    expect(rawRows(session.id)).toEqual(after);
  });

  test("a partially answered turn keeps the real result and answers only the missing call", () => {
    const session = store.createSession("partial");
    store.appendMessage(session.id, user("read and write"));
    store.appendMessage(
      session.id,
      assistantWithCalls("working", [
        { id: "call_a", name: "read" },
        { id: "call_b", name: "write" },
      ]),
    );
    // The first tool finished; the process died during the second.
    store.appendMessage(session.id, toolResult("call_a", "read", "file contents"));

    const result = store.repairDanglingToolCalls(session.id);
    expect(result.repaired).toBe(1);
    expect(result.calls).toEqual(["write#call_b"]);

    const rows = rawRows(session.id);
    const toolRows = rows.filter((row) => row.role === "tool");
    expect(toolRows.length).toBe(2);
    // Declared order is preserved and the recorded result is untouched.
    expect(metaOf(toolRows[0] as RawRow).toolCallId).toBe("call_a");
    expect(toolRows[0]?.content).toBe("file contents");
    expect(metaOf(toolRows[1] as RawRow).toolCallId).toBe("call_b");
    expect(toolRows[1]?.content.startsWith("UNKNOWN:")).toBe(true);
    expect(providerShapeProblems(rows)).toEqual([]);
  });

  test("later messages survive the rewrite in order — the mid-transcript case a real crash produces", () => {
    const session = store.createSession("crash then more turns");
    store.appendMessage(session.id, user("first"));
    store.appendMessage(session.id, assistantWithCalls("", [{ id: "c1", name: "shell" }]));
    // The user kept talking after the crash, so the repair target is NOT the
    // last row: appending the answer would leave the pairing broken again.
    store.appendMessage(session.id, user("continue please"));
    store.appendMessage(session.id, user("another try"));

    expect(store.repairDanglingToolCalls(session.id).repaired).toBe(1);

    const rows = rawRows(session.id);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "tool", "user", "user"]);
    expect(rows[3]?.content).toBe("continue please");
    expect(rows[4]?.content).toBe("another try");
    expect(providerShapeProblems(rows)).toEqual([]);
  });

  test("nothing is lost: every previously recorded row keeps its id, content and timestamp", () => {
    const session = store.createSession("lossless");
    store.appendMessage(session.id, user("task"));
    store.appendMessage(session.id, assistantWithCalls("plan", [{ id: "c1", name: "shell" }]));
    store.appendMessage(session.id, user("note"));
    const before = rawRows(session.id);
    const beforeIds = new Set(before.map((row) => row.id));

    store.repairDanglingToolCalls(session.id);

    const after = rawRows(session.id);
    expect(after.length).toBe(before.length + 1);
    for (const row of before) {
      const kept = after.find((candidate) => candidate.id === row.id);
      expect(kept).toBeDefined();
      expect(kept?.content).toBe(row.content);
      expect(kept?.ts).toBe(row.ts);
      expect(kept?.meta).toBe(row.meta);
    }
    // The inserted row is the only new id, and only one row was added.
    const newIds = after.filter((row) => !beforeIds.has(row.id));
    expect(newIds.length).toBe(1);
  });

  test("a healthy transcript is left completely untouched", () => {
    const session = store.createSession("healthy");
    store.appendMessage(session.id, user("read it"));
    store.appendMessage(session.id, assistantWithCalls("", [{ id: "c1", name: "read" }]));
    store.appendMessage(session.id, toolResult("c1", "read", "contents"));
    store.appendMessage(session.id, { role: "assistant", content: "done" });
    const before = rawRows(session.id);

    const result = store.repairDanglingToolCalls(session.id);
    expect(result.repaired).toBe(0);
    expect(result.calls).toEqual([]);
    // Not merely "no new rows": an unnecessary rewrite would churn rowids.
    expect(rawRows(session.id)).toEqual(before);
  });

  test("the model is told to verify rather than to assume either outcome", () => {
    const text = interruptedToolResult("write");
    expect(text.startsWith("UNKNOWN:")).toBe(true);
    expect(text).toContain("write");
    expect(text).toContain("may or may not have happened");
    expect(text).toContain("Check the actual state");
    // It must not assert failure — the write may well have landed.
    expect(text.toLowerCase()).not.toContain("failed");
    // A missing name still reads sensibly rather than printing "undefined".
    expect(interruptedToolResult("")).toContain("the tool");
  });

  test("an orphan tool row is preserved rather than dropped by the rewrite", () => {
    const session = store.createSession("orphan");
    store.appendMessage(session.id, user("go"));
    store.appendMessage(session.id, assistantWithCalls("", [{ id: "c1", name: "shell" }]));
    // A result whose call id matches nothing in the assistant message above —
    // malformed, but a recorded result a repair must never silently delete.
    store.appendMessage(session.id, toolResult("ghost", "shell", "orphaned output"));

    expect(store.repairDanglingToolCalls(session.id).repaired).toBe(1);

    const rows = rawRows(session.id);
    const contents = rows.map((row) => row.content);
    expect(contents).toContain("orphaned output");
    const orphans = rows.filter((row) => metaOf(row).toolCallId === "ghost");
    expect(orphans.length).toBe(1);
  });

  test("a fresh session with no rows is a no-op", () => {
    const session = store.createSession("empty");
    expect(store.repairDanglingToolCalls(session.id).repaired).toBe(0);
    expect(rawRows(session.id).length).toBe(0);
  });
});

describe("unpairedToolCallTail (C-8)", () => {
  test("returns only unanswered calls on the last assistant message", () => {
    const messages: ChatMsg[] = [
      user("u1"),
      assistantWithCalls("", [{ id: "old", name: "read" }]),
      { role: "tool", content: "ok", toolCallId: "old", toolName: "read" },
      user("u2"),
      assistantWithCalls("", [
        { id: "c1", name: "shell" },
        { id: "c2", name: "grep" },
      ]),
      { role: "tool", content: "done", toolCallId: "c1", toolName: "shell" },
    ];
    const tail = unpairedToolCallTail(messages);
    expect(tail.map((c) => c.id)).toEqual(["c2"]);
  });

  test("returns empty when the tail is fully answered", () => {
    const messages: ChatMsg[] = [
      assistantWithCalls("", [{ id: "c1", name: "read" }]),
      { role: "tool", content: "x", toolCallId: "c1", toolName: "read" },
    ];
    expect(unpairedToolCallTail(messages)).toEqual([]);
  });
});
