/**
 * code-mode-vm-closures.test.ts — extend the real VM with cells + closures +
 * CALL (opencode VM opcodes 13/15/16/22/70). A closure captures a cell; CALL
 * pops a callee function and its args and executes the function body.
 */
import { describe, expect, test } from "bun:test";
import { Op, runBytecode, type BytecodeProgram } from "../../src/core/code-mode-vm";

describe("Code Mode VM: cells, closures, calls", () => {
  test("NEW_CELL / PUT_CELL / GET_CELL: a cell holds a mutable value", () => {
    const p: BytecodeProgram = {
      words: [Op.NEW_CELL, 0, Op.PUSH_INT, 10, Op.PUT_CELL, 0, Op.GET_CELL, 0, Op.RETURN],
      consts: [],
    };
    expect(runBytecode(p).value).toBe(10);
  });

  test("CALL a function (CLOSURE with 0 upvals): passes args, returns a value", () => {
    // FUNC starts at word 8. Callee is pushed first, then its arg (CALL pops args from the top).
    const p: BytecodeProgram = {
      words: [
        Op.CLOSURE, 8, 0,      // push function object at word 8, 0 upvals
        Op.PUSH_INT, 6,        // arg
        Op.CALL, 1,            // pop 1 arg, then callee
        Op.RETURN,
        // word 8:
        Op.GET_LOCAL, 0,
        Op.PUSH_INT, 7,
        Op.MUL,
        Op.RETURN,
      ],
      consts: [],
    };
    expect(runBytecode(p).value).toBe(42);
  });

  test("a closure captures a cell; calling it reads the captured value", () => {
    // FUNC starts at word 13.
    const p: BytecodeProgram = {
      words: [
        Op.NEW_CELL, 0,
        Op.PUSH_INT, 5,
        Op.PUT_CELL, 0,
        Op.CLOSURE, 13, 1, 0,  // func at 13, 1 upval = cell[0]
        Op.CALL, 0,
        Op.RETURN,
        Op.NOP,                // word 12 padding so FUNC is at 13
        // word 13:
        Op.GET_UPVAL, 0,
        Op.RETURN,
      ],
      consts: [],
    };
    expect(runBytecode(p).value).toBe(5);
  });

  test("unknown cell/upval indices are typed faults", () => {
    expect(() => runBytecode({ words: [Op.GET_CELL, 3, Op.RETURN], consts: [] })).toThrow(/cell/i);
    expect(() => runBytecode({ words: [Op.GET_UPVAL, 0, Op.RETURN], consts: [] })).toThrow(/upval|closure/i);
  });
});
