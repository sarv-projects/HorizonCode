/**
 * C-13 incremental (ruling 363 residual) — subagent turns join the parent's
 * durable FIFO, and admission rows can be applied in atomic batches.
 *
 * QUEUE-LEVEL atomicity only; NOT full R170 atomicity (no cross-process/kernel
 * fencing claim).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent } from "../../src/contracts";
import { AdmissionQueue } from "../../src/core/admission";
import { KernelClient } from "../../src/core/kernel";
import { SessionStore } from "../../src/core/session";
import { runNested } from "../../src/core/subagent";

let workspace = "";

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-c13-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** A child provider that makes exactly one `read` call, then ends. */
function readOnceProvider(target: string): Provider {
  let phase = 0;
  return {
    name: "scripted",
    async *stream(): AsyncGenerator<ProviderEvent> {
      phase += 1;
      if (phase === 1) {
        yield {
          type: "tool_call",
          id: `call_${phase}`,
          name: "read",
          arguments: JSON.stringify({ path: target }),
        } satisfies ProviderEvent;
        yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
        return;
      }
      yield { type: "text", text: "read the note successfully" } satisfies ProviderEvent;
      yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
    },
  };
}

describe("C-13 — subagent turns carry the parent admissionId", () => {
  test("a child tool is admitted when the parent FIFO row is running, and refused once the row is unknown", async () => {
    const target = path.join(workspace, "note.txt");
    writeFileSync(target, "hello from file\n");
    const store = new SessionStore(workspace);
    const queue = new AdmissionQueue(store);
    const parent = "parent-session";
    const admissionId = queue.admit(parent, "parent turn", "adm-sub");
    expect(queue.begin(admissionId)).toBe(true);

    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    function makeBase(seen: Array<{ status: string; summary?: string }>) {
      return {
        parentSessionId: parent,
        admissionId,
        workspace,
        task: "read the note",
        model: "scripted-1",
        provider: readOnceProvider(target),
        kernel,
        store,
        signal: new AbortController().signal,
        approve: async () => true,
        maxSteps: 3,
        onEvent: (ev: import("../../src/contracts").RuntimeEvent) => {
          const card = ev.type === "subagent.event" ? ev.event : ev;
          if (card.type === "tool.card" && card.status !== "running") {
            seen.push({ status: card.status, summary: card.summary });
          }
        },
      };
    }

    // Parent running: the child's tool call passes the FIFO gate.
    const seenOk: Array<{ status: string; summary?: string }> = [];
    await runNested({ ...makeBase(seenOk), provider: readOnceProvider(target) });
    expect(seenOk.some((c) => c.status === "ok")).toBe(true);

    // Parent row halts its followers: the child's tool call is refused before
    // reaching the guard, proving the child was gated by the PARENT's FIFO.
    expect(queue.settle(admissionId, "unknown", "halt for test")).toBe(true);
    const seenHalted: Array<{ status: string; summary?: string }> = [];
    await runNested({ ...makeBase(seenHalted), provider: readOnceProvider(target) });
    const refused = seenHalted.find((c) => c.status === "error" && (c.summary ?? "").includes("HZ_PRECONDITION_FAILED"));
    expect(refused).toBeDefined();
    expect(refused?.summary).toContain("unknown");

    // Without an admissionId the child stays ungated (old behavior).
    const seenUngated: Array<{ status: string; summary?: string }> = [];
    const { admissionId: _drop, ...noAdmission } = makeBase(seenUngated);
    await runNested({ ...noAdmission, provider: readOnceProvider(target) });
    expect(seenUngated.some((c) => c.status === "ok")).toBe(true);

  });
});

describe("C-13 — atomic batch apply / settle (queue-level, not R170)", () => {
  test("admitBatch inserts a group; duplicate-in-batch and cross-session id-collision are refused", () => {
    const store = new SessionStore(workspace);
    const queue = new AdmissionQueue(store);

    const ok = queue.admitBatch("s1", [
      { id: "b1", input: "call one" },
      { id: "b2", input: "call two" },
    ]);
    expect(ok.ok).toBe(true);
    expect(queue.list("s1").map((r) => r.id)).toEqual(["b1", "b2"]);

    const dup = queue.admitBatch("s1", [
      { id: "x1", input: "one" },
      { id: "x1", input: "two" },
    ]);
    expect(dup).toMatchObject({ ok: false, reason: "duplicate-in-batch" });
    expect(queue.get("x1")).toBeNull();

    expect(queue.admit("s2", "foreign", "foreign-1")).toBe("foreign-1");
    const collision = queue.admitBatch("s1", [
      { id: "fresh", input: "should not survive" },
      { id: "foreign-1", input: "collision" },
    ]);
    expect(collision.ok).toBe(false);
    if (!collision.ok) {
      expect(collision.reason).toBe("id-collision");
      expect(collision.collision?.id).toBe("foreign-1");
      expect(collision.collision?.existingSessionId).toBe("s2");
    }
    // All-or-nothing: the fresh id was rolled back with the collision.
    expect(queue.get("fresh")).toBeNull();
  });

  test("an unknown settled by settleBatch halts the FIFO followers; partial settle is refused", () => {
    const store = new SessionStore(workspace);
    const queue = new AdmissionQueue(store);
    expect(
      queue.admitBatch("s1", [
        { id: "q1", input: "first" },
        { id: "q2", input: "second" },
      ]).ok,
    ).toBe(true);

    // A partial settle (one valid id + one unknown id) rolls back entirely.
    expect(queue.settleBatch("s1", ["q1", "does-not-exist"], "done")).toBe(false);
    expect(queue.get("q1")?.state).toBe("queued");

    expect(queue.begin("q1")).toBe(true);
    expect(queue.settleBatch("s1", ["q1"], "unknown")).toBe(true);
    const next = queue.nextRunnable("s1");
    expect(next.runnable).toBe(false);
    if (!next.runnable) {
      expect(next.halted).toBe(true);
      expect((next as { blockedBy?: string }).blockedBy).toBe("q1");
    }
    expect(queue.begin("q2")).toBe(false);
  });
});
