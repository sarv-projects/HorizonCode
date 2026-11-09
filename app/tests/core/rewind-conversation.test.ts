/**
 * rewind-conversation.test.ts — conversational rewind (FEAT-002).
 *
 * wave-14c shipped the FILE side of /rewind (rewindPlan restores the workspace
 * files a later turn changed) plus durable checkpoints that record a
 * `messageIndex`, but nothing acted on that index: the transcript was never
 * truncated. This covers the conversational half added here:
 *
 *   (a) rewindTo(n) truncates history() back to the checkpoint's messageIndex;
 *   (b) the pairing-protection invariant — a cut that would split an assistant
 *       toolCalls message from its tool results is moved EARLIER, and
 *       repairDanglingToolCalls on the kept prefix repairs 0 (used as an oracle);
 *   (c) the kernel event log stays APPEND-ONLY — the pre-rewind events are still
 *       present and verify, and a new rewind.conversation event is appended;
 *   (d) a REVERT check — a direct unit assertion on safeTruncationBoundary that
 *       FAILS if the tool-call-group adjustment is removed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { __resetCheckpointsForTests, recordCheckpoint } from "../../src/core/checkpoints";
import { createRuntime } from "../../src/core/index";
import { safeTruncationBoundary, SessionStore } from "../../src/core/session";
import { streamFor } from "../../src/core/loop";
import type { ChatMsg } from "../../src/contracts";
import { cleanupTemps, tempDir } from "./helpers";

afterEach(() => {
  cleanupTemps();
  __resetCheckpointsForTests();
});

async function runtimeIn(workspace: string) {
  const runtime = await createRuntime({ workspace, mock: true });
  const inner = runtime as unknown as { store: SessionStore; kernel: unknown; sessionId: string };
  return {
    runtime,
    store: inner.store,
    sessionId: inner.sessionId,
    close: () => runtime.close(),
  };
}

/** A plain user/assistant message (no tool wiring). */
function user(content: string): ChatMsg {
  return { role: "user", content };
}
function assistant(content: string): ChatMsg {
  return { role: "assistant", content };
}
/** An assistant message that declares one tool call. */
function assistantCall(content: string, callId: string, name = "shell"): ChatMsg {
  return { role: "assistant", content, toolCalls: [{ id: callId, name, arguments: "{}" }] };
}
/** The tool result that answers a call. */
function toolResult(callId: string, name = "shell"): ChatMsg {
  return { role: "tool", content: "ok", toolCallId: callId, toolName: name };
}

describe("conversational rewind (FEAT-002)", () => {
  test("rewindTo(n) truncates history() back to the checkpoint's messageIndex", async () => {
    const ws = tempDir("hz-rewind-conv-trunc-");
    const { runtime, store, sessionId, close } = await runtimeIn(ws);
    try {
      // Seed a flat transcript, no tool calls: 6 messages.
      for (const m of [user("one"), assistant("1"), user("two"), assistant("2"), user("three"), assistant("3")]) {
        store.appendMessage(sessionId, m);
      }
      expect(store.messageCount(sessionId)).toBe(6);

      // Record a checkpoint whose boundary is 4 messages (after the 2nd turn).
      recordCheckpoint(ws, sessionId, 4, []);

      const summary = await runtime.rewindTo?.(1);
      expect(summary).toContain("removed 2 transcript message(s)");

      const history = store.history(sessionId);
      expect(history).toHaveLength(4);
      expect(history.map((m) => m.content)).toEqual(["one", "1", "two", "2"]);

      // Idempotent: a second rewind to the same checkpoint removes nothing.
      const again = await runtime.rewindTo?.(1);
      expect(again).toContain("removed no transcript messages");
      expect(store.messageCount(sessionId)).toBe(4);
    } finally {
      await close();
    }
  });

  test("a cut that would split a tool-call group is moved earlier; repairDanglingToolCalls then repairs 0", async () => {
    const ws = tempDir("hz-rewind-conv-pairing-");
    const { runtime, store, sessionId, close } = await runtimeIn(ws);
    try {
      // Rows: 0 user, 1 assistant(call c1), 2 tool(c1), 3 assistant, ...
      // A naive cut of keepCount=2 would keep [user, assistantCall] and drop the
      // tool result — a dangling tool_call. The boundary must move to 1.
      for (const m of [
        user("do it"),
        assistantCall("running", "c1"),
        toolResult("c1"),
        assistant("done"),
        user("more"),
        assistant("sure"),
      ]) {
        store.appendMessage(sessionId, m);
      }
      expect(store.messageCount(sessionId)).toBe(6);

      // Checkpoint boundary 2 lands INSIDE the tool-call group.
      recordCheckpoint(ws, sessionId, 2, []);

      const summary = await runtime.rewindTo?.(1);
      // The boundary was adjusted earlier (to 1) to keep the group whole.
      expect(summary).toContain("boundary moved earlier to 1");
      expect(summary).toContain("removed 5 transcript message(s)");

      const history = store.history(sessionId);
      expect(history).toHaveLength(1);
      expect(history[0]?.content).toBe("do it");

      // Oracle: the kept prefix has NO dangling tool call, so the repair is a
      // no-op. (A split group would have left a dangling c1 for it to repair.)
      const repair = store.repairDanglingToolCalls(sessionId);
      expect(repair.repaired).toBe(0);
    } finally {
      await close();
    }
  });

  test("the kernel event log stays append-only: pre-rewind events verify and a rewind.conversation event is appended", async () => {
    const ws = tempDir("hz-rewind-conv-log-");
    const { runtime, store, sessionId, close } = await runtimeIn(ws);
    const inner = runtime as unknown as {
      kernel: {
        readEvents: (stream: string) => Promise<Array<{ type: string; payload: unknown }>>;
        verifyEventChain: (stream: string) => Promise<{ ok: boolean; count: number }>;
      };
    };
    try {
      const stream = streamFor(sessionId);

      // The session-start event is already logged; snapshot the log before the
      // rewind so we can prove the earlier records are untouched.
      const before = await inner.kernel.readEvents(stream);
      expect(before.length).toBeGreaterThan(0);
      const beforeVerify = await inner.kernel.verifyEventChain(stream);
      expect(beforeVerify.ok).toBe(true);

      for (const m of [user("a"), assistant("b"), user("c"), assistant("d")]) store.appendMessage(sessionId, m);
      recordCheckpoint(ws, sessionId, 2, []);

      await runtime.rewindTo?.(1);

      const after = await inner.kernel.readEvents(stream);
      // Append-only: every pre-rewind record is still present, byte-identical,
      // at the same position — the log grew, it was not rewritten.
      expect(after.length).toBeGreaterThan(before.length);
      for (let i = 0; i < before.length; i += 1) {
        expect(after[i]).toEqual(before[i] as (typeof after)[number]);
      }
      // A new forward rewind.conversation event records what the rewind removed.
      const conv = after.filter((e) => e.type === "rewind.conversation");
      expect(conv).toHaveLength(1);
      const payload = conv[0]?.payload as Record<string, unknown>;
      expect(payload.messageIndex).toBe(2);
      expect(payload.removed).toBe(2);
      expect(payload.adjustedTo).toBe(2);

      // The chain still verifies after the append.
      const afterVerify = await inner.kernel.verifyEventChain(stream);
      expect(afterVerify.ok).toBe(true);
      expect(afterVerify.count).toBe(after.length);
    } finally {
      await close();
    }
  });

  describe("safeTruncationBoundary (pure) — the REVERT check", () => {
    test("a cut inside a tool-call group is moved to before the assistant message", () => {
      // rows: 0 user, 1 assistant(call c1), 2 tool(c1), 3 assistant
      const rows = [
        { role: "user", toolCallIds: [] as string[] },
        { role: "assistant", toolCallIds: ["c1"] },
        { role: "tool", toolCallIds: [] as string[] },
        { role: "assistant", toolCallIds: [] as string[] },
      ];
      // keepCount 2 splits the group (keeps the assistant call, drops its tool
      // result). The adjustment MUST move the boundary to 1. If the tool-call-
      // group adjustment is removed from safeTruncationBoundary, this returns 2
      // and the assertion fails — a genuine revert check.
      expect(safeTruncationBoundary(rows, 2)).toBe(1);

      // keepCount 3 keeps the whole group, so no adjustment is needed.
      expect(safeTruncationBoundary(rows, 3)).toBe(3);
      // keepCount 1 is before the group entirely: safe, unchanged.
      expect(safeTruncationBoundary(rows, 1)).toBe(1);
      // A keepCount past the end keeps everything (no-op), and 0 clears all.
      expect(safeTruncationBoundary(rows, 99)).toBe(4);
      expect(safeTruncationBoundary(rows, 0)).toBe(0);
    });

    test("a multi-row tool-call group is kept whole or dropped whole", () => {
      // rows: 0 assistant(call c1,c2), 1 tool(c1), 2 tool(c2), 3 user
      const rows = [
        { role: "assistant", toolCallIds: ["c1", "c2"] },
        { role: "tool", toolCallIds: [] as string[] },
        { role: "tool", toolCallIds: [] as string[] },
        { role: "user", toolCallIds: [] as string[] },
      ];
      // Cuts at 1 and 2 both split the group — moved to 0 (before the assistant).
      expect(safeTruncationBoundary(rows, 1)).toBe(0);
      expect(safeTruncationBoundary(rows, 2)).toBe(0);
      // Cut at 3 keeps the whole group.
      expect(safeTruncationBoundary(rows, 3)).toBe(3);
    });
  });
});
