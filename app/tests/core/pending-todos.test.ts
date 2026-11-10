/**
 * pending-todos.test.ts - T-3: the end-of-turn pending-todos re-check.
 *
 * When the model ends a turn while the session todo list has open items, the
 * loop injects ONE bounded reminder and allows one more step. It never loops a
 * second time, has no effect without todos, and still obeys budgets and abort.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, ProviderRequest, RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { pendingTodosReminder, runTurn, type LoopDeps } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-pending-todos-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const END: ProviderEvent[] = [{ type: "text", text: "all done" }, { type: "done", stopReason: "end" }];
const todo = (args: unknown, id: string): ProviderEvent[] => [
  { type: "tool_call", id, name: "todo", arguments: JSON.stringify(args) },
  { type: "done", stopReason: "tool_use" },
];

function scripted(turns: ProviderEvent[][]): { provider: Provider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    name: "scripted",
    async *stream(req) {
      requests.push(req);
      for (const e of turns[Math.min(requests.length - 1, turns.length - 1)] ?? END) yield e;
    },
  };
  return { provider, requests };
}

async function run(turns: ProviderEvent[][], extra?: Partial<LoopDeps>, signal?: AbortSignal) {
  const { provider, requests } = scripted(turns);
  const events: RuntimeEvent[] = [];
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
  const store = new SessionStore(workspace);
  const sessionId = store.createSession("todos").id;
  const deps: LoopDeps = {
    workspace,
    sessionId,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: signal ?? new AbortController().signal,
    callbacks: { onEvent: (ev) => events.push(ev) },
    sessionLeases: [],
    approve: async () => true,
    ...extra,
  };
  try {
    const result = await runTurn(deps, "do the thing");
    const history = store.history(sessionId);
    return { result, events, requests, history };
  } finally {
    await kernel.close();
    store.close();
  }
}

const reminders = (history: Array<{ role: string; content: string }>) =>
  history.filter((m) => m.role === "user" && m.content.startsWith("[pending-todos-reminder]"));

describe("pending todos re-check", () => {
  test("open todos at the end of a turn: one reminder, one more step, then it settles", async () => {
    const { requests, history, events, result } = await run([todo({ action: "add", text: "write the tests" }, "c1"), END]);
    // step 1 add, step 2 ends with an open item, step 3 is the extra step, which also ends: NOT a fourth.
    expect(requests).toHaveLength(3);
    const r = reminders(history);
    expect(r).toHaveLength(1);
    expect(r[0]?.content).toContain("1 todo item is still open");
    expect(r[0]?.content).toContain("t1 write the tests");
    expect(events.filter((e) => e.type === "notice" && e.message.includes("still open: giving the model one more step"))).toHaveLength(1);
    // The reminder reached the model on the extra step.
    expect(JSON.stringify(requests[2]?.messages)).toContain("[pending-todos-reminder]");
    // Stopping again with the item open is not silent success.
    expect(result.exit.terminal).not.toBe("failed");
  });

  test("the extra step can finish the work: the model marks it done and the run succeeds", async () => {
    const { requests, history, result } = await run([
      todo({ action: "add", text: "ship it" }, "c1"),
      END,
      todo({ action: "done", text: "t1" }, "c2"),
      END,
    ]);
    expect(requests).toHaveLength(4);
    expect(reminders(history)).toHaveLength(1);
    expect(result.exit.terminal).toBe("succeeded");
  });

  test("never more than one reminder per turn, even if items stay open for many steps", async () => {
    const { requests, history } = await run([
      todo({ action: "add", text: "a" }, "c1"),
      END,
      todo({ action: "add", text: "b" }, "c2"),
      END,
      END,
    ]);
    expect(reminders(history)).toHaveLength(1);
    expect(requests).toHaveLength(4);
  });

  test("no todos: no reminder, no extra step", async () => {
    const { requests, history } = await run([END]);
    expect(requests).toHaveLength(1);
    expect(reminders(history)).toHaveLength(0);
  });

  test("all todos done: no reminder", async () => {
    const { requests, history } = await run([todo({ action: "add", text: "x" }, "c1"), todo({ action: "done", text: "t1" }, "c2"), END]);
    expect(requests).toHaveLength(3);
    expect(reminders(history)).toHaveLength(0);
  });

  test("the step budget still binds the extra step", async () => {
    const { requests, result } = await run([todo({ action: "add", text: "x" }, "c1"), END], { budget: { maxSteps: 2 } });
    expect(requests).toHaveLength(2);
    expect(result.exit.terminal).toBe("budget_exhausted");
  });

  test("an aborted run gets no extra step", async () => {
    const ac = new AbortController();
    const turns = [todo({ action: "add", text: "x" }, "c1"), END];
    let n = 0;
    const provider: Provider = {
      name: "scripted",
      async *stream() {
        n += 1;
        if (n === 2) ac.abort();
        for (const e of turns[Math.min(n - 1, turns.length - 1)] ?? END) yield e;
      },
    };
    const events: RuntimeEvent[] = [];
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const store = new SessionStore(workspace);
    const sessionId = store.createSession("todos").id;
    try {
      const result = await runTurn(
        { workspace, sessionId, model: "m", provider, kernel, store, signal: ac.signal, callbacks: { onEvent: (e) => events.push(e) }, sessionLeases: [], approve: async () => true },
        "go",
      );
      expect(result.exit.terminal).toBe("interrupted");
      expect(n).toBe(2);
      expect(reminders(store.history(sessionId))).toHaveLength(0);
    } finally {
      await kernel.close();
      store.close();
    }
  });
});

describe("pendingTodosReminder text", () => {
  test("is bounded: at most 5 items named, long texts truncated, the rest counted", async () => {
    // Populate a session through the real tool so the store is the production one.
    const { getTool } = await import("../../src/tools");
    const tool = getTool("todo");
    const sid = "reminder-bounds";
    for (let i = 0; i < 8; i++) await tool?.execute({ action: "add", text: `item ${i} ${"x".repeat(200)}` }, { sessionId: sid, workspace } as never);
    const r = pendingTodosReminder(sid);
    expect(r?.open).toBe(8);
    expect(r?.text).toContain("8 todo items are still open");
    expect(r?.text).toContain("and 3 more");
    expect(r?.text).not.toContain("t6");
    expect(r?.text.length).toBeLessThan(700);
    expect(pendingTodosReminder("no-such-session")).toBeUndefined();
  });
});
