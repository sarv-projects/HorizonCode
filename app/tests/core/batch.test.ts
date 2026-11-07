/**
 * batch.test.ts — NF-072: per-tool concurrency classes and parallel batches.
 *
 * Acceptance (docs/24 §12.2 #64): shared calls in a batch run concurrently,
 * an exclusive call is its own barrier, one call's failure cancels no sibling,
 * and every call still produces its own receipt on one verifying chain.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, Tool, ToolContext, ToolResult } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { batchSegments, concurrencyClassOf, runTurn } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";
import { readTool } from "../../src/tools/read";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-batch-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** A provider that plays one scripted turn per call. */
function scriptedProvider(turns: ProviderEvent[][]): Provider {
  let index = 0;
  return {
    name: "scripted",
    async *stream() {
      const events = turns[Math.min(index, turns.length - 1)] ?? [];
      index += 1;
      for (const event of events) yield event;
    },
  };
}

/** One model turn: the given tool calls, then stopReason tool_use. */
function calls(...specs: Array<{ name: string; args: Record<string, unknown> }>): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  specs.forEach((spec, i) => {
    events.push({ type: "tool_call", id: `call_${i + 1}`, name: spec.name, arguments: JSON.stringify(spec.args) });
  });
  events.push({ type: "done", stopReason: "tool_use" });
  return events;
}

const DONE: ProviderEvent[] = [{ type: "done", stopReason: "end" }];

/**
 * Instrument one tool's execute so overlapping executions are observable: the
 * depth counter is deterministic evidence that two siblings were inside their
 * tool at the same time (wall-clock timing alone is too noisy for CI).
 */
function trackOverlap(tool: Tool, delayMs = 120): { max: number; restore(): void } {
  const original = tool.execute;
  let depth = 0;
  let max = 0;
  tool.execute = async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    depth += 1;
    max = Math.max(max, depth);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      return await original.call(tool, args, ctx);
    } finally {
      depth -= 1;
    }
  };
  return {
    get max() {
      return max;
    },
    restore: () => {
      tool.execute = original;
    },
  };
}

function depsFor(
  provider: Provider,
  approvals: Array<{ title: string }>,
): { deps: LoopDeps; kernel: KernelClient; store: SessionStore } {
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") }); // local fallback
  const store = new SessionStore(workspace);
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("batch").id,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: () => undefined },
    sessionLeases: [],
    approve: async (req) => {
      approvals.push({ title: req.title });
      return true;
    },
  };
  return { deps, kernel, store };
}

function toolContents(store: SessionStore, sessionId: string, name: string): string[] {
  return store
    .history(sessionId)
    .filter((m) => m.role === "tool" && m.toolName === name)
    .map((m) => m.content);
}

describe("concurrency classes (NF-072)", () => {
  test("mutating and lifecycle tools are exclusive; reads and search share", () => {
    expect(concurrencyClassOf("edit")).toBe("exclusive");
    expect(concurrencyClassOf("write")).toBe("exclusive");
    expect(concurrencyClassOf("todo")).toBe("exclusive");
    expect(concurrencyClassOf("agent")).toBe("exclusive");
    expect(concurrencyClassOf("code_mode")).toBe("exclusive");
    expect(concurrencyClassOf("preview")).toBe("exclusive");
    expect(concurrencyClassOf("shell")).toBe("exclusive"); // R-tools-39: shell is serial
    expect(concurrencyClassOf("read")).toBe("shared");
    expect(concurrencyClassOf("grep")).toBe("shared");
    expect(concurrencyClassOf("glob")).toBe("shared");
    expect(concurrencyClassOf("repo_map")).toBe("shared");
    expect(concurrencyClassOf("not-a-tool")).toBe("shared"); // pure error paths share
  });

  test("batchSegments: shared runs, exclusive barriers, and a trailing shared run", () => {
    const mk = (id: string, name: string) => ({ id, name, arguments: "{}" });
    expect(batchSegments([])).toEqual([]);
    expect(batchSegments([mk("1", "read"), mk("2", "grep"), mk("3", "glob")])).toHaveLength(1);
    const mixed = batchSegments([mk("1", "read"), mk("2", "shell"), mk("3", "edit"), mk("4", "read"), mk("5", "write")]);
    expect(mixed.map((segment) => segment.map((call) => call.id))).toEqual([["1"], ["2"], ["3"], ["4"], ["5"]]);
  });
});

describe("parallel batches through the loop", () => {
  test(
    "two shared read calls run concurrently in one segment (overlapping execute on one verifying chain)",
    async () => {
      writeFileSync(path.join(workspace, "a.txt"), "alpha-content\n", "utf8");
      writeFileSync(path.join(workspace, "b.txt"), "beta-content\n", "utf8");

      // The tracker records how many shared reads are inside execute at once;
      // the 300ms delay makes a serial schedule (>= 2 x 300ms) impossible under
      // the overlap assertion. Wall clock is a second witness only.
      const tracker = trackOverlap(readTool, 300);
      try {
        const approvals: Array<{ title: string }> = [];
        const provider = scriptedProvider([
          calls({ name: "read", args: { path: "a.txt" } }, { name: "read", args: { path: "b.txt" } }),
          DONE,
        ]);
        const { deps, kernel, store } = depsFor(provider, approvals);
        try {
          const started = Date.now();
          await runTurn(deps, "read two files");
          const elapsed = Date.now() - started;

          expect(tracker.max).toBe(2);
          expect(elapsed).toBeLessThan(550);

          const reads = toolContents(store, deps.sessionId, "read");
          expect(reads.length).toBe(2);
          expect(reads.some((c) => c.includes("alpha-content"))).toBe(true);
          expect(reads.some((c) => c.includes("beta-content"))).toBe(true);

          // Every call still settles its own receipt, and both chains verify.
          const receipts = await kernel.verifyReceipts();
          expect(receipts.ok).toBe(true);
          expect(receipts.count).toBe(2);
          const chain = await kernel.verifyEventChain(`session:${deps.sessionId}`);
          expect(chain.ok).toBe(true);
          const events = await kernel.readEvents(`session:${deps.sessionId}`);
          expect(events.filter((e) => e.type === "tool.result").length).toBe(2);
          expect(events.filter((e) => e.type === "receipt.issued").length).toBe(2);
        } finally {
          await kernel.close();
          store.close();
        }
      } finally {
        tracker.restore();
      }
    },
    20000,
  );

  test(
    "two shell calls in one batch serialize: the first command finishes before the second starts",
    async () => {
      const approvals: Array<{ title: string }> = [];
      const provider = scriptedProvider([
        calls(
          { name: "shell", args: { command: "sleep 0.4; printf first >> order.txt" } },
          { name: "shell", args: { command: "sleep 0.4; printf second >> order.txt" } },
        ),
        DONE,
      ]);
      const { deps, kernel, store } = depsFor(provider, approvals);
      try {
        const started = Date.now();
        await runTurn(deps, "ordered shell calls");
        const elapsed = Date.now() - started;

        // Overlapping calls would let the second write during the first's 400ms
        // sleep ("secondfirst"); an exclusive barrier orders them.
        expect(readFileSync(path.join(workspace, "order.txt"), "utf8")).toBe("firstsecond");
        // Serial: the second call only began after the first finished its sleep.
        expect(elapsed).toBeGreaterThanOrEqual(750);

        const shells = toolContents(store, deps.sessionId, "shell");
        expect(shells.length).toBe(2);
        for (const content of shells) expect(content).toContain("exit 0");
        const receipts = await kernel.verifyReceipts();
        expect(receipts.ok).toBe(true);
        expect(receipts.count).toBe(2);
      } finally {
        await kernel.close();
        store.close();
      }
    },
    20000,
  );

  test("one call's failure cancels no sibling; both settle and take receipts", async () => {
    const approvals: Array<{ title: string }> = [];
    const provider = scriptedProvider([
      calls({ name: "read", args: { path: "definitely-missing.txt" } }, { name: "shell", args: { command: "echo sibling-ran" } }),
      DONE,
    ]);
    const { deps, kernel, store } = depsFor(provider, approvals);
    try {
      await runTurn(deps, "mixed failure");
      const reads = toolContents(store, deps.sessionId, "read");
      const shells = toolContents(store, deps.sessionId, "shell");
      expect(reads.length).toBe(1);
      expect(reads[0]).toContain("file not found");
      expect(shells.length).toBe(1);
      expect(shells[0]).toContain("sibling-ran");
      const receipts = await kernel.verifyReceipts();
      expect(receipts.ok).toBe(true);
      expect(receipts.count).toBe(2);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("an exclusive call forms its own barrier: the shell write before it is visible", async () => {
    const approvals: Array<{ title: string }> = [];
    const provider = scriptedProvider([
      calls(
        { name: "shell", args: { command: "printf 'one\\n' > barrier.txt" } },
        { name: "edit", args: { path: "barrier.txt", old: "one", new: "two" } },
      ),
      DONE,
    ]);
    const { deps, kernel, store } = depsFor(provider, approvals);
    try {
      await runTurn(deps, "shell then edit");
      // If the barrier were ignored, edit would run first (file not found) and
      // the file would still read "one".
      expect(readFileSync(path.join(workspace, "barrier.txt"), "utf8")).toBe("two\n");
      const edits = toolContents(store, deps.sessionId, "edit");
      expect(edits.length).toBe(1);
      expect(edits[0]).toContain("Replaced 1 occurrence(s)");
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("concurrent asks on different targets keep their own answers (keyed approvals)", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "hz-batch-outside-"));
    try {
      writeFileSync(path.join(outside, "a.txt"), "alpha-content\n", "utf8");
      writeFileSync(path.join(outside, "b.txt"), "beta-content\n", "utf8");
      const approvals: Array<{ title: string }> = [];
      const provider = scriptedProvider([
        calls(
          { name: "read", args: { path: path.join(outside, "a.txt") } },
          { name: "read", args: { path: path.join(outside, "b.txt") } },
        ),
        DONE,
      ]);
      const { deps, kernel, store } = depsFor(provider, approvals);
      try {
        await runTurn(deps, "read two outside files");
        // Each outside read asked exactly once and was cached per action.
        expect(approvals.length).toBe(2);
        const reads = toolContents(store, deps.sessionId, "read");
        expect(reads.length).toBe(2);
        expect(reads.some((c) => c.includes("alpha-content"))).toBe(true);
        expect(reads.some((c) => c.includes("beta-content"))).toBe(true);
        const receipts = await kernel.verifyReceipts();
        expect(receipts.ok).toBe(true);
        expect(receipts.count).toBe(2);
      } finally {
        await kernel.close();
        store.close();
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
