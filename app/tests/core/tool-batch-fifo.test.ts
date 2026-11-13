/**
 * tool-batch-fifo.test.ts — explicit FIFO scheduler for classed tool batches (F6).
 */

import { describe, expect, test } from "bun:test";
import type { ToolCall } from "../../src/contracts";
import { batchSegments, runClassedToolBatchFifo } from "../../src/core/tool-batch-fifo";

const mk = (id: string, name: string): ToolCall => ({ id, name, arguments: "{}" });

describe("runClassedToolBatchFifo", () => {
  test("runs segments in order and shared calls overlap", async () => {
    const order: string[] = [];
    let depth = 0;
    let maxDepth = 0;
    const delay = (id: string, ms: number) =>
      new Promise<void>((resolve) => {
        order.push(`start:${id}`);
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
        setTimeout(() => {
          depth -= 1;
          order.push(`end:${id}`);
          resolve();
        }, ms);
      });

    const calls = [mk("1", "read"), mk("2", "read"), mk("3", "shell"), mk("4", "read")];
    const out = await runClassedToolBatchFifo(calls, {
      runCall: async (call) => {
        await delay(call.id, call.id === "3" ? 5 : 40);
      },
    });
    expect(out).toEqual({ aborted: false, fatal: false });
    expect(batchSegments(calls).map((seg) => seg.map((c) => c.id))).toEqual([["1", "2"], ["3"], ["4"]]);
    expect(maxDepth).toBe(2);
    expect(order.indexOf("end:3")).toBeGreaterThan(order.indexOf("end:1"));
    expect(order.indexOf("end:3")).toBeGreaterThan(order.indexOf("end:2"));
    expect(order.indexOf("start:4")).toBeGreaterThan(order.indexOf("end:3"));
  });

  test("stops on fatal from onCallError", async () => {
    const seen: string[] = [];
    const calls = [mk("1", "read"), mk("2", "shell"), mk("3", "read")];
    const out = await runClassedToolBatchFifo(calls, {
      runCall: async (call) => {
        seen.push(call.id);
        if (call.id === "2") throw new Error("boom");
      },
      onCallError: (_call, err) => {
        if (err instanceof Error && err.message === "boom") return "fatal";
      },
    });
    expect(out.fatal).toBe(true);
    expect(seen).toEqual(["1", "2"]);
  });
});
