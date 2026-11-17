/** eval-ratchet-auto.test.ts — G-8 automatic post-run feed (additive, fail-closed). */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { buildEvalApproval, buildFrozenSplit, loadRatchetDecisions } from "../../src/core/eval-approval";
import { loadRunResults, parseRatchetGateSpec, runAutoRatchet } from "../../src/core/eval-ratchet";
import { runEvalCli, type EvalCliIo } from "../../src/eval-run";

const IDS = ["c1", "c2"];
const savedEnv = process.env.HZ_RATCHE_AUTO;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.HZ_RATCHE_AUTO;
  else process.env.HZ_RATCHE_AUTO = savedEnv;
});

function capture(): { lines: string[]; errors: string[]; io: EvalCliIo } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, io: { out: (l) => lines.push(l), err: (l) => errors.push(l) } };
}

function fixture() {
  const root = path.join(tmpdir(), `hz-ratchet-auto-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  const cases = IDS.map((id) => ({
    id,
    from: "pm",
    task: `task ${id}`,
    setup: { tools: [] },
    assertions: [{ kind: "terminal" as const, value: "succeeded" as const }],
  }));
  const split = buildFrozenSplit(IDS, { heldOutFraction: 0.5, splitSeed: 1 });
  const approval = buildEvalApproval(cases, "auto gate", split);

  const approvalPath = path.join(root, "approval.json");
  const baselinePath = path.join(root, "baseline.json");
  const caseFile = path.join(root, "cases.json");
  const metricsOut = path.join(root, "metrics.json");
  const log = path.join(root, "decisions.jsonl");
  const specPath = path.join(root, "spec.json");

  writeFileSync(approvalPath, JSON.stringify(approval), "utf8");
  writeFileSync(baselinePath, JSON.stringify(IDS.map((id) => ({ id, passed: true }))), "utf8");
  writeFileSync(
    caseFile,
    JSON.stringify(
      IDS.map((id) => ({ id, task: `task ${id}`, assertions: [{ kind: "terminal", value: "succeeded" }] })),
    ),
    "utf8",
  );
  const specObj = {
    approval: approvalPath,
    baseline: baselinePath,
    candidate: path.join(root, "ignored-candidate.json"),
    variantId: "variant-auto",
    round: 1,
    decisionLog: log,
  };
  writeFileSync(specPath, JSON.stringify(specObj), "utf8");
  return { root, specPath, spec: parseRatchetGateSpec(JSON.stringify(specObj), specPath), caseFile, metricsOut, log };
}

function normalRun(f: ReturnType<typeof fixture>, io: EvalCliIo, extra: string[] = []): Promise<number> {
  return runEvalCli(
    ["--cases", f.caseFile, "--forbidden", "SECRET-VALUE", "--metrics-out", f.metricsOut, ...extra],
    io,
  );
}

describe("--ratchet-auto post-run feed (G-8)", () => {
  test("a normal run feeds exactly one ratchet decision from its own result file", async () => {
    const f = fixture();
    const c = capture();
    const code = await normalRun(f, c.io, ["--ratchet-auto", f.specPath]);
    expect(code).toBe(0);
    const decisions = loadRatchetDecisions(f.log);
    expect(decisions.missing).toBe(false);
    expect(decisions.records).toHaveLength(1);
    expect(decisions.records[0]!.verdict).toBe("keep");
    const text = c.lines.join("\n");
    expect(text).toContain("ratchet-auto: keep");
    expect(text).toContain("ratchet decision: appended");
    // The run's own result file covered the frozen split.
    expect(loadRunResults(f.metricsOut).map((row) => row.id).sort()).toEqual([...IDS].sort());
  }, 90000);

  test("replaying the same run is an idempotent no-op (one decision)", async () => {
    const f = fixture();
    const first = capture();
    expect(await normalRun(f, first.io, ["--ratchet-auto", f.specPath])).toBe(0);
    const second = capture();
    expect(await normalRun(f, second.io, ["--ratchet-auto", f.specPath])).toBe(0);
    expect(loadRatchetDecisions(f.log).records).toHaveLength(1);
    expect(second.lines.join("\n")).toContain("no-op (identical decision already recorded)");
  }, 90000);

  test("a kept result is never overwritten by a later, different auto decision", async () => {
    const f = fixture();
    const first = capture();
    expect(await normalRun(f, first.io, ["--ratchet-auto", f.specPath])).toBe(0);
    // A new candidate that regresses on held-out yields a different record.
    const regressing = path.join(f.root, "regressing.json");
    writeFileSync(regressing, JSON.stringify(IDS.map((id) => ({ caseId: id, passed: false }))), "utf8");
    expect(() => runAutoRatchet({ spec: f.spec, resultFile: regressing })).toThrow(
      /kept-result-overwrite|never overwrite/,
    );
    expect(loadRatchetDecisions(f.log).records).toHaveLength(1);
  }, 90000);

  test("missing / corrupt / wrong-shape result files fail closed", async () => {
    // No result file configured at all: refuse before running a case.
    const noResult = fixture();
    const c = capture();
    const code = await runEvalCli(
      ["--cases", noResult.caseFile, "--forbidden", "SECRET-VALUE", "--ratchet-auto", noResult.specPath],
      c.io,
    );
    expect(code).toBe(2);
    expect(c.errors.join("\n")).toContain("requires --metrics-out");

    // Corrupt result file fed directly to the auto path: never "all failed".
    const f = fixture();
    writeFileSync(f.metricsOut, "not json", "utf8");
    expect(() => runAutoRatchet({ spec: f.spec, resultFile: f.metricsOut })).toThrow(/missing or not valid JSON/);

    writeFileSync(f.metricsOut, JSON.stringify({ cases: [{ caseId: "c1", passed: "yes" }] }), "utf8");
    expect(() => loadRunResults(f.metricsOut)).toThrow(/passed must be a boolean/);
  }, 90000);

  test("default is off: a normal run writes no decision log", async () => {
    const f = fixture();
    const c = capture();
    const code = await normalRun(f, c.io);
    expect(code).toBe(0);
    expect(loadRatchetDecisions(f.log).missing).toBe(true);
    // The fixture dir name contains "ratchet"; assert on the decision lines.
    expect(c.lines.join("\n")).not.toContain("ratchet-auto:");
    expect(c.lines.join("\n")).not.toContain("ratchet decision:");
  }, 90000);

  test("HZ_RATCHE_AUTO=1 enables the post-run feed with an existing --ratchet spec", async () => {
    const f = fixture();
    process.env.HZ_RATCHE_AUTO = "1";
    const c = capture();
    const code = await normalRun(f, c.io, ["--ratchet", f.specPath]);
    expect(code).toBe(0);
    expect(loadRatchetDecisions(f.log).records).toHaveLength(1);
    expect(c.lines.join("\n")).toContain("ratchet-auto: keep");
  }, 90000);
});
