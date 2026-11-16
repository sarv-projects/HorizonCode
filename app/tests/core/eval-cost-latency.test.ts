/**
 * eval-cost-latency.test.ts — F-4: cost/latency metrics in the eval runner,
 * opt-in resource thresholds, and the additive CLI surface.
 *
 * Pinned here: wall-clock and USD are captured per case and published through
 * the SAME metric contract as the existing counts; a harness estimate is
 * derived from provider usage, an explicit cost is reported as such, and a
 * provider that reports neither is exactly $0 with source `none` (never a
 * fabricated number); `max_wall_ms` / `max_cost_usd` and the suite caps fail
 * loudly with evidence; answer isolation is untouched.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Usage } from "../../src/contracts";
import {
  EvalCaseRefusal,
  runEvalCase,
  runEvalSet,
  type EvalExecutor,
  type PostmortemEvalCase,
} from "../../src/core/evals";
import { makeScriptedExecutor } from "../../src/core/eval-executor";
import { createScriptedProvider, textTurn } from "../../src/core/providers/scripted";
import { HARNESS_PRICE_TABLE_REVISION } from "../../src/core/usage-cost";
import { runEvalCli, type EvalCliIo } from "../../src/eval-run";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(cleanupTemps);

const FORBIDDEN = "SECRET-VALUE";

function evalCase(
  id: string,
  assertions: PostmortemEvalCase["assertions"],
  task = "do the task",
): PostmortemEvalCase {
  return { id, from: `pm-${id}`, task, setup: { tools: [] }, assertions };
}

function capture(): { lines: string[]; errors: string[]; io: EvalCliIo } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, io: { out: (l) => lines.push(l), err: (l) => errors.push(l) } };
}

function casesFile(entries: unknown[]): string {
  const file = path.join(tempDir("hz-eval-f4-cli-"), "cases.json");
  writeFileSync(file, JSON.stringify(entries), "utf8");
  return file;
}

/* ------------------------- capture and publication ------------------------- */

describe("F-4: metrics captured and published", () => {
  test(
    "wall-clock + harness-estimated USD from usage are captured and published through the metric contract",
    async () => {
      const usage: Usage = { inputTokens: 1_000_000, outputTokens: 100_000 };
      const executor: EvalExecutor = async () => ({
        terminal: "succeeded",
        finalAnswer: "done",
        usage,
        provider: "anthropic",
        model: "claude-x",
      });
      const graded = await runEvalCase(
        evalCase("m1", [{ kind: "terminal", value: "succeeded" }]),
        { executor, forbiddenTexts: [FORBIDDEN] },
      );

      expect(graded.passed).toBe(true);
      expect(graded.metrics.wallMs).toBeGreaterThanOrEqual(0);
      expect(graded.metrics.costSource).toBe("harness-estimate");
      expect(graded.metrics.priceTableRevision).toBe(HARNESS_PRICE_TABLE_REVISION);
      expect(graded.metrics.usage).toEqual(usage);
      // DEFAULT_RATES (anthropic/claude): $3/M input + $15/M output.
      expect(graded.metrics.costUsd).toBeCloseTo(4.5, 6);

      const set = await runEvalSet(
        [evalCase("m1", [{ kind: "terminal", value: "succeeded" }])],
        { executor, forbiddenTexts: [FORBIDDEN] },
      );
      expect(set.aggregate.published).toHaveLength(5); // 3 original + wall + cost
      for (const block of set.aggregate.published) {
        for (const slot of ["metric:", "anchor:", "population:", "excludes:", "value:"]) {
          expect(block).toContain(slot);
        }
      }
      const wallBlock = set.aggregate.published[3]!;
      const costBlock = set.aggregate.published[4]!;
      expect(wallBlock).toContain("metric: eval wall-clock (milliseconds)");
      expect(wallBlock).toContain("ms total /");
      expect(costBlock).toContain("metric: eval cost (USD");
      expect(costBlock).toContain("value: $4.500000 total / $4.500000 max case");
      expect(costBlock).toContain("1/1 case(s) reported cost or usage");
      expect(set.aggregate.suiteFailures).toEqual([]);
    },
    30000,
  );

  test("an explicitly reported USD cost takes precedence over usage", async () => {
    const executor: EvalExecutor = async () => ({
      terminal: "succeeded",
      finalAnswer: "done",
      usage: { inputTokens: 1_000_000 },
      costUsd: 2.75,
    });
    const graded = await runEvalCase(evalCase("r1", [{ kind: "terminal", value: "succeeded" }]), {
      executor,
      forbiddenTexts: [FORBIDDEN],
    });
    expect(graded.metrics.costUsd).toBe(2.75);
    expect(graded.metrics.costSource).toBe("reported");
    expect(graded.metrics.priceTableRevision).toBeUndefined();
  });

  test("wall time is measured to an executor throw, which still carries honest metrics", async () => {
    const graded = await runEvalCase(evalCase("e1", [{ kind: "terminal", value: "succeeded" }]), {
      executor: async () => {
        throw new Error("harness down");
      },
      forbiddenTexts: [FORBIDDEN],
    });
    expect(graded.passed).toBe(false);
    expect(graded.failures.map((f) => f.kind)).toEqual(["executor_error"]);
    expect(graded.metrics.wallMs).toBeGreaterThanOrEqual(0);
    expect(graded.metrics.costUsd).toBe(0);
    expect(graded.metrics.costSource).toBe("none");
  });
});

/* ------------------------------ thresholds ------------------------------ */

describe("F-4: opt-in resource thresholds", () => {
  test("a max_wall_ms breach fails the case with expected/observed evidence", async () => {
    const slow: EvalExecutor = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return { terminal: "succeeded", finalAnswer: "done" };
    };
    const graded = await runEvalCase(
      evalCase("w1", [{ kind: "max_wall_ms", value: 1 }, { kind: "terminal", value: "succeeded" }]),
      { executor: slow, forbiddenTexts: [FORBIDDEN] },
    );
    expect(graded.passed).toBe(false);
    expect(graded.failures.map((f) => f.kind)).toContain("max_wall_ms");
    const failure = graded.failures.find((f) => f.kind === "max_wall_ms")!;
    expect(failure.expected).toBe("<= 1ms");
    expect(failure.observed).toMatch(/^\d+ms$/);
    expect(graded.metrics.wallMs).toBeGreaterThan(1);
  });

  test("a generous max_wall_ms threshold passes", async () => {
    const graded = await runEvalCase(evalCase("w2", [{ kind: "max_wall_ms", value: 5000 }]), {
      executor: async () => ({ terminal: "succeeded", finalAnswer: "done" }),
      forbiddenTexts: [FORBIDDEN],
    });
    expect(graded.passed).toBe(true);
  });

  test("a max_cost_usd breach fails the case and names the cost source", async () => {
    const executor: EvalExecutor = async () => ({ terminal: "succeeded", finalAnswer: "done", costUsd: 5 });
    const graded = await runEvalCase(evalCase("c1", [{ kind: "max_cost_usd", value: 1 }]), {
      executor,
      forbiddenTexts: [FORBIDDEN],
    });
    expect(graded.passed).toBe(false);
    expect(graded.failures.map((f) => f.kind)).toEqual(["max_cost_usd"]);
    const failure = graded.failures[0]!;
    expect(failure.expected).toBe("<= $1.000000");
    expect(failure.observed).toBe("$5.000000 (reported)");
    expect(failure.detail).toContain("source reported");
  });

  test("a malformed threshold is an explicit failure, never a silent skip", async () => {
    const bad = [-1, Number.NaN, "5"] as unknown as PostmortemEvalCase["assertions"];
    const graded = await runEvalCase(evalCase("c2", bad), {
      executor: async () => ({ terminal: "succeeded", finalAnswer: "done" }),
      forbiddenTexts: [FORBIDDEN],
    });
    expect(graded.passed).toBe(false);
    expect(graded.failures.map((f) => f.kind)).toEqual([
      "unknown_assertion",
      "unknown_assertion",
      "unknown_assertion",
    ]);
  });

  test("suite caps produce PASS/FAIL gate failures with evidence", async () => {
    const executor: EvalExecutor = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 12));
      return { terminal: "succeeded", finalAnswer: "done", costUsd: 3 };
    };
    const cases = [
      evalCase("s1", [{ kind: "terminal", value: "succeeded" }]),
      evalCase("s2", [{ kind: "terminal", value: "succeeded" }]),
    ];
    const breached = await runEvalSet(cases, {
      executor,
      forbiddenTexts: [FORBIDDEN],
      maxSuiteWallMs: 1,
      maxSuiteCostUsd: 1,
    });
    expect(breached.aggregate.suiteFailures.map((f) => f.kind)).toEqual(["suite_wall_ms", "suite_cost_usd"]);
    expect(breached.aggregate.suiteFailures[0]!.expected).toBe("<= 1ms");
    expect(breached.aggregate.suiteFailures[1]!.expected).toBe("<= $1.000000");

    const met = await runEvalSet(cases, {
      executor,
      forbiddenTexts: [FORBIDDEN],
      maxSuiteWallMs: 5000,
      maxSuiteCostUsd: 100,
    });
    expect(met.aggregate.suiteFailures).toEqual([]);
  });
});

/* --------------------------- isolation and honesty --------------------------- */

describe("F-4: isolation intact, zero cost honest", () => {
  test("a run-side answer leak still fails even when every resource threshold passes", async () => {
    const graded = await runEvalCase(
      evalCase("i1", [
        { kind: "terminal", value: "succeeded" },
        { kind: "max_wall_ms", value: 5000 },
        { kind: "max_cost_usd", value: 10 },
        { kind: "no_answer_leak" },
      ]),
      {
        executor: async () => ({ terminal: "succeeded", finalAnswer: `leaked ${FORBIDDEN} here` }),
        forbiddenTexts: [FORBIDDEN],
      },
    );
    expect(graded.passed).toBe(false);
    expect(graded.failures.map((f) => f.kind)).toEqual(["no_answer_leak"]);
  });

  test("a case-side leak still refuses before the executor runs", async () => {
    let calls = 0;
    const graded = runEvalCase(
      evalCase("i2", [{ kind: "max_cost_usd", value: 1 }], `task with ${FORBIDDEN} inside`),
      {
        executor: async () => {
          calls += 1;
          return { terminal: "succeeded", finalAnswer: "done" };
        },
        forbiddenTexts: [FORBIDDEN],
      },
    );
    await expect(graded).rejects.toBeInstanceOf(EvalCaseRefusal);
    await expect(graded).rejects.toMatchObject({ code: "answer_leak" });
    expect(calls).toBe(0);
  });

  test("zero-cost and no-usage providers report 0 with source 'none'", async () => {
    const direct = await runEvalCase(
      evalCase("z1", [{ kind: "terminal", value: "succeeded" }, { kind: "max_cost_usd", value: 0 }]),
      {
        executor: async () => ({ terminal: "succeeded", finalAnswer: "done" }),
        forbiddenTexts: [FORBIDDEN],
      },
    );
    expect(direct.passed).toBe(true);
    expect(direct.metrics.costUsd).toBe(0);
    expect(direct.metrics.costSource).toBe("none");
    expect(direct.metrics.usage).toBeUndefined();
    expect(direct.metrics.priceTableRevision).toBeUndefined();

    const provider = createScriptedProvider([textTurn("hello")]);
    const handle = makeScriptedExecutor(provider);
    const scripted = await runEvalCase(evalCase("z2", [{ kind: "terminal", value: "succeeded" }]), {
      executor: handle.executor,
      forbiddenTexts: [FORBIDDEN],
    });
    expect(scripted.metrics.costUsd).toBe(0);
    expect(scripted.metrics.costSource).toBe("none");
  }, 30000);

  test("usage with zero tokens is a zero harness estimate, not 'none'", async () => {
    const graded = await runEvalCase(evalCase("z3", [{ kind: "terminal", value: "succeeded" }]), {
      executor: async () => ({
        terminal: "succeeded",
        finalAnswer: "done",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "scripted",
      }),
      forbiddenTexts: [FORBIDDEN],
    });
    expect(graded.metrics.costUsd).toBe(0);
    expect(graded.metrics.costSource).toBe("harness-estimate");
    expect(graded.metrics.priceTableRevision).toBe(HARNESS_PRICE_TABLE_REVISION);
  });
});

/* --------------------------------- CLI --------------------------------- */

describe("F-4: CLI surface", () => {
  test("--metrics-out writes a structured report and default lines are unchanged", async () => {
    const metricsPath = path.join(tempDir("hz-eval-f4-out-"), "metrics.json");
    const c = capture();
    const code = await runEvalCli(
      [
        "--cases",
        casesFile([{ id: "cli1", task: "say hi", assertions: [{ kind: "terminal", value: "succeeded" }] }]),
        "--forbidden",
        FORBIDDEN,
        "--metrics-out",
        metricsPath,
      ],
      c.io,
    );
    const text = c.lines.join("\n");
    expect(code).toBe(0);
    // Existing default contract: every line still present, unchanged.
    expect(text).toContain("PASS cli1");
    expect(text).toContain("terminal=succeeded");
    expect(text).toContain("eval cases passed");
    expect(text).toContain("summary: 1 case(s), 1 passed, 0 failed");
    // Additive F-4 surface.
    expect(text).toContain("metrics: wall=");
    expect(text).toContain("cost=$0.000000 total");
    expect(text).toContain("0/1 case(s) reported usage or cost");
    expect(text).toContain(`wrote metrics: ${metricsPath}`);

    const report = JSON.parse(readFileSync(metricsPath, "utf8")) as {
      cases: Array<{ caseId: string; costUsd: number; costSource: string; wallMs: number }>;
      totals: { caseCount: number; costUsd: number };
    };
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]!.caseId).toBe("cli1");
    expect(report.cases[0]!.costUsd).toBe(0);
    expect(report.cases[0]!.costSource).toBe("none");
    expect(report.cases[0]!.wallMs).toBeGreaterThanOrEqual(0);
    expect(report.totals.caseCount).toBe(1);
    expect(report.totals.costUsd).toBe(0);
  }, 30000);

  test("suite caps surface as an explicit PASS gate line (and a bad cap is a usage error)", async () => {
    const c = capture();
    const code = await runEvalCli(
      [
        "--cases",
        casesFile([{ id: "cli2", task: "say hi", assertions: [{ kind: "terminal", value: "succeeded" }] }]),
        "--forbidden",
        FORBIDDEN,
        "--max-suite-cost-usd",
        "0",
      ],
      c.io,
    );
    expect(code).toBe(0);
    expect(c.lines.join("\n")).toContain("suite gates: PASS (cost<=$0)");

    const bad = capture();
    const badCode = await runEvalCli(
      [
        "--cases",
        casesFile([{ id: "cli3", task: "say hi" }]),
        "--forbidden",
        FORBIDDEN,
        "--max-suite-wall-ms",
        "abc",
      ],
      bad.io,
    );
    expect(badCode).toBe(2);
    expect(bad.errors.join("\n")).toContain("--max-suite-wall-ms must be a finite non-negative number");
  }, 30000);
});
