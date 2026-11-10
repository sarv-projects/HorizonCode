/**
 * attempts-remaining.test.ts - T-4: a failed tool result tells the model how
 * many failed steps remain before the mistake tracker stops the run.
 *
 * The note is model-facing text only: the receipt still hashes the tool's own
 * output, and failures that are the system working as designed (a denial, an
 * edit-ladder miss) cost no attempt and carry no note.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { canonicalJson, sha256Hex, type Provider, type ProviderEvent, type ReceiptInput } from "../../src/contracts";
import { attemptsRemainingNote, DEFAULT_MAX_CONSECUTIVE_MISTAKES, MistakeTracker } from "../../src/core/guards/mistake-tracker";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-attempts-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const END: ProviderEvent[] = [{ type: "done", stopReason: "end" }];
const call = (name: string, args: unknown, id: string): ProviderEvent[] => [
  { type: "tool_call", id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  { type: "done", stopReason: "tool_use" },
];

async function run(turns: ProviderEvent[][]) {
  let n = 0;
  const provider: Provider = {
    name: "scripted",
    async *stream() {
      const t = turns[Math.min(n, turns.length - 1)] ?? END;
      n += 1;
      for (const e of t) yield e;
    },
  };
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
  const receipts: ReceiptInput[] = [];
  const issue = kernel.issueReceipt.bind(kernel);
  kernel.issueReceipt = async (input: ReceiptInput) => {
    receipts.push(input);
    return issue(input);
  };
  const store = new SessionStore(workspace);
  const sessionId = store.createSession("attempts").id;
  const deps: LoopDeps = {
    workspace,
    sessionId,
    model: "m",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: () => {} },
    sessionLeases: [],
    approve: async () => true,
    budget: { maxSteps: 100 },
  };
  try {
    const result = await runTurn(deps, "go");
    const tools = store.history(sessionId).filter((m) => m.role === "tool");
    return { result, tools: tools.map((m) => m.content), receipts };
  } finally {
    await kernel.close();
    store.close();
  }
}

describe("attemptsRemainingNote / MistakeTracker.remaining", () => {
  test("counts down with the streak and bottoms out at 0", () => {
    const t = new MistakeTracker();
    expect(t.remaining).toBe(DEFAULT_MAX_CONSECUTIVE_MISTAKES);
    t.record({ reason: "tool_execution_failed" });
    expect(t.remaining).toBe(DEFAULT_MAX_CONSECUTIVE_MISTAKES - 1);
    t.reset();
    expect(t.remaining).toBe(DEFAULT_MAX_CONSECUTIVE_MISTAKES);
    for (let i = 0; i < 10; i++) t.record({ reason: "api_error" });
    expect(t.remaining).toBe(0);
  });
  test("a disabled limit shows no number", () => {
    expect(new MistakeTracker({ maxConsecutiveMistakes: 0 }).remaining).toBe(Number.POSITIVE_INFINITY);
    expect(attemptsRemainingNote(Number.POSITIVE_INFINITY)).toBe("");
  });
  test("the note text is stable", () => {
    expect(attemptsRemainingNote(2)).toBe("\n[attempts remaining before this run stops: 2]");
    expect(attemptsRemainingNote(-1)).toBe("\n[attempts remaining before this run stops: 0]");
  });
});

describe("failed tool results carry the remaining budget", () => {
  test("three failing reads read 2, 1, 0 and the run stops", async () => {
    const { tools, result } = await run([
      call("read", { path: "missing-1.txt" }, "c1"),
      call("read", { path: "missing-2.txt" }, "c2"),
      call("read", { path: "missing-3.txt" }, "c3"),
      END,
    ]);
    expect(result.exit.detail).toBe("consecutive_mistakes");
    expect(tools).toHaveLength(3);
    expect(tools[0]).toEndWith("[attempts remaining before this run stops: 2]");
    expect(tools[1]).toEndWith("[attempts remaining before this run stops: 1]");
    expect(tools[2]).toEndWith("[attempts remaining before this run stops: 0]");
  });

  test("a success resets the count and carries no note", async () => {
    writeFileSync(path.join(workspace, "ok.txt"), "fine");
    const { tools } = await run([
      call("read", { path: "missing-1.txt" }, "c1"),
      call("read", { path: "ok.txt" }, "c2"),
      call("read", { path: "missing-2.txt" }, "c3"),
      END,
    ]);
    expect(tools[0]).toEndWith("[attempts remaining before this run stops: 2]");
    expect(tools[1]).not.toContain("attempts remaining");
    // After the success the streak restarted, so the next failure is back to 2.
    expect(tools[2]).toEndWith("[attempts remaining before this run stops: 2]");
  });

  test("an unparseable-arguments failure names the tighter of the two caps", async () => {
    const { tools } = await run([call("read", "not json at all", "c1"), END]);
    expect(tools[0]).toContain("[attempts remaining before this run stops: 2]");
  });

  test("an edit-ladder miss is an expected failure: it costs no attempt and has no note", async () => {
    writeFileSync(path.join(workspace, "f.txt"), "alpha\nbeta\n");
    const { tools } = await run([
      call("edit", { path: "f.txt", old_string: "does not exist anywhere", new_string: "x" }, "c1"),
      END,
    ]);
    expect(tools[0]).toBeDefined();
    expect(tools[0]).not.toContain("attempts remaining");
  });

  test("the receipt digest is of the tool's own output, not the note", async () => {
    const { receipts, tools } = await run([call("read", { path: "missing-1.txt" }, "c1"), END]);
    expect(tools[0]).toContain("attempts remaining");
    expect(receipts).toHaveLength(1);
    // The note is appended after the receipt's result digest was fixed.
    const stripped = (tools[0] ?? "").replace(/\n\[attempts remaining[^\]]*\]$/, "");
    expect(stripped).not.toContain("attempts remaining");
    expect(receipts[0]?.argsDigest).toBe(sha256Hex(canonicalJson({ path: "missing-1.txt" })));
    expect(receipts[0]?.resultDigest).not.toBe(sha256Hex(tools[0] ?? ""));
  });
});
