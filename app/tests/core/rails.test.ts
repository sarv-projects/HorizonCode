/**
 * rails.test.ts — NF-073: loop safety rails.
 *
 * Acceptance (docs/24 §12.2 #65): consecutive format errors hit the cap and
 * exit with their own status while isolated errors recover; a failed-but-billed
 * call is charged; budgets are checked before dispatch with one `0 = unlimited`
 * convention; wall clock terminates independently of spend.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ChatMsg, Provider, ProviderEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import {
  BudgetLedger,
  budgetCountdownLine,
  exitCodeFor,
  HISTORY_LIMIT,
  MAX_CONSECUTIVE_FORMAT_ERRORS,
  PINNED_TASK_MAX_CHARS,
  pinnedTaskStatement,
  runTurn,
  trimHistory,
  type LoopDeps,
} from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-rails-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** A recording provider: one scripted turn per call, every system prompt kept. */
function recordingProvider(turns: ProviderEvent[][]): {
  provider: Provider;
  calls: () => number;
  systems: string[];
} {
  let index = 0;
  const systems: string[] = [];
  const provider: Provider = {
    name: "scripted",
    async *stream(req) {
      systems.push(req.system);
      const events = turns[Math.min(index, turns.length - 1)] ?? [];
      index += 1;
      for (const event of events) yield event;
    },
  };
  return { provider, calls: () => index, systems };
}

function toolCall(name: string, args: unknown, id = "call_1"): ProviderEvent {
  return { type: "tool_call", id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) };
}

const DONE: ProviderEvent[] = [{ type: "done", stopReason: "end" }];

function depsFor(
  provider: Provider,
  events: Array<{ type: string; message?: string }>,
  extra?: Partial<LoopDeps>,
): { deps: LoopDeps; kernel: KernelClient; store: SessionStore } {
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
  const store = new SessionStore(workspace);
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("rails").id,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: (ev) => events.push(ev as { type: string; message?: string }) },
    sessionLeases: [],
    approve: async () => true,
    ...extra,
  };
  return { deps, kernel, store };
}

describe("budgets (NF-073)", () => {
  test("a failed turn is still charged, and the next dispatch is refused", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    const { provider, calls } = recordingProvider([[{ type: "error", message: "boom" }], DONE]);
    const ledger = new BudgetLedger({ maxSteps: 1 });
    const { deps, kernel, store } = depsFor(provider, events, { ledger });
    try {
      const first = await runTurn(deps, "fail once");
      expect(first.exit.terminal).toBe("failed");
      expect(first.exit.detail).toBe("provider_error");
      // The turn failed, but its step was spent: that is the whole point.
      expect(ledger.consumed().steps).toBe(1);
      expect(calls()).toBe(1);

      // Same ceiling, fresh turn: the sentinel refuses before any dispatch.
      const second = await runTurn(deps, "try again");
      expect(second.exit.terminal).toBe("budget_exhausted");
      expect(second.exit.detail).toBe("steps");
      expect(calls()).toBe(1);
      expect(events.some((e) => e.type === "notice" && (e.message ?? "").includes("steps exhausted"))).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("tokens from usage stop the next dispatch; steps may stay unlimited", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    const { provider, calls } = recordingProvider([
      [
        toolCall("read", { path: "missing.txt" }),
        { type: "done", stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 20 } },
      ],
      DONE,
    ]);
    const { deps, kernel, store } = depsFor(provider, events, { budget: { maxSteps: 0, maxTokens: 25 } });
    try {
      const result = await runTurn(deps, "spend tokens");
      // 30 tokens were billed in turn 1; the check before turn 2 stops the run.
      expect(result.exit.terminal).toBe("budget_exhausted");
      expect(result.exit.detail).toBe("tokens");
      expect(calls()).toBe(1);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("0 means unlimited: the run completes and no budget notice appears", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    const { provider, calls } = recordingProvider([
      [toolCall("read", { path: "missing.txt" }), { type: "done", stopReason: "tool_use" }],
      [toolCall("read", { path: "also-missing.txt" }, "call_2"), { type: "done", stopReason: "tool_use" }],
      DONE,
    ]);
    const { deps, kernel, store } = depsFor(provider, events, {
      budget: { maxSteps: 0, maxTokens: 0, maxWallMs: 0 },
    });
    try {
      const result = await runTurn(deps, "stay unlimited");
      expect(result.exit.terminal).toBe("succeeded");
      expect(calls()).toBe(3);
      expect(events.some((e) => (e.message ?? "").includes("budget:"))).toBe(false);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("wall clock terminates independently of spend (an injected clock proves it)", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    let now = 0;
    let calls = 0;
    // The first dispatch itself burns the clock: the next pre-dispatch check
    // must stop the run even though spend (steps, tokens) is unlimited.
    const provider: Provider = {
      name: "scripted",
      async *stream() {
        calls += 1;
        now = 10_000;
        yield toolCall("read", { path: "missing.txt" });
        yield { type: "done", stopReason: "tool_use" };
      },
    };
    const ledger = new BudgetLedger({ maxWallMs: 1, maxSteps: 0, maxTokens: 0 }, undefined, () => now);
    const { deps, kernel, store } = depsFor(provider, events, { ledger });
    try {
      const result = await runTurn(deps, "burn the clock");
      expect(result.exit.terminal).toBe("timeout");
      expect(result.exit.detail).toBe("wall_clock");
      expect(calls).toBe(1);
      expect(events.some((e) => (e.message ?? "").includes("wall clock exhausted"))).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });
});

describe("one ceiling per run tree (NF-073)", () => {
  test("a child checks the parent first and charges it on use", async () => {
    const parent = new BudgetLedger({ maxSteps: 2, maxTokens: 5 });
    const child = parent.child({ maxSteps: 10 });
    expect(await child.check()).toBeUndefined();

    await child.chargeStep();
    await child.chargeStep();
    expect(parent.consumed().steps).toBe(2);
    // The child has slice room left, but the shared ceiling is spent.
    expect(await child.check()).toBe("steps");

    // Tokens are a separate ceiling: a spent step budget must not mask them.
    const tokenParent = new BudgetLedger({ maxTokens: 5 });
    const spender = tokenParent.child({ maxTokens: 100 });
    await spender.chargeTokens(7);
    expect(tokenParent.consumed().tokens).toBe(7);
    expect(await spender.check()).toBe("tokens");
  });

  test("concurrent children cannot both pass the last free slot", async () => {
    const parent = new BudgetLedger({ maxSteps: 3 });
    const kids = [1, 2, 3].map(() => parent.child({ maxSteps: 1 }));
    await Promise.all(kids.map((kid) => kid.check()));
    await Promise.all(kids.map((kid) => kid.chargeStep()));
    expect(parent.consumed().steps).toBe(3);
    const late = parent.child({ maxSteps: 1 });
    expect(await late.check()).toBe("steps");
  });

  test("exitCodeFor maps the canonical table: budgets 5, format cap 1, success 0", () => {
    expect(exitCodeFor({ terminal: "succeeded" })).toBe(0);
    expect(exitCodeFor({ terminal: "budget_exhausted", detail: "steps" })).toBe(5);
    expect(exitCodeFor({ terminal: "timeout", detail: "wall_clock" })).toBe(5);
    expect(exitCodeFor({ terminal: "failed", detail: "format_errors" })).toBe(1);
    expect(exitCodeFor(undefined)).toBe(0);
  });
});

describe("format-error cap (NF-073)", () => {
  const badBatch = (): ProviderEvent[] => [
    toolCall("read", "{{{ not json", "bad_1"),
    { type: "done", stopReason: "tool_use" },
  ];

  test("consecutive invalid-JSON batches hit the cap with their own status", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    const { provider, calls } = recordingProvider([badBatch(), badBatch(), badBatch(), DONE]);
    const { deps, kernel, store } = depsFor(provider, events, { budget: { maxSteps: 100 } });
    try {
      const result = await runTurn(deps, "keep sending junk");
      expect(result.exit.terminal).toBe("failed");
      expect(result.exit.detail).toBe("format_errors");
      expect(exitCodeFor(result.exit)).toBe(1);
      expect(calls()).toBe(MAX_CONSECUTIVE_FORMAT_ERRORS);
      expect(
        events.some(
          (e) =>
            e.type === "error" &&
            (e.message ?? "").includes(`${MAX_CONSECUTIVE_FORMAT_ERRORS} consecutive turns`),
        ),
      ).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("isolated errors recover; the corrective rides the next step's system rail", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    const { provider, calls, systems } = recordingProvider([
      badBatch(),
      [toolCall("read", { path: "missing.txt", id: "good" }), { type: "done", stopReason: "tool_use" }],
      DONE,
    ]);
    const { deps, kernel, store } = depsFor(provider, events, { budget: { maxSteps: 100 } });
    try {
      const result = await runTurn(deps, "recover from one mistake");
      expect(result.exit.terminal).toBe("succeeded");
      expect(calls()).toBe(3);
      // Step 2 carries the corrective; step 3 (after a clean step) does not.
      expect(systems[1] ?? "").toContain("invalid JSON");
      expect(systems[2] ?? "").not.toContain("Runtime note");
      const toolContents = store.history(deps.sessionId).filter((m) => m.role === "tool").map((m) => m.content);
      expect(toolContents.some((c) => c.includes("invalid arguments"))).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });
});

describe("budget countdown (NF-073)", () => {
  test("the step prompt renders the remaining steps and tokens", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    const { provider, systems } = recordingProvider([
      [toolCall("read", { path: "missing.txt" }), { type: "done", stopReason: "tool_use" }],
      DONE,
    ]);
    const { deps, kernel, store } = depsFor(provider, events, { budget: { maxSteps: 5, maxTokens: 1000 } });
    try {
      await runTurn(deps, "watch the budget");
      // Charged before the prompt is built: 5 - 1 = 4 steps remain, tokens intact.
      expect(systems[0] ?? "").toContain("Budget remaining: 4 steps, 1,000 tokens.");
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("unlimited dimensions render no countdown at all", () => {
    expect(budgetCountdownLine({})).toBe("");
    expect(budgetCountdownLine({ steps: 0 })).toBe("Budget remaining: 0 steps.");
    expect(budgetCountdownLine({ wallMs: 90_000 })).toBe("Budget remaining: ~1m30s.");
  });
});

describe("the task statement survives the trim (pinned rail)", () => {
  const TASK = "TASK: remember the deploy target is staging.";

  test("after the window no longer reaches the first user turn, the pinned statement still reaches the model", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    const { provider, systems } = recordingProvider([DONE]);
    const { deps, kernel, store } = depsFor(provider, events, { budget: { maxSteps: 10 } });
    try {
      // The task, then enough later traffic that the newest-message window can no
      // longer reach it — the shape a long session actually produces.
      store.appendMessage(deps.sessionId, { role: "user", content: TASK });
      for (let i = 0; i < HISTORY_LIMIT; i += 1) {
        store.appendMessage(deps.sessionId, { role: "assistant", content: `filler ${i}` });
      }
      store.appendMessage(deps.sessionId, { role: "user", content: "keep going" });

      // The trim really has lost it — without this the test would prove nothing.
      const window = trimHistory(store.history(deps.sessionId));
      expect(window.some((m) => (m.content ?? "").includes("staging"))).toBe(false);

      const result = await runTurn(deps, "and one more turn");
      expect(result.exit.terminal).toBe("succeeded");
      // The rail is the only place it can still come from, and it does.
      expect(systems[0] ?? "").toContain("Pinned task statement");
      expect(systems[0] ?? "").toContain("staging");
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("the pinned statement is bounded, and a session with no user turn has none", () => {
    expect(pinnedTaskStatement([])).toBeUndefined();
    expect(pinnedTaskStatement([{ role: "assistant", content: "hello" }] as ChatMsg[])).toBeUndefined();
    expect(pinnedTaskStatement([{ role: "user", content: "   " }] as ChatMsg[])).toBeUndefined();

    const long = pinnedTaskStatement([{ role: "user", content: "x".repeat(PINNED_TASK_MAX_CHARS + 900) }] as ChatMsg[]) ?? "";
    expect(long).toContain("Pinned task statement");
    // A rail is a reminder, not a second copy of the conversation.
    expect(long.length).toBeLessThan(PINNED_TASK_MAX_CHARS + 200);
    expect(long.endsWith("\u2026")).toBe(true);
  });
});
