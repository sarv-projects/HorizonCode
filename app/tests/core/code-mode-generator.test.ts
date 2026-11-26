/**
 * code-mode-generator.test.ts — VM generators (opencode YIELD/RESUME ADAPT).
 * A real resumable generator engine: explicit suspended frames, next(value),
 * multiple yields, done/final value, fuel metering, typed faults.
 */
import { describe, expect, test } from "bun:test";
import { Op } from "../../src/core/code-mode-vm";
import {
  createGenerator,
  type GeneratorStep,
} from "../../src/core/code-mode-generator";

const YIELD = 82; // upstream Op.YIELD

function gen(words: number[], consts: unknown[] = []) {
  return createGenerator({ words, consts });
}

describe("Code Mode generator engine", () => {
  test("multiple yields then a final return value", () => {
    const g = gen([
      Op.PUSH_INT, 1,
      YIELD,
      Op.PUSH_INT, 2,
      YIELD,
      Op.PUSH_INT, 3,
      Op.RETURN,
    ]);
    expect(g.next()).toEqual({ value: 1, done: false });
    expect(g.next()).toEqual({ value: 2, done: false });
    expect(g.next()).toEqual({ value: 3, done: true });
    expect(g.next()).toEqual({ value: undefined, done: true }); // stays done
  });

  test("resume value is pushed onto the frame stack (x = yield semantics)", () => {
    const g = gen([
      Op.PUSH_INT, 10,
      YIELD,          // yields 10; resume pushes 5
      Op.PUSH_INT, 1,
      Op.ADD,         // 5 + 1 = 6
      Op.RETURN,
    ]);
    expect(g.next().value).toBe(10);
    const r: GeneratorStep = g.next(5);
    expect(r).toEqual({ value: 6, done: true });
  });

  test("fuel exhaustion suspends with a typed result", () => {
    const g = createGenerator({
      words: [Op.PUSH_INT, 1, YIELD, Op.PUSH_INT, 2, YIELD, Op.PUSH_INT, 3, Op.RETURN],
      consts: [],
    }, { initialFuel: 2 });
    const r = g.next();
    expect(r.done).toBe(true);
    expect(r.halted).toBe("out_of_fuel");
  });

  test("a yielded value requires a value on the stack", () => {
    const g = gen([YIELD]);
    expect(() => g.next()).toThrow(/stack|yield/i);
  });
});
