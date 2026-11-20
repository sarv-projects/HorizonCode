import { describe, expect, test } from "bun:test";
import type { ToolContext, ToolResult } from "../../src/contracts";
import { agentTool } from "../../src/tools/agent";
import { bestOfNTool } from "../../src/tools/best-of-n";

function ctx(delegate: (task: string) => Promise<ToolResult>): ToolContext {
  return {
    cwd: "/tmp/repo",
    workspace: "/tmp/repo",
    sessionId: "sess-test-001",
    signal: new AbortController().signal,
    guard: async () => ({ decision: "allow", title: "", kind: "other" }),
    approve: async () => true,
    receipt: async (rec) => ({
      id: "r1",
      seq: 1,
      sessionId: rec.sessionId,
      tool: rec.tool,
      status: rec.status,
      createdAt: new Date().toISOString(),
    }),
    delegate: (task) => delegate(task),
  };
}

describe("best_of_n tool", () => {
  test("requires task and delegate", async () => {
    const noTask = await bestOfNTool.execute({}, ctx(async () => ({ ok: true, output: "" })));
    expect(noTask.ok).toBe(false);
    const base = { ...ctx(async () => ({ ok: true, output: "" })) };
    delete base.delegate;
    const noDel = await bestOfNTool.execute({ task: "x" }, base);
    expect(noDel.error).toBe("delegation unavailable");
  });

  test("fail closed when racing disabled", async () => {
    const prev = process.env.HZ_BEST_OF_N;
    delete process.env.HZ_BEST_OF_N;
    try {
      const out = await bestOfNTool.execute({ task: "do thing", n: 2 }, ctx(async () => ({ ok: true, output: "" })));
      expect(out.ok).toBe(false);
      expect(out.error).toBe("best-of-n: racing disabled");
    } finally {
      if (prev === undefined) delete process.env.HZ_BEST_OF_N;
      else process.env.HZ_BEST_OF_N = prev;
    }
  });

  test("runs n attempts via delegate when HZ_BEST_OF_N set", async () => {
    const prev = process.env.HZ_BEST_OF_N;
    process.env.HZ_BEST_OF_N = "2";
    try {
      let n = 0;
      const out = await bestOfNTool.execute(
        { task: "do thing" },
        ctx(async () => {
          n += 1;
          return n === 1 ? { ok: false, output: "", error: "fail" } : { ok: true, output: "ok body" };
        }),
      );
      expect(n).toBe(2);
      expect(out.ok).toBe(true);
      expect(out.output).toContain("ok body");
    } finally {
      if (prev === undefined) delete process.env.HZ_BEST_OF_N;
      else process.env.HZ_BEST_OF_N = prev;
    }
  });

  test("parallel mode runs all attempts when HZ_BEST_OF_N_PARALLEL=1", async () => {
    const prevN = process.env.HZ_BEST_OF_N;
    const prevP = process.env.HZ_BEST_OF_N_PARALLEL;
    process.env.HZ_BEST_OF_N = "2";
    process.env.HZ_BEST_OF_N_PARALLEL = "1";
    try {
      let n = 0;
      const out = await bestOfNTool.execute(
        { task: "do thing" },
        ctx(async () => {
          n += 1;
          return n === 2 ? { ok: true, output: "slot-1 wins" } : { ok: false, output: "slot-0" };
        }),
      );
      expect(n).toBe(2);
      expect(out.ok).toBe(true);
      expect(out.output).toContain("slot-1 wins");
    } finally {
      if (prevN === undefined) delete process.env.HZ_BEST_OF_N;
      else process.env.HZ_BEST_OF_N = prevN;
      if (prevP === undefined) delete process.env.HZ_BEST_OF_N_PARALLEL;
      else process.env.HZ_BEST_OF_N_PARALLEL = prevP;
    }
  });

  test("exposure is deferred and exclusive", () => {
    expect(bestOfNTool.exposure).toBe("deferred");
    expect(bestOfNTool.concurrencyClass).toBe("exclusive");
  });

  test("agent profile=code honors HZ_BEST_OF_N", async () => {
    const prev = process.env.HZ_BEST_OF_N;
    process.env.HZ_BEST_OF_N = "2";
    try {
      let calls = 0;
      const out = await agentTool.execute(
        { task: "race task", profile: "code" },
        ctx(async () => {
          calls += 1;
          return calls === 1 ? { ok: true, output: "first wins" } : { ok: true, output: "second" };
        }),
      );
      expect(calls).toBe(1);
      expect(out.ok).toBe(true);
      expect(out.output).toContain("first wins");
    } finally {
      if (prev === undefined) delete process.env.HZ_BEST_OF_N;
      else process.env.HZ_BEST_OF_N = prev;
    }
  });
});