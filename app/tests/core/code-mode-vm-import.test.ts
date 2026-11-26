/**
 * code-mode-vm-import.test.ts — VM IMPORT with a data-driven module registry
 * (opencode IMPORT opcode 24 ADAPT). Modules are injected; unknown modules fail
 * closed. No filesystem/node require, no eval.
 */
import { describe, expect, test } from "bun:test";
import { Op } from "../../src/core/code-mode-vm";
import {
  createModuleRegistry,
  type ModuleRegistry,
} from "../../src/core/code-mode-modules";
import { runBytecode } from "../../src/core/code-mode-vm";

describe("Code Mode VM module imports", () => {
  const registry = createModuleRegistry({
    math: { PI: 3.14, double: (n: number) => n * 2 },
  });

  test("IMPORT pushes the registered module object; property read via GET_PROP", () => {
    const p = {
      words: [Op.IMPORT, 0, Op.GET_PROP, 1, Op.RETURN],
      consts: ["math", "PI"],
    };
    expect(runBytecode(p, { modules: registry }).value).toBe(3.14);
  });

  test("unknown module is a typed refusal (fail closed)", () => {
    const p = { words: [Op.IMPORT, 0, Op.RETURN], consts: ["missing"] };
    expect(() => runBytecode(p, { modules: registry })).toThrow(/module|import/i);
  });

  test("the same module name resolves deterministically; registry is data-driven", () => {
    const r2: ModuleRegistry = createModuleRegistry({ math: { PI: 3.14 } });
    expect(r2.get("math")).toEqual({ PI: 3.14 });
    expect(r2.get("other")).toBeUndefined();
    expect(r2.names()).toEqual(["math"]);
  });
});
