/** Engineering Brain cross-model critic (ruling 705). */

import { afterEach, describe, expect, test } from "bun:test";
import type { Provider, ProviderEvent } from "../../src/contracts";
import {
  ENG_CRITIC_MODEL_ENV,
  buildEngCriticLlmPrompt,
  engCriticLlmOptIn,
  parseEngCriticLlmFindings,
  resolveAdversarialCritic,
} from "../../src/core/engineering-critic-llm";
import { mergeCriticReports, runAdversarialCritic } from "../../src/core/engineering-critic";

afterEach(() => {
  delete process.env[ENG_CRITIC_MODEL_ENV];
});

describe("engineering-critic-llm (ruling 705)", () => {
  test("engCriticLlmOptIn reads HZ_ENG_CRITIC_MODEL", () => {
    expect(engCriticLlmOptIn({})).toBe(false);
    expect(engCriticLlmOptIn({ [ENG_CRITIC_MODEL_ENV]: "1" })).toBe(true);
    expect(engCriticLlmOptIn({ [ENG_CRITIC_MODEL_ENV]: "claude-haiku-4-5" })).toBe(true);
    expect(engCriticLlmOptIn({ [ENG_CRITIC_MODEL_ENV]: "0" })).toBe(false);
  });

  test("parseEngCriticLlmFindings accepts P0/P1 lines", () => {
    const text = ["VERDICT: FAIL", "P0: touches kernel policy without review", "P1: no tests cited"].join("\n");
    const findings = parseEngCriticLlmFindings(text);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.severity).toBe("P0");
    expect(findings[1]?.severity).toBe("P1");
  });

  test("buildEngCriticLlmPrompt clips huge evidence", () => {
    const p = buildEngCriticLlmPrompt({
      goal: "x",
      changedPaths: ["a.ts"],
      evidenceText: "y".repeat(50_000),
    });
    expect(p).toContain("…(truncated)");
  });

  test("mergeCriticReports escalates to FAIL when LLM adds P0", () => {
    const local = runAdversarialCritic({
      goal: "comment tweak",
      changedPaths: ["app/src/x.ts"],
      verifiedCommand: "bun test",
    });
    expect(local.verdict).toBe("PASS");
    const merged = mergeCriticReports(local, [
      { code: "llm_adversarial_finding", severity: "P0", evidence: "scope exceeded goal" },
    ]);
    expect(merged.verdict).toBe("FAIL");
    expect(merged.findings.some((f) => f.code === "llm_adversarial_finding")).toBe(true);
  });

  test("resolveAdversarialCritic uses provider findings when opted in", async () => {
    const provider: Provider = {
      name: "scripted",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "text", text: "VERDICT: PASS_WITH_NOTES\nP1: goal omitted migration notes\n" };
        yield { type: "done", stopReason: "end" };
      },
    };
    const report = await resolveAdversarialCritic({
      input: {
        goal: "add helper",
        changedPaths: ["app/src/util.ts"],
        verifiedCommand: "bun test",
      },
      provider,
      mainModel: "gpt-test",
      env: { [ENG_CRITIC_MODEL_ENV]: "1" },
    });
    expect(report.verdict).toBe("PASS_WITH_NOTES");
    expect(report.findings.some((f) => f.code === "llm_adversarial_finding")).toBe(true);
  });

  test("resolveAdversarialCritic fails closed to harness on bad LLM output", async () => {
    const provider: Provider = {
      name: "scripted",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "text", text: "I think this looks fine overall." };
        yield { type: "done", stopReason: "end" };
      },
    };
    const report = await resolveAdversarialCritic({
      input: {
        goal: "add helper",
        changedPaths: ["app/src/util.ts"],
        verifiedCommand: "bun test",
      },
      provider,
      mainModel: "gpt-test",
      env: { [ENG_CRITIC_MODEL_ENV]: "1" },
    });
    expect(report.verdict).toBe("PASS");
    expect(report.findings).toEqual([]);
  });

  test("resolveAdversarialCritic skips LLM when env unset", async () => {
    const provider: Provider = {
      name: "scripted",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "text", text: "P0: should not apply\n" };
        yield { type: "done", stopReason: "end" };
      },
    };
    const report = await resolveAdversarialCritic({
      input: { goal: "x", changedPaths: ["app/.env"], verifiedCommand: "true" },
      provider,
      mainModel: "gpt-test",
      env: {},
    });
    expect(report.verdict).toBe("FAIL");
    expect(report.findings.some((f) => f.code === "llm_adversarial_finding")).toBe(false);
  });
});