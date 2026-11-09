/**
 * crash-recovery.test.ts — the ONE coherent crash-recovery story, wired at open.
 *
 * A run killed mid-tool leaves two distinct kinds of damage, and `createRuntime`
 * must heal BOTH on open/resume, before the first turn can run (external audit
 * finding 2 / the dsh ToolCallRecovery reference):
 *
 *   - the TRANSCRIPT has an assistant tool call with no following tool result,
 *     which every real provider refuses to replay — `repairDanglingToolCalls`
 *     answers it with a synthetic UNKNOWN result (already wired before this
 *     task; covered here for the open-path);
 *   - the ADMISSION FIFO has a 'running' row the killed turn never settled,
 *     which would silently replay — `recoverInterrupted` settles it to
 *     'unknown' (evidence 'interrupted') so it HALTS its followers instead.
 *     recoverInterrupted was DEAD CODE on the live path (finding 2); this suite
 *     is the revert check that it is now invoked on open.
 *
 * Every assertion reads rows back through a SECOND SQLite connection, so it is
 * about bytes on disk after the runtime opened, not an in-memory object.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import { AdmissionQueue } from "../../src/core/admission";
import { createRuntime } from "../../src/core/index";
import { SessionStore } from "../../src/core/session";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(() => cleanupTemps());

interface RawMsg {
  id: string;
  role: string;
  content: string;
  meta: string | null;
}

interface RawAdmission {
  id: string;
  state: string;
  evidence: string | null;
}

/** Read the transcript back through a fresh read-only connection. */
function readMessages(dbPath: string, sessionId: string): RawMsg[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query("SELECT id, role, content, meta FROM messages WHERE session_id = ? ORDER BY rowid ASC")
      .all(sessionId) as RawMsg[];
  } finally {
    db.close();
  }
}

/** Read admission rows back through a fresh read-only connection. */
function readAdmissions(dbPath: string, sessionId: string): RawAdmission[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query("SELECT id, state, evidence FROM admissions WHERE session_id = ? ORDER BY rowid ASC")
      .all(sessionId) as RawAdmission[];
  } finally {
    db.close();
  }
}

function metaOf(row: RawMsg): Record<string, unknown> {
  if (!row.meta) return {};
  try {
    const parsed: unknown = JSON.parse(row.meta);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function assistantWithCall(callId: string, name: string): ChatMsg {
  return { role: "assistant", content: "", toolCalls: [{ id: callId, name, arguments: "{}" }] };
}

/**
 * Seed the exact state a SIGKILL-mid-tool leaves in a workspace, then close the
 * store so a later `createRuntime` resumes the SAME session from disk. Returns
 * the db path and the session id (and the admission id, when one was seeded).
 */
function seedCrashedSession(
  prefix: string,
  opts: { danglingCall?: { id: string; name: string }; runningAdmission?: string } = {},
): { workspace: string; dbPath: string; sessionId: string; admissionId?: string } {
  const workspace = tempDir(prefix);
  const store = new SessionStore(workspace);
  const dbPath = store.dbPath;
  try {
    const session = store.createSession("crashed");
    if (opts.danglingCall) {
      store.appendMessage(session.id, { role: "user", content: "run a long command" });
      store.appendMessage(session.id, assistantWithCall(opts.danglingCall.id, opts.danglingCall.name));
    }
    let admissionId: string | undefined;
    if (opts.runningAdmission) {
      const queue = new AdmissionQueue(store);
      admissionId = queue.admit(session.id, "interrupted turn", opts.runningAdmission);
      expect(queue.begin(admissionId)).toBe(true); // -> 'running', the killed state
      expect(queue.list(session.id)[0]?.state).toBe("running");
    }
    return { workspace, dbPath, sessionId: session.id, admissionId };
  } finally {
    store.close();
  }
}

describe("crash recovery is wired into createRuntime (external audit finding 2)", () => {
  test("(a) a dangling assistant tool_call gets a synthetic UNKNOWN result after open", async () => {
    const { workspace, dbPath, sessionId } = seedCrashedSession("hz-crash-transcript-", {
      danglingCall: { id: "c1", name: "shell" },
    });

    const runtime = await createRuntime({ workspace, mock: true, continueSession: true });
    try {
      expect(runtime.sessionId).toBe(sessionId);
    } finally {
      await runtime.close();
    }

    const rows = readMessages(dbPath, sessionId);
    // The synthetic UNKNOWN tool result now pairs the dangling call.
    const answer = rows.find((row) => row.role === "tool" && metaOf(row).toolCallId === "c1");
    expect(answer).toBeDefined();
    expect(answer?.content.startsWith("UNKNOWN:")).toBe(true);
    expect(answer?.content).toContain("shell");
  });

  test("(b) a 'running' admission row becomes 'unknown' (evidence 'interrupted'); the queue halts", async () => {
    const { workspace, dbPath, sessionId, admissionId } = seedCrashedSession("hz-crash-admission-", {
      runningAdmission: "run-1",
    });

    const runtime = await createRuntime({ workspace, mock: true, continueSession: true });
    try {
      expect(runtime.sessionId).toBe(sessionId);
    } finally {
      await runtime.close();
    }

    const rows = readAdmissions(dbPath, sessionId);
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(admissionId);
    // THE revert check: without the recoverInterrupted wiring this row would
    // still read 'running'. createRuntime settled it to 'unknown' on open.
    expect(rows[0]?.state).toBe("unknown");
    expect(rows[0]?.evidence).toBe("interrupted");

    // And the queue is honestly halted: a follower cannot replay around it.
    const verify = new SessionStore(workspace);
    try {
      const queue = new AdmissionQueue(verify);
      expect(queue.nextRunnable(sessionId)).toEqual({ runnable: false, halted: true, blockedBy: admissionId });
      queue.admit(sessionId, "follower", "run-2");
      expect(queue.begin("run-2")).toBe(false);
    } finally {
      verify.close();
    }
  });

  test("(c) both recoveries run together, and a second open changes nothing (idempotent)", async () => {
    const { workspace, dbPath, sessionId, admissionId } = seedCrashedSession("hz-crash-both-", {
      danglingCall: { id: "c1", name: "shell" },
      runningAdmission: "run-1",
    });

    const first = await createRuntime({ workspace, mock: true, continueSession: true });
    await first.close();

    const msgsAfterFirst = readMessages(dbPath, sessionId);
    const admAfterFirst = readAdmissions(dbPath, sessionId);
    // Both repairs landed on the first open.
    expect(msgsAfterFirst.some((row) => row.role === "tool" && metaOf(row).toolCallId === "c1")).toBe(true);
    expect(admAfterFirst[0]?.state).toBe("unknown");
    expect(admAfterFirst[0]?.id).toBe(admissionId);

    // A second open re-runs both recoveries — and changes nothing on disk.
    const second = await createRuntime({ workspace, mock: true, continueSession: true });
    await second.close();

    expect(readMessages(dbPath, sessionId)).toEqual(msgsAfterFirst);
    expect(readAdmissions(dbPath, sessionId)).toEqual(admAfterFirst);
  });

  test("(d) a clean resume with no interrupted work leaves both tables untouched", async () => {
    const { workspace, dbPath, sessionId } = seedCrashedSession("hz-crash-clean-");

    const runtime = await createRuntime({ workspace, mock: true, continueSession: true });
    try {
      expect(runtime.sessionId).toBe(sessionId);
    } finally {
      await runtime.close();
    }

    // No dangling call, no running admission: nothing to recover.
    expect(readMessages(dbPath, sessionId).filter((row) => row.role === "tool").length).toBe(0);
    expect(readAdmissions(dbPath, sessionId).length).toBe(0);
  });
});
