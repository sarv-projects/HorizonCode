/**
 * r170-sqlite-todo.test.ts — P0-3 reduction: a durable todo is a SQLite mutator.
 *
 * With HZ_TODO_DURABLE=1 the todo tool writes handoffs.db, but it was not in the
 * R170 SQLite mutation set, so the reconcile gates treated it as a non-mutator.
 * It is now a SQLite mutator exactly while that store is enabled, and fails
 * closed under the R170 gates like memory/handoff writes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { isR170MutatingTool, mutationResourceTargets } from "../../src/core/effect-resource-gate";

const previous = process.env.HZ_TODO_DURABLE;
afterEach(() => {
  if (previous === undefined) delete process.env.HZ_TODO_DURABLE;
  else process.env.HZ_TODO_DURABLE = previous;
});

describe("durable todos under R170", () => {
  test("is a mutating tool only while the durable store is on", () => {
    delete process.env.HZ_TODO_DURABLE;
    expect(isR170MutatingTool("todo")).toBe(false);
    process.env.HZ_TODO_DURABLE = "1";
    expect(isR170MutatingTool("todo")).toBe(true);
    expect(isR170MutatingTool("todo_write")).toBe(true);
  });

  test("resource targets are unprovable (fail closed) while durable", () => {
    process.env.HZ_TODO_DURABLE = "1";
    expect(mutationResourceTargets("todo", {}, "/ws")).toBeUndefined();
    delete process.env.HZ_TODO_DURABLE;
    expect(isR170MutatingTool("todo_write")).toBe(false);
  });
});
