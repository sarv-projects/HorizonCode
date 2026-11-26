import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runEvalCli } from "../../src/eval-run";
import { buildEvalApproval, buildFrozenSplit } from "../../src/core/eval-approval";

describe("Track 5 P1-12: eval-run --ratchet-auto exit code", () => {
  test("returns exit code 1 when ratchet-auto verdict is revert even if all eval cases pass", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-eval-ratchet-auto-"));
    const casesPath = path.join(dir, "cases.json");
    const approvalPath = path.join(dir, "approval.json");
    const baselinePath = path.join(dir, "baseline.json");
    const metricsPath = path.join(dir, "metrics.json");
    const decisionLogPath = path.join(dir, "decisions.jsonl");
    const specPath = path.join(dir, "ratchet-spec.json");

    const cases = [
      { id: "case-a", task: "list files" },
      { id: "case-b", task: "list files" },
    ];
    writeFileSync(casesPath, JSON.stringify(cases, null, 2), "utf8");

    const split = buildFrozenSplit(["case-a", "case-b"], { heldOutFraction: 0.5, splitSeed: 1 });
    const approval = buildEvalApproval(
      cases.map((c) => ({ id: c.id, task: c.task, forbidden: ["__NEVER_APPEARS__"] })),
      "2026-11-26T00:00:00Z",
      split,
    );
    writeFileSync(approvalPath, JSON.stringify(approval, null, 2), "utf8");

    // Baseline already passes both train and heldOut -> candidate tie triggers revert
    // (keepOnTrainNotWorse defaults to false).
    writeFileSync(
      baselinePath,
      JSON.stringify([
        { id: "case-a", passed: true },
        { id: "case-b", passed: true },
      ]),
      "utf8",
    );

    writeFileSync(
      specPath,
      JSON.stringify({
        approval: approvalPath,
        baseline: baselinePath,
        candidate: metricsPath,
        variantId: "v-tie",
        round: 1,
        decisionLog: decisionLogPath,
        decidedAt: "2026-11-26T00:01:00Z",
        keepOnTrainNotWorse: false,
      }),
      "utf8",
    );

    const out: string[] = [];
    const err: string[] = [];
    const code = await runEvalCli(
      [
        "--cases",
        casesPath,
        "--forbidden",
        "__NEVER_APPEARS__",
        "--metrics-out",
        metricsPath,
        "--ratchet-auto",
        specPath,
      ],
      {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      },
    );

    expect(err).toEqual([]);
    expect(out.some((l) => l.includes("ratchet-auto: revert"))).toBe(true);
    expect(code).toBe(1);
    const logText = readFileSync(decisionLogPath, "utf8");
    expect(logText).toContain('"verdict":"revert"');
  }, 15_000);

  test("returns exit code 0 when ratchet-auto verdict is keep and all eval cases pass", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-eval-ratchet-keep-"));
    const casesPath = path.join(dir, "cases.json");
    const approvalPath = path.join(dir, "approval.json");
    const baselinePath = path.join(dir, "baseline.json");
    const metricsPath = path.join(dir, "metrics.json");
    const decisionLogPath = path.join(dir, "decisions.jsonl");
    const specPath = path.join(dir, "ratchet-spec.json");

    const cases = [
      { id: "case-a", task: "list files" },
      { id: "case-b", task: "list files" },
    ];
    writeFileSync(casesPath, JSON.stringify(cases, null, 2), "utf8");

    const split = buildFrozenSplit(["case-a", "case-b"], { heldOutFraction: 0.5, splitSeed: 1 });
    const approval = buildEvalApproval(
      cases.map((c) => ({ id: c.id, task: c.task, forbidden: ["__NEVER_APPEARS__"] })),
      "2026-11-26T00:00:00Z",
      split,
    );
    writeFileSync(approvalPath, JSON.stringify(approval, null, 2), "utf8");

    // Baseline fails train, passes heldOut -> candidate passing both improves train => keep.
    writeFileSync(
      baselinePath,
      JSON.stringify([
        ...split.trainIds.map((id) => ({ id, passed: false })),
        ...split.heldOutIds.map((id) => ({ id, passed: true })),
      ]),
      "utf8",
    );

    writeFileSync(
      specPath,
      JSON.stringify({
        approval: approvalPath,
        baseline: baselinePath,
        candidate: metricsPath,
        variantId: "v-improve",
        round: 1,
        decisionLog: decisionLogPath,
        decidedAt: "2026-11-26T00:02:00Z",
      }),
      "utf8",
    );

    const out: string[] = [];
    const err: string[] = [];
    const code = await runEvalCli(
      [
        "--cases",
        casesPath,
        "--forbidden",
        "__NEVER_APPEARS__",
        "--metrics-out",
        metricsPath,
        "--ratchet-auto",
        specPath,
      ],
      {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      },
    );

    expect(err).toEqual([]);
    expect(out.some((l) => l.includes("ratchet-auto: keep"))).toBe(true);
    expect(code).toBe(0);
  }, 15_000);
});
