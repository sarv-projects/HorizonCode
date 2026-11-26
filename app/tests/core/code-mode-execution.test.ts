/**
 * code-mode-execution.test.ts — coherent Code Mode execution seam wiring the
 * three previously-separate VM/PTC pieces (snapshot codec + fuel meter + cell
 * host) into one suspend/resume scheduler. Pure, deterministic, no interpreter.
 */
import { describe, expect, test } from "bun:test";
import {
  CodeModeExecution,
  type ExecutionState,
} from "../../src/core/code-mode-execution";
import { Op } from "../../src/core/code-mode-vm";

describe("Code Mode execution seam (suspend/resume)", () => {
  test("a cell runs, suspends on fuel exhaustion, snapshots, and resumes", () => {
    let clock = 0;
    const exec = new CodeModeExecution({
      initialFuel: 2,
      now: () => clock,
    });
    expect(exec.create("cell-1")).toBe("running");

    // Two instruction steps exhaust the fuel -> cooperative suspend + snapshot.
    const r1 = exec.step("cell-1", 1, { value: "partial" });
    expect(r1.verdict).toBe("run");
    const r2 = exec.step("cell-1", 1, { value: "committed" });
    expect(r2.verdict).toBe("suspended");
    expect(r2.snapshot).toBeDefined();
    expect(exec.state("cell-1")).toBe("yielded");
    expect(r2.snapshot!.shape).toBeTruthy();

    // Resume: the cell returns to running with a fresh fuel budget.
    const resumed = exec.resume("cell-1");
    expect(resumed).toBe("running");
    expect(exec.state("cell-1")).toBe("running");
  });

  test("snapshot round-trips the execution state through the graph codec", () => {
    const exec = new CodeModeExecution({ initialFuel: 1, now: () => 0 });
    exec.create("c");
    const r = exec.step("c", 1, { nested: { a: [1, 2, 3] }, s: "x" });
    expect(r.verdict).toBe("suspended");
    const restored = exec.inspectSnapshot(r.snapshot!);
    expect(restored).toMatchObject({ nested: { a: [1, 2, 3] }, s: "x" });
  });

  test("unknown cells and wrong-state operations are typed refusals", () => {
    const exec = new CodeModeExecution();
    expect(() => exec.step("missing", 1, {})).toThrow(/unknown/i);
    exec.create("c");
    expect(() => exec.resume("c")).toThrow(/yielded|state/i); // not suspended yet
  });

  test("runBytecode executes a real program inside the cell and snapshots the result", () => {
    const exec = new CodeModeExecution();
    exec.create("c");
    const r = exec.runBytecode("c", {
      words: [Op.PUSH_INT, 4, Op.PUSH_INT, 5, Op.MUL, Op.RETURN],
      consts: [],
    });
    expect(r.halted).toBe("return");
    expect(r.value).toBe(20);
    expect(exec.executionState("c")!.snapshots).toBe(1);
  });

  test("terminate ends a cell regardless of state", () => {
    const exec = new CodeModeExecution({ initialFuel: 1, now: () => 0 });
    exec.create("c");
    exec.step("c", 1, {}); // suspend -> yielded
    expect(exec.terminate("c")).toBe("terminated");
    expect(exec.state("c")).toBe("terminated");
  });
});
