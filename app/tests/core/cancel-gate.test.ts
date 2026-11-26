/**
 * cancel-gate.test.ts -- cooperative cancel gate (plan Task 18).
 * Refuses NEW dispatches only; never force-kills an executing tool.
 */
import { describe, expect, test } from "bun:test";
import type { ToolCall } from "../../src/contracts";
import { CancelGateError, createCancelGate } from "../../src/core/cancel-gate";
import { runClassedToolBatchFifo } from "../../src/core/tool-batch-fifo";

describe("cooperative cancel gate", () => {
  test("an already-aborted gate refuses before effect; a live gate passes", () => {
    const ac = new AbortController();
    const gate = createCancelGate(ac.signal);
    expect(() => gate.throwIfCancelled()).not.toThrow();
    ac.abort();
    expect(() => gate.throwIfCancelled()).toThrow(CancelGateError);
    expect(createCancelGate().aborted()).toBe(false);
  });

  test("the batch scheduler consults the gate before each runCall", async () => {
    const ac = new AbortController();
    const gate = createCancelGate(ac.signal);
    const started: string[] = [];
    const errors: string[] = [];
    const calls: ToolCall[] = ["1", "2", "3"].map((id) => ({ id, name: "read", arguments: "{}" }));
    const out = await runClassedToolBatchFifo(calls, {
      gate,
      maxConcurrency: 1,
      runCall: async (call) => {
        started.push(call.id);
        ac.abort();
      },
      onCallError: (_call, err) => {
        errors.push(String(err));
      },
    });
    expect(started).toEqual(["1"]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("cancelled before dispatch");
    expect(out.fatal).toBe(false);
  });
});
