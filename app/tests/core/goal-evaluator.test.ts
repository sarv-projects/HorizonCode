/**
 * goal-evaluator.test.ts -- Generator / Evaluator Separation (docs/28 §14).
 *
 * A /goal run must not grade its own work. The evaluator is an independent
 * provider call with its own prompt and no tools; malformed or failing output
 * fails closed to "fail" so the generator gets feedback instead of a free pass.
 */
import { describe, expect, test } from "bun:test";
import type { Provider, ProviderRequest } from "../../src/contracts";
import {
  createEvidenceBackedEvaluator,
  createProviderEvaluator,
  evaluatorModelFromEnv,
  parseEvaluatorVerdict,
  renderEvaluatorRequest,
  type GoalEvaluationEvidence,
} from "../../src/core/goal-evaluator";
import { renderGoalRoundPrompt, runAutonomousGoalLoop } from "../../src/core/goal-runner";

const EVIDENCE: GoalEvaluationEvidence = {
  objective: "Implement payment gateway",
  round: 2,
  changedPaths: ["src/pay.ts", "tests/pay.test.ts"],
  gateFeedback: "Layer 2: tests not run",
};

function fakeProvider(reply: string, seen: ProviderRequest[] = []): Provider {
  return {
    name: "evaluator-fake",
    async *stream(req: ProviderRequest) {
      seen.push(req);
      yield { type: "text", text: reply };
      yield { type: "done", stopReason: "end" };
    },
  };
}

describe("evaluator model selection", () => {
  test("HZ_GOAL_EVALUATOR_MODEL opts in and whitespace is trimmed", () => {
    expect(evaluatorModelFromEnv({ HZ_GOAL_EVALUATOR_MODEL: "  eval-model-1 " })).toBe("eval-model-1");
  });

  test("unset or blank keeps the original self-gate behaviour", () => {
    expect(evaluatorModelFromEnv({})).toBeUndefined();
    expect(evaluatorModelFromEnv({ HZ_GOAL_EVALUATOR_MODEL: "   " })).toBeUndefined();
  });
});

describe("evaluator verdict parsing", () => {
  test("accepts an explicit pass with reasons", () => {
    expect(parseEvaluatorVerdict('{"verdict":"pass","reasons":["tests green"]}')).toEqual({
      verdict: "pass",
      reasons: ["tests green"],
    });
  });

  test("fails closed on malformed or unknown output", () => {
    for (const text of ["not json", '{"verdict":"maybe"}', '{"verdict":"pass"}', "```json\n{\"verdict\":\"pass\"}\n```"]) {
      const v = parseEvaluatorVerdict(text);
      expect(v.verdict).toBe("fail");
      expect(v.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe("independent evaluator prompt and call", () => {
  test("the evaluator prompt is distinct from the generator round prompt", () => {
    const request = renderEvaluatorRequest(EVIDENCE);
    expect(request.system).toContain("independent evaluator");
    expect(request.system).toContain("Do not trust the generator");
    expect(request.prompt).toContain("Implement payment gateway");
    expect(request.prompt).toContain("src/pay.ts, tests/pay.test.ts");
    expect(request.prompt).toContain("Layer 2: tests not run");
    expect(request.system).not.toBe(renderGoalRoundPrompt(EVIDENCE.objective, 2, 5));
  });

  test("runs a toolless provider call with its own model when supplied", async () => {
    const seen: ProviderRequest[] = [];
    const evaluator = createProviderEvaluator({
      provider: fakeProvider('{"verdict":"pass","reasons":["verification observed"]}', seen),
      model: "evaluator-model-1",
    });
    const verdict = await evaluator.evaluate(EVIDENCE);
    expect(verdict).toEqual({ verdict: "pass", reasons: ["verification observed"] });
    expect(seen.length).toBe(1);
    expect(seen[0].model).toBe("evaluator-model-1");
    expect(seen[0].tools).toEqual([]);
    expect(seen[0].system).toContain("independent evaluator");
  });

  test("provider failures fail closed to fail", async () => {
    const evaluator = createProviderEvaluator({
      provider: {
        name: "broken",
        async *stream() {
          throw new Error("provider down");
        },
      } as Provider,
      model: "evaluator-model-1",
    });
    const verdict = await evaluator.evaluate(EVIDENCE);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.reasons.join(" ")).toContain("provider down");
  });
});

describe("evidence-backed evaluator runs verification before judging", () => {
  const verifyOk = async () => ({ command: "bun test", exitCode: 0, output: "12 pass / 0 fail" });
  const verifyFail = async () => ({ command: "bun test", exitCode: 1, output: "2 tests failed" });
  const providerPass = fakeProvider('{"verdict":"pass","reasons":["looks complete"]}');
  const providerFail = fakeProvider('{"verdict":"fail","reasons":["incomplete"]}');

  test("passes only when both the verification command and the model agree", async () => {
    const ok = createEvidenceBackedEvaluator({ provider: providerPass, verify: verifyOk });
    const verdict = await ok.evaluate(EVIDENCE);
    expect(verdict.verdict).toBe("pass");
    expect(verdict.reasons.join(" ")).toContain("bun test");

    const failed = createEvidenceBackedEvaluator({ provider: providerPass, verify: verifyFail });
    expect((await failed.evaluate(EVIDENCE)).verdict).toBe("fail");
  });

  test("model rejection fails even with green verification", async () => {
    const evaluator = createEvidenceBackedEvaluator({ provider: providerFail, verify: verifyOk });
    expect((await evaluator.evaluate(EVIDENCE)).verdict).toBe("fail");
  });

  test("a throwing verification command fails closed", async () => {
    const evaluator = createEvidenceBackedEvaluator({
      provider: providerPass,
      verify: async () => {
        throw new Error("verification unavailable");
      },
    });
    const verdict = await evaluator.evaluate(EVIDENCE);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.reasons.join(" ")).toContain("verification unavailable");
  });
});

describe("goal loop uses the evaluator instead of self-grading", () => {
  function fakeRuntime(lastVerifiedCommand = "bun test", exitCode = 0): any {
    return {
      send: async () => undefined,
      setGoal: async () => undefined,
      lastChangedPaths: [],
      lastVerifiedCommand,
      lastCommandExitCode: exitCode,
    };
  }
  const renderer = { line: () => undefined, notice: () => undefined };

  test("a failing evaluator blocks achievement even when the local gate passes", async () => {
    const evaluator = {
      evaluate: async () => ({ verdict: "fail" as const, reasons: ["no evidence tests ran"] }),
    };
    const result = await runAutonomousGoalLoop("Build feature X", fakeRuntime(), renderer, {
      workspace: "/tmp",
      maxRounds: 2,
      evaluator,
    });
    expect(result.status).toBe("max_rounds_reached");
    expect(result.lastError).toContain("no evidence tests ran");
  });

  test("a passing evaluator and a passing gate achieve the goal", async () => {
    const evaluator = {
      evaluate: async () => ({ verdict: "pass" as const, reasons: ["independent review ok"] }),
    };
    const result = await runAutonomousGoalLoop("Build feature X", fakeRuntime(), renderer, {
      workspace: "/tmp",
      maxRounds: 2,
      evaluator,
    });
    expect(result.status).toBe("achieved");
    expect(result.roundsRun).toBe(1);
  });
});
