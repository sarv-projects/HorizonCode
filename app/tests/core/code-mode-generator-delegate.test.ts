/**
 * code-mode-generator-delegate.test.ts — generator delegation (yield*) ADAPT.
 * A parent generator delegates to a sub-program; the sub's yields are surfaced
 * as the parent's yields, and the sub's final value is pushed back to the parent.
 */
import { describe, expect, test } from "bun:test";
import { Op } from "../../src/core/code-mode-vm";
import { createGenerator, type Generator } from "../../src/core/code-mode-generator";

describe("generator delegation (yield*)", () => {
  test("a delegated sub-generator's yields surface through the parent", () => {
    // Sub: yield 1; yield 2; return 99
    const sub = {
      words: [Op.PUSH_INT, 1, 82, Op.PUSH_INT, 2, 82, Op.PUSH_INT, 99, Op.RETURN],
      consts: [],
    };
    // Parent: YSTAR sub (const 0), then push the sub's result + 1 and return
    const parent = {
      words: [85, 0, Op.PUSH_INT, 1, Op.ADD, Op.RETURN],
      consts: [sub],
      delegates: [sub],
    };
    const g = createGenerator(parent);
    expect(g.next()).toEqual({ value: 1, done: false });
    expect(g.next()).toEqual({ value: 2, done: false });
    expect(g.next()).toEqual({ value: 100, done: true }); // 99 + 1
  });

  test("nested delegation: parent -> child -> grandchild", () => {
    // grandchild yields 7 then returns 8; each parent yields* forwards and returns the final value.
    const grandchild = { words: [Op.PUSH_INT, 7, 82, Op.PUSH_INT, 8, Op.RETURN], consts: [] };
    const child = { words: [85, 0, Op.RETURN], consts: [grandchild], delegates: [grandchild] };
    const parent = { words: [85, 0, Op.RETURN], consts: [child], delegates: [child] };
    const g: Generator = createGenerator(parent);
    expect(g.next().value).toBe(7);
    const final = g.next();
    expect(final.done).toBe(true);
    expect(final.value).toBe(8);
  });

  test("a missing delegate is a typed refusal", () => {
    const g = createGenerator({ words: [85, 5, Op.RETURN], consts: [], delegates: [] });
    expect(() => g.next()).toThrow(/delegate|yield\*/i);
  });
});
