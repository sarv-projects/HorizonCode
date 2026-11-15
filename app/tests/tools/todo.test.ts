/** `todo` — add/list/done lifecycle, ids, session isolation, output format. */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  importSnapshottedTodos,
  openTodos,
  parseSnapshottedTodoLine,
  todoTool,
  todoWriteTool,
  todoUpdatedEventPayload,
} from "../../src/tools/todo";
import { mockToolContext, type MockToolContext } from "./helpers";

/** A context with its own session id, so module-level todo state never leaks between tests. */
function sessionCtx(sessionId: string = `todo-${randomUUID()}`): MockToolContext {
  return mockToolContext({ cwd: tmpdir(), sessionId });
}

async function add(ctx: MockToolContext, text: string) {
  return todoTool.execute({ action: "add", text }, ctx);
}

async function list(ctx: MockToolContext) {
  return todoTool.execute({ action: "list" }, ctx);
}

describe("todo tool", () => {
  test("starts empty and lists an explicit empty result", async () => {
    const r = await list(sessionCtx());
    expect(r.ok).toBe(true);
    expect(r.output).toBe("No todos.");
  });

  test("runs the add/list/done lifecycle", async () => {
    const ctx = sessionCtx();
    expect((await add(ctx, "first")).output).toBe("[ ] t1 first");
    expect((await add(ctx, "second")).output).toBe("[ ] t1 first\n[ ] t2 second");
    expect((await add(ctx, "third")).output).toBe("[ ] t1 first\n[ ] t2 second\n[ ] t3 third");

    const done = await todoTool.execute({ action: "done", text: "t2" }, ctx);
    expect(done.ok).toBe(true);
    expect(done.output).toBe("[ ] t1 first\n[x] t2 second\n[ ] t3 third");

    // done state survives, and the list rendering matches the add rendering
    expect((await list(ctx)).output).toBe("[ ] t1 first\n[x] t2 second\n[ ] t3 third");
  });

  test("numbers ids t1, t2, t3 and keeps counting after done", async () => {
    const ctx = sessionCtx();
    const ids: string[] = [];
    for (const text of ["a", "b", "c"]) {
      const r = await add(ctx, text);
      ids.push(r.output.split("\n").at(-1)!.slice(4, 6));
    }
    expect(ids).toEqual(["t1", "t2", "t3"]);
    await todoTool.execute({ action: "done", text: "t1" }, ctx);
    const next = await add(ctx, "d");
    expect(next.output.split("\n").at(-1)).toBe("[ ] t4 d");
  });

  test("renders the checklist format", async () => {
    const ctx = sessionCtx();
    await add(ctx, "write tests");
    await add(ctx, "ship it");
    await todoTool.execute({ action: "done", text: "t2" }, ctx);
    expect((await list(ctx)).output).toBe("[ ] t1 write tests\n[x] t2 ship it");
  });

  test("isolates sessions from each other", async () => {
    const a = sessionCtx("session-a-" + randomUUID());
    const b = sessionCtx("session-b-" + randomUUID());
    await add(a, "only in a");
    expect((await add(a, "also in a")).output).toContain("t2 also in a");

    expect((await list(b)).output).toBe("No todos.");
    expect((await add(b, "only in b")).output).toBe("[ ] t1 only in b");
    expect((await list(a)).output).toBe("[ ] t1 only in a\n[ ] t2 also in a");
  });

  test("shares state between contexts of the same session", async () => {
    const sessionId = `todo-${randomUUID()}`;
    const first = sessionCtx(sessionId);
    const second = sessionCtx(sessionId);
    await add(first, "from the first context");
    expect((await list(second)).output).toBe("[ ] t1 from the first context");
  });

  test("trims item text", async () => {
    const ctx = sessionCtx();
    expect((await add(ctx, "  padded  ")).output).toBe("[ ] t1 padded");
  });

  test("rejects an unknown action", async () => {
    const r = await todoTool.execute({ action: "clear" }, sessionCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("unknown action: clear (expected list, add, done, drop or merge)");
  });

  test("requires text for add", async () => {
    const ctx = sessionCtx();
    expect((await todoTool.execute({ action: "add" }, ctx)).error).toBe("text is required for add");
    expect((await todoTool.execute({ action: "add", text: "   " }, ctx)).error).toBe("text is required for add");
    expect((await list(ctx)).output).toBe("No todos.");
  });

  test("imports snapshotted handoff todo lines", () => {
    const sid = `import-${randomUUID()}`;
    expect(parseSnapshottedTodoLine("[t1] fix lint")).toEqual({ id: "t1", text: "fix lint" });
    expect(parseSnapshottedTodoLine("not a snapshot")).toBeNull();
    const r = importSnapshottedTodos(sid, ["[t1] a", "[t2] b", "[t1] a"]);
    expect(r).toEqual({ added: 2, skipped: 1 });
    expect(openTodos(sid).map((t) => t.text)).toEqual(["a", "b"]);
  });

  test("drop requires reason and hides item from open todos", async () => {
    const ctx = sessionCtx();
    await add(ctx, "maybe later");
    const dropped = await todoTool.execute({ action: "drop", text: "t1", reason: "out of scope" }, ctx);
    expect(dropped.ok).toBe(true);
    expect(dropped.output).toContain("(dropped: out of scope)");
    expect(openTodos(ctx.sessionId)).toEqual([]);
    expect((await list(ctx)).output).toContain("[~]");
  });

  test("requires an id for done and rejects unknown ids", async () => {
    const ctx = sessionCtx();
    expect((await todoTool.execute({ action: "done" }, ctx)).error).toBe("text (item id) is required for done");
    expect((await todoTool.execute({ action: "done", text: "t9" }, ctx)).error).toBe("todo not found: t9");
    await add(ctx, "kept pending");
    expect((await todoTool.execute({ action: "done", text: "t2" }, ctx)).error).toBe("todo not found: t2");
    expect((await list(ctx)).output).toBe("[ ] t1 kept pending");
  });

  test("add refuses duplicate open text", async () => {
    const ctx = sessionCtx();
    await add(ctx, "once");
    const dup = await add(ctx, "once");
    expect(dup.ok).toBe(false);
    expect(dup.error).toBe("duplicate open todo: t1 (same text)");
    expect((await list(ctx)).output).toBe("[ ] t1 once");
  });

  test("merge applies ordered batch ops", async () => {
    const ctx = sessionCtx();
    const r = await todoTool.execute(
      {
        action: "merge",
        ops: [
          { op: "add", text: "a" },
          { op: "add", text: "b" },
          { op: "done", id: "t1" },
        ],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe("[x] t1 a\n[ ] t2 b");
    const dupBatch = await todoTool.execute(
      { action: "merge", ops: [{ op: "add", text: "b" }] },
      ctx,
    );
    expect(dupBatch.error).toBe("ops[0]: duplicate open todo: t2 (same text)");
  });

  test("todo_write mirrors todo checklist behavior", async () => {
    const ctx = sessionCtx();
    expect((await todoWriteTool.execute({ action: "add", text: "ship alias" }, ctx)).ok).toBe(true);
    expect((await todoWriteTool.execute({ action: "list" }, ctx)).output).toContain("ship alias");
  });

  test("todoUpdatedEventPayload maps statuses for hz.todo.updated", async () => {
    const ctx = sessionCtx();
    await add(ctx, "open");
    let payload = todoUpdatedEventPayload(ctx.sessionId, "added");
    expect(payload.revision).toBe(1);
    expect(payload.todos).toEqual([{ id: "t1", text: "open", status: "pending" }]);
    await todoTool.execute({ action: "done", text: "t1" }, ctx);
    payload = todoUpdatedEventPayload(ctx.sessionId, "updated");
    expect(payload.todos[0]?.status).toBe("completed");
    await add(ctx, "later");
    await todoTool.execute({ action: "drop", text: "t2", reason: "n/a" }, ctx);
    payload = todoUpdatedEventPayload(ctx.sessionId, "updated");
    expect(payload.todos.find((t) => t.id === "t2")?.status).toBe("cancelled");
  });
});
