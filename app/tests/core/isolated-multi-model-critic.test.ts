import { describe, expect, it } from "bun:test";
import type { Provider, ProviderRequest, ProviderEvent } from "../../src/contracts";
import {
  runIsolatedMultiModelCritic,
  type MultiModelCriticReport,
} from "../../src/core/engineering-critic-llm";

class ScriptedCriticProvider implements Provider {
  name = "scripted-critic";
  capabilities = { tools: false, streaming: true };
  private readonly responses: Map<string, string>;

  constructor(responses: Record<string, string>) {
    this.responses = new Map(Object.entries(responses));
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const text = this.responses.get(req.model) ?? "VERDICT: PASS";
    yield { type: "text", text };
    yield { type: "done" };
  }
}

describe("Isolated Multi-Model Critic Reviews (Ruling 865)", () => {
  it("runs independent isolated passes across multiple models and aggregates findings", async () => {
    const provider = new ScriptedCriticProvider({
      "critic-model-alpha": "VERDICT: FAIL\nP0: deps_mutation_unannounced: modified bun.lock unexpectedly",
      "critic-model-beta": "VERDICT: PASS_WITH_NOTES\nP1: mutation_without_verification: no tests run for changes",
    });

    const report: MultiModelCriticReport = await runIsolatedMultiModelCritic({
      provider,
      criticModels: ["critic-model-alpha", "critic-model-beta"],
      input: {
        goal: "Add authentication",
        changedPaths: ["app/src/auth.ts", "app/bun.lock"],
      },
    });

    expect(report.modelsQueried).toBe(2);
    expect(report.modelsSucceeded).toBe(2);
    expect(report.verdict).toBe("FAIL"); // P0 from alpha forces FAIL
    expect(report.findings.length).toBe(2);

    const severities = report.findings.map((f) => f.severity).sort();
    expect(severities).toEqual(["P0", "P1"]);
    expect(report.findings.some((f) => f.evidence.includes("modified bun.lock unexpectedly"))).toBe(true);
    expect(report.findings.some((f) => f.evidence.includes("no tests run for changes"))).toBe(true);
  });

  it("returns PASS when all isolated critics pass cleanly", async () => {
    const provider = new ScriptedCriticProvider({
      "model-1": "VERDICT: PASS",
      "model-2": "VERDICT: PASS",
    });

    const report = await runIsolatedMultiModelCritic({
      provider,
      criticModels: ["model-1", "model-2"],
      input: {
        goal: "Fix typo",
        changedPaths: ["README.md"],
        verifiedCommand: "bun test",
      },
    });

    expect(report.verdict).toBe("PASS");
    expect(report.findings.length).toBe(0);
    expect(report.modelsQueried).toBe(2);
    expect(report.modelsSucceeded).toBe(2);
  });

  it("handles model failure gracefully and uses successful critic reviews", async () => {
    const provider = new ScriptedCriticProvider({
      "failing-model": "invalid garbage output without verdict",
      "working-model": "VERDICT: PASS_WITH_NOTES\nP1: mutation_without_verification: test command skipped",
    });

    const report = await runIsolatedMultiModelCritic({
      provider,
      criticModels: ["failing-model", "working-model"],
      input: {
        goal: "Refactor logic",
        changedPaths: ["app/src/core/loop.ts"],
      },
    });

    expect(report.modelsQueried).toBe(2);
    expect(report.modelsSucceeded).toBe(1);
    expect(report.findings.length).toBe(1);
    expect(report.findings[0]?.severity).toBe("P1");
    expect(report.findings[0]?.evidence).toContain("test command skipped");
  });
});
