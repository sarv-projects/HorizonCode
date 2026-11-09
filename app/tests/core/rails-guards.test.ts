/**
 * rails-guards.test.ts — SAFETY-RAILS integration coverage (FEAT-002).
 *
 * The three pure guards are wired into runTurn minimally: a run that repeats one
 * identical SUCCESSFUL tool call five times exits {terminal:'failed',
 * detail:'tool_loop'}; a run whose tool calls fail repeatedly exits
 * {terminal:'failed', detail:'consecutive_mistakes'}; and a repeated call
 * injects an advisory repeat-tool reminder into the transcript without vetoing
 * the call. Every assertion fails if the corresponding rail is reverted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { exitCodeFor, runTurn, type LoopDeps } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-rails-guards-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function toolCall(name: string, args: unknown, id = "call_1"): ProviderEvent {
  return { type: "tool_call", id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) };
}

const DONE: ProviderEvent[] = [{ type: "done", stopReason: "end" }];

/** A provider that always emits the same scripted tool-use turn. */
function repeatingProvider(events: ProviderEvent[]): { provider: Provider; calls: () => number } {
  let index = 0;
  const provider: Provider = {
    name: "scripted",
    async *stream() {
      index += 1;
      for (const event of events) yield event;
    },
  };
  return { provider, calls: () => index };
}

/** A provider that plays one scripted turn per call, last repeating. */
function scriptedProvider(turns: ProviderEvent[][]): { provider: Provider; calls: () => number } {
  let index = 0;
  const provider: Provider = {
    name: "scripted",
    async *stream() {
      const events = turns[Math.min(index, turns.length - 1)] ?? DONE;
      index += 1;
      for (const event of events) yield event;
    },
  };
  return { provider, calls: () => index };
}

function depsFor(
  provider: Provider,
  events: Array<{ type: string; message?: string }>,
  extra?: Partial<LoopDeps>,
): { deps: LoopDeps; kernel: KernelClient; store: SessionStore } {
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
  const store = new SessionStore(workspace);
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("rails-guards").id,
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

describe("loop-detection hard stop (rail 1)", () => {
  test("five identical successful tool calls exit with detail 'tool_loop'", async () => {
    // A real, readable file so the repeated read SUCCEEDS: a success keeps the
    // mistake tracker at zero, so loop-detection (hard at 5) is the rail that
    // fires, not the mistake tracker.
    writeFileSync(path.join(workspace, "a.txt"), "hello");
    const events: Array<{ type: string; message?: string }> = [];
    const { provider, calls } = repeatingProvider([
      toolCall("read", { path: "a.txt" }),
      { type: "done", stopReason: "tool_use" },
    ]);
    const { deps, kernel, store } = depsFor(provider, events, { budget: { maxSteps: 100 } });
    try {
      const result = await runTurn(deps, "keep reading the same file");
      expect(result.exit.terminal).toBe("failed");
      expect(result.exit.detail).toBe("tool_loop");
      expect(exitCodeFor(result.exit)).toBe(1);
      // The hard stop happens on the 5th dispatch, before that batch runs.
      expect(calls()).toBe(5);
      expect(
        events.some((e) => e.type === "error" && (e.message ?? "").includes("stopping to avoid a loop")),
      ).toBe(true);
      // The soft nudge fired earlier (the 3rd identical call).
      expect(
        events.some((e) => e.type === "notice" && (e.message ?? "").includes("consider trying a different approach")),
      ).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });
});

describe("mistake tracker stop (rail 2)", () => {
  test("three distinct failing tool calls exit with detail 'consecutive_mistakes'", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    // Distinct missing paths so loop-detection (which needs 5 IDENTICAL calls)
    // never fires; each failing read is a `tool_execution_failed` mistake.
    const { provider, calls } = scriptedProvider([
      [toolCall("read", { path: "missing-1.txt" }, "c1"), { type: "done", stopReason: "tool_use" }],
      [toolCall("read", { path: "missing-2.txt" }, "c2"), { type: "done", stopReason: "tool_use" }],
      [toolCall("read", { path: "missing-3.txt" }, "c3"), { type: "done", stopReason: "tool_use" }],
      DONE,
    ]);
    const { deps, kernel, store } = depsFor(provider, events, { budget: { maxSteps: 100 } });
    try {
      const result = await runTurn(deps, "keep failing tool calls");
      expect(result.exit.terminal).toBe("failed");
      expect(result.exit.detail).toBe("consecutive_mistakes");
      expect(exitCodeFor(result.exit)).toBe(1);
      expect(calls()).toBe(3);
      expect(
        events.some(
          (e) =>
            e.type === "error" &&
            (e.message ?? "").includes("Session state was preserved. Send a new prompt to resume from the latest state."),
        ),
      ).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });
});

describe("repeat-tool reminder injection (rail 3)", () => {
  test("a repeated successful call injects an advisory reminder without vetoing", async () => {
    writeFileSync(path.join(workspace, "a.txt"), "hello");
    const events: Array<{ type: string; message?: string }> = [];
    // Three identical reads then stop: the 3rd call hits the repeat-tool first
    // threshold (gentle). Loop-detection soft also fires at 3 but never hard
    // (the run stops at turn 4). The reminder must appear as a user message.
    const { provider } = scriptedProvider([
      [toolCall("read", { path: "a.txt" }), { type: "done", stopReason: "tool_use" }],
      [toolCall("read", { path: "a.txt" }), { type: "done", stopReason: "tool_use" }],
      [toolCall("read", { path: "a.txt" }), { type: "done", stopReason: "tool_use" }],
      DONE,
    ]);
    const { deps, kernel, store } = depsFor(provider, events, { budget: { maxSteps: 100 } });
    try {
      const result = await runTurn(deps, "read the same file three times");
      // Advisory, never a veto: the run ends cleanly when the model stops.
      expect(result.exit.terminal).toBe("succeeded");
      const userMessages = store.history(deps.sessionId).filter((m) => m.role === "user").map((m) => m.content);
      expect(userMessages.some((c) => c.includes("[repeat-tool-reminder]"))).toBe(true);
      expect(
        userMessages.some((c) => c.includes("You are repeating the exact same tool call with identical arguments")),
      ).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });
});
