/**
 * todo-alias-exposure.test.ts — D-13 residual: one model-facing checklist tool.
 *
 * `todo` and `todo_write` were two identical specs in the model's tool list.
 * The Engram-style name stays resolvable for compatibility but is HIDDEN from
 * every spec list, so the model sees one checklist tool and a stale client call
 * still dispatches.
 */

import { describe, expect, test } from "bun:test";
import { getTool, toolSpecs } from "../../src/tools";

describe("todo alias exposure", () => {
  test("tool_write is not in the model spec list", () => {
    const names = toolSpecs().map((spec) => spec.name);
    expect(names).toContain("todo");
    expect(names).not.toContain("todo_write");
  });

  test("the alias still resolves for dispatch", () => {
    expect(getTool("todo_write")?.name).toBe("todo_write");
    expect(getTool("todo")?.name).toBe("todo");
  });
});
