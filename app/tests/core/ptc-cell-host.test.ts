/**
 * ptc-cell-host.test.ts — PTC cell lifecycle controls (deepseek/codex V8 cell
 * host ADAPT). Pure cell registry with yield/wait/terminate, bounded by
 * MAX_ACTIVE_CELLS. No actual code execution here.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_ACTIVE_CELLS,
  PtcCellHost,
  type CellState,
} from "../../src/core/ptc-cell-host";

describe("PTC cell host (yield/wait/terminate)", () => {
  test("cells are created in a bounded registry", () => {
    const h = new PtcCellHost();
    expect(h.create("c1")).toBe("running");
    expect(h.state("c1")).toBe("running");
    expect(h.activeCount()).toBe(1);
    expect(MAX_ACTIVE_CELLS).toBe(2048);
  });

  test("yield suspends a running cell; wait resumes it", () => {
    const h = new PtcCellHost();
    h.create("c1");
    expect(h.yield("c1")).toBe("yielded");
    expect(h.state("c1")).toBe("yielded");
    expect(h.wait("c1")).toBe("running");
    expect(h.state("c1")).toBe("running");
  });

  test("terminate ends a cell; operations on ended cells are refused", () => {
    const h = new PtcCellHost();
    h.create("c1");
    expect(h.terminate("c1")).toBe("terminated");
    expect(h.state("c1")).toBe("terminated");
    expect(() => h.yield("c1")).toThrow(/terminated/i);
    expect(() => h.wait("c1")).toThrow(/terminated/i);
  });

  test("activeCount excludes yielded and terminated cells", () => {
    const h = new PtcCellHost();
    h.create("a"); h.create("b"); h.create("c");
    h.yield("b");
    h.terminate("c");
    expect(h.activeCount()).toBe(1);
    expect(h.total()).toBe(3);
  });

  test("registry cap is enforced", () => {
    const h = new PtcCellHost({ maxActive: 2 });
    h.create("a"); h.create("b");
    expect(() => h.create("c")).toThrow(/cap|limit|active/i);
  });

  test("unknown cell operations are typed refusals", () => {
    const h = new PtcCellHost();
    expect(h.state("missing")).toBeUndefined();
    expect(() => h.yield("missing")).toThrow(/unknown/i);
  });
});
