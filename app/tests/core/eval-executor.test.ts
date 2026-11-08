/**
 * eval-executor.test.ts — the live-loop executor (core/eval-executor.ts).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent } from "../../src/contracts";
import type { PostmortemEvalCase } from "../../src/core/evals";
import { runEvalCase } from "../../src/core/evals";
import { makeRuntimeExecutor, makeScriptedExecutor } from "../../src/core/eval-executor";
import { createScriptedProvider, textTurn, toolCallTurn } from "../../src/core/providers/scripted";

function evalCase(over: Partial<PostmortemEvalCase> & { id: string; task: string }): PostmortemEvalCase {
  return {
    id: over.id,
    from: over.from ?? `pm-${over.id}`,
    task: over.task,
    setup: over.setup ?? { tools: [] },
    assertions: over.assertions ?? [{ kind: "terminal", value: "succeeded" }],
  };
}

describe("makeRuntimeExecutor (mock, hermetic)", () => {
  test(
    "runs a case through the real composition root and reports the three graded fields",
    async () => {
      const h = makeRuntimeExecutor({ rootDir: tmpdir(), mock: true });
      const result = await h.executor(evalCase({ id: "e1", task: "list files" }));
      expect(result.terminal).toBe("succeeded");
      expect(result.toolCalls).toContain("glob");
      expect(result.finalAnswer.length).toBeGreaterThan(0);
      const obs = h.observations();
      expect(obs).toHaveLength(1);
      expect(obs[0]!.caseId).toBe("e1");
      expect(obs[0]!.kept).toBe(false);
      expect(existsSync(obs[0]!.workspace)).toBe(false);
    },
    30000,
  );

  test(
    "keeps the scratch workspace when asked, and seeds files into it",
    async () => {
      const h = makeRuntimeExecutor({ mock: true, keepWorkspaces: true, files: { "seed.txt": "seeded\n" } });
      try {
        await h.executor(evalCase({ id: "e2", task: "list files" }));
        const ws = h.keptWorkspaces()[0]!;
        expect(existsSync(path.join(ws, "seed.txt"))).toBe(true);
        expect(h.observations()[0]!.kept).toBe(true);
      } finally {
        for (const ws of h.keptWorkspaces()) rmSync(ws, { recursive: true, force: true });
      }
    },
    30000,
  );
});

describe("makeScriptedExecutor (in-library test model)", () => {
  test(
    "runs a scripted tool turn and reports it",
    async () => {
      const provider = createScriptedProvider([
        toolCallTurn({ name: "write", args: { path: "made.txt", content: "hi\n" } }),
        textTurn("done"),
      ]);
      const h = makeScriptedExecutor(provider, { keepWorkspaces: true, model: "scripted-1" });
      try {
        const result = await h.executor(evalCase({ id: "s1", task: "make a file" }));
        expect(result.terminal).toBe("succeeded");
        expect(result.toolCalls).toEqual(["write"]);
        const ws = h.observations()[0]!.workspace;
        expect(readFileSync(path.join(ws, "made.txt"), "utf8")).toBe("hi\n");
      } finally {
        for (const ws of h.keptWorkspaces()) rmSync(ws, { recursive: true, force: true });
      }
    },
    30000,
  );

  test(
    "DEFAULT DENY: a write outside the scratch workspace is refused, not written",
    async () => {
      const outside = path.join(tmpdir(), `hz-eval-outside-${Date.now()}.txt`);
      const provider = createScriptedProvider([
        toolCallTurn({ name: "write", args: { path: outside, content: "should not exist\n" } }),
        textTurn("ok"),
      ]);
      const h = makeScriptedExecutor(provider); // autoApprove defaults to false
      const result = await h.executor(evalCase({ id: "s2", task: "write outside" }));
      expect(result.terminal).toBe("succeeded");
      expect(existsSync(outside)).toBe(false);
    },
    30000,
  );

  test("a throwing provider is contained by the LOOP: the run ends failed, and the grader sees that terminal", async () => {
    const exploded: Provider = {
      name: "exploded",
      async *stream(): AsyncIterable<ProviderEvent> {
        throw new Error("no model today");
      },
    };
    const h = makeScriptedExecutor(exploded);
    const graded = await runEvalCase(
      evalCase({ id: "s3", task: "anything", assertions: [{ kind: "terminal", value: "succeeded" }] }),
      { executor: h.executor, forbiddenTexts: ["the answer"] },
    );
    // The loop reports the provider error as its own `failed` exit; the grader
    // then fails the terminal assertion honestly (it never sees a throw here).
    expect(graded.outcome.terminal).toBe("failed");
    expect(graded.passed).toBe(false);
    expect(graded.failures.map((f) => f.kind)).toEqual(["terminal"]);
  }, 30000);

  test("an executor that itself throws is graded executor_error, never re-thrown", async () => {
    const graded = await runEvalCase(
      evalCase({ id: "s3b", task: "anything" }),
      {
        executor: async () => {
          throw new Error("harness down");
        },
        forbiddenTexts: ["the answer"],
      },
    );
    expect(graded.passed).toBe(false);
    expect(graded.failures[0]!.kind).toBe("executor_error");
    expect(graded.outcome.terminal).toBe("failed");
  });

  test("the run-half of no_answer_leak scans exactly the final answer", async () => {
    const provider = createScriptedProvider([textTurn("the answer is SECRET-VALUE")]);
    const h = makeScriptedExecutor(provider);
    const graded = await runEvalCase(
      evalCase({ id: "s4", task: "say something", assertions: [{ kind: "terminal", value: "succeeded" }, { kind: "no_answer_leak" }] }),
      { executor: h.executor, forbiddenTexts: ["SECRET-VALUE"] },
    );
    expect(graded.passed).toBe(false);
    expect(graded.failures.map((f) => f.kind)).toEqual(["no_answer_leak"]);
  }, 30000);
});
