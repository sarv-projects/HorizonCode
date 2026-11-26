/**
 * code-mode-vm.test.ts — minimal genuine stack bytecode VM (opencode VM ADAPT).
 * A real interpreter over a subset of the opcode set: constants, arithmetic,
 * locals, conditional jumps, calls and return — metered by the fuel meter.
 */
import { describe, expect, test } from "bun:test";
import { Op, runBytecode, type BytecodeProgram } from "../../src/core/code-mode-vm";

function program(words: number[], consts: unknown[] = [], locals = 0): BytecodeProgram {
  return { words, consts, localCount: locals };
}

describe("Code Mode stack VM (real interpreter)", () => {
  test("PUSH_INT arithmetic ADD/RETURN computes a value", () => {
    const p = program([
      Op.PUSH_INT, 2,
      Op.PUSH_INT, 3,
      Op.ADD,
      Op.RETURN,
    ]);
    expect(runBytecode(p).value).toBe(5);
  });

  test("locals: store and load", () => {
    const p = program([
      Op.PUSH_INT, 7,
      Op.PUT_LOCAL, 0,
      Op.GET_LOCAL, 0,
      Op.RETURN,
    ], [], 1);
    expect(runBytecode(p).value).toBe(7);
  });

  test("conditional jump: branch on a comparison", () => {
    // if 1 < 2 then return 10 else return 20
    const p = program([
      Op.PUSH_INT, 1,
      Op.PUSH_INT, 2,
      Op.LT,
      Op.JUMP_IF_FALSE, 8,   // to ELSE
      Op.PUSH_INT, 10,
      Op.RETURN,
      Op.PUSH_INT, 20,       // ELSE (word index 8)
      Op.RETURN,
    ]);
    expect(runBytecode(p).value).toBe(10);
  });

  test("DUP + MUL: square a constant", () => {
    const p = program([
      Op.PUSH_CONST, 0,
      Op.DUP,
      Op.MUL,
      Op.RETURN,
    ], [6]);
    expect(runBytecode(p).value).toBe(36);
  });

  test("fuel exhaustion halts with a typed out-of-fuel result", () => {
    const p = program([
      Op.PUSH_INT, 1,
      Op.PUSH_INT, 2,
      Op.ADD,
      Op.RETURN,
    ]);
    const r = runBytecode(p, { initialFuel: 2 });
    expect(r.halted).toBe("out_of_fuel");
  });

  test("malformed bytecode (truncated operand) is a typed refusal", () => {
    expect(() => runBytecode(program([Op.PUSH_INT]))).toThrow(/truncat|operand/i);
  });
});
