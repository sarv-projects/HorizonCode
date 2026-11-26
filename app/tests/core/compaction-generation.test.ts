/**
 * compaction-generation.test.ts -- generation identity and exact-key waiters
 * (plan Task 9). No timers, no background work, no contract change.
 */
import { describe, expect, test } from "bun:test";
import { GenerationWaiters, nextGeneration } from "../../src/core/compaction-generation";

describe("compaction generation identity", () => {
  test("generations are monotonic per session and reject cross-session reuse", () => {
    const g1 = nextGeneration(undefined, "s1", "digest-a");
    expect(g1.generation).toBe(1);
    expect(nextGeneration(g1, "s1", "digest-b").generation).toBe(2);
    expect(() => nextGeneration(g1, "s2", "digest-b")).toThrow(/session/i);
    expect(() => nextGeneration(undefined, "s1", "")).toThrow(/digest/i);
  });

  test("waiters resolve only for their exact generation", async () => {
    const w = new GenerationWaiters();
    const got = w.wait(2);
    let settled = false;
    void got.then(() => { settled = true; });
    w.resolve(1);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(w.pending()).toEqual([2]);
    w.resolve(2);
    await got;
    expect(w.pending()).toEqual([]);
  });

  test("abort rejects with a named error and removes the waiter", async () => {
    const w = new GenerationWaiters();
    const controller = new AbortController();
    const waiting = w.wait(7, controller.signal);
    expect(w.pending()).toEqual([7]);
    controller.abort();
    await expect(waiting).rejects.toThrow(/aborted/i);
    expect(w.pending()).toEqual([]);
  });

  test("rejectAll settles every waiter", async () => {
    const w = new GenerationWaiters();
    const a = w.wait(1);
    const b = w.wait(2);
    w.rejectAll(new Error("compaction failed"));
    await expect(a).rejects.toThrow("compaction failed");
    await expect(b).rejects.toThrow("compaction failed");
    expect(w.pending()).toEqual([]);
  });
});
