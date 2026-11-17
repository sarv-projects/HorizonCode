/** eval-ratchet.test.ts — G-8 on-disk variant gate (hermetic fixtures). */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  assertPublishedNumber,
} from "../../src/core/metrics";
import { buildEvalApproval, buildFrozenSplit, loadRatchetDecisions } from "../../src/core/eval-approval";
import { parseRatchetGateSpec, runRatchetGate } from "../../src/core/eval-ratchet";
import { runEvalCli, type EvalCliIo } from "../../src/eval-run";

const IDS = ["c1", "c2", "c3", "c4"];
const FIXED_TIME = "2026-11-17T00:00:00.000Z";

function capture(): { lines: string[]; errors: string[]; io: EvalCliIo } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, io: { out: (l) => lines.push(l), err: (l) => errors.push(l) } };
}

function fixture(opts: { candidateHeldOutPassed: number; dir?: string }): {
  specPath: string;
  spec: ReturnType<typeof parseRatchetGateSpec>;
  log: string;
} {
  const dir = opts.dir ?? path.join(tmpdir(), `hz-ratchet-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const cases = IDS.map((id) => ({ id, from: "pm", task: `task ${id}`, setup: { tools: [] }, assertions: [{ kind: "terminal" as const, value: "succeeded" as const }] }));
  const split = buildFrozenSplit(IDS, { heldOutFraction: 0.5, splitSeed: 1 });
  const approval = buildEvalApproval(cases, "gate test", split);
  const approvalPath = path.join(dir, "approval.json");
  writeFileSync(approvalPath, JSON.stringify(approval), "utf8");

  const baseline = IDS.map((id) => ({ id, passed: true }));
  const candidate = split.heldOutIds.map((id, i) => ({ id, passed: i < opts.candidateHeldOutPassed }))
    .concat(split.trainIds.map((id) => ({ id, passed: true })));
  const baselinePath = path.join(dir, "baseline.json");
  const candidatePath = path.join(dir, "candidate.json");
  writeFileSync(baselinePath, JSON.stringify(baseline), "utf8");
  writeFileSync(candidatePath, JSON.stringify(candidate), "utf8");

  const log = path.join(dir, "decisions.jsonl");
  const spec = {
    approval: approvalPath,
    baseline: baselinePath,
    candidate: candidatePath,
    variantId: "variant-A",
    round: 1,
    decisionLog: log,
    decidedAt: FIXED_TIME,
  };
  const specPath = path.join(dir, "spec.json");
  writeFileSync(specPath, JSON.stringify(spec), "utf8");
  return { specPath, spec: parseRatchetGateSpec(JSON.stringify(spec), specPath), log };
}

describe("runRatchetGate (pure decision + append-only log)", () => {
  test("keeps a non-regressing candidate and records one decision", () => {
    const f = fixture({ candidateHeldOutPassed: 2 });
    const report = runRatchetGate(f.spec);
    expect(report.verdict).toBe("keep");
    expect(report.append.appended).toBe(true);
    expect(loadRatchetDecisions(f.log).records).toHaveLength(1);
    for (const block of report.published) assertPublishedNumber(block);
  });

  test("reverts a candidate that regresses on held-out", () => {
    const f = fixture({ candidateHeldOutPassed: 0 });
    const report = runRatchetGate(f.spec);
    expect(report.verdict).toBe("revert");
    expect(report.reason).toContain("regressed");
  });

  test("idempotent replay is a no-op; a different decision for a kept key is refused", () => {
    const f = fixture({ candidateHeldOutPassed: 2 });
    runRatchetGate(f.spec);
    const replay = runRatchetGate(f.spec);
    expect(replay.append.appended).toBe(false);
    expect(loadRatchetDecisions(f.log).records).toHaveLength(1);
    const changed = { ...f.spec, decidedAt: "2026-11-18T00:00:00.000Z" };
    expect(() => runRatchetGate(changed)).toThrow(/kept-result-overwrite|never overwrite/);
  });

  test("records bind to the frozen split and approval hash", () => {
    const f = fixture({ candidateHeldOutPassed: 2 });
    const record = runRatchetGate(f.spec).record;
    expect(record.splitHash).toHaveLength(64);
    expect(record.approvalHash).toHaveLength(64);
    expect(record.recordHash).toHaveLength(64);
  });
});

describe("fail closed on malformed on-disk input", () => {
  test("spec missing fields is refused", () => {
    expect(() => parseRatchetGateSpec('{"round":1}', "spec.json")).toThrow(/variantId|approval/);
  });
  test("an approval without a frozen split is refused by the gate", () => {
    const f = fixture({ candidateHeldOutPassed: 2 });
    writeFileSync(f.spec.approval, JSON.stringify({ version: 1, casesContentHash: "a".repeat(64), approvedAt: FIXED_TIME }), "utf8");
    expect(() => runRatchetGate(f.spec)).toThrow(/frozenSplit/);
  });
  test("malformed candidate results are refused, never scored as all-failed", () => {
    const f = fixture({ candidateHeldOutPassed: 2 });
    writeFileSync(f.spec.candidate, JSON.stringify([{ id: "c1", passed: "yes" }]), "utf8");
    expect(() => runRatchetGate(f.spec)).toThrow(/passed must be a boolean/);
  });
});

describe("--ratchet CLI wiring", () => {
  test("keep exits 0 and prints the contracted gate report", async () => {
    const f = fixture({ candidateHeldOutPassed: 2 });
    const c = capture();
    const code = await runEvalCli(["--ratchet", f.specPath], c.io);
    expect(code).toBe(0);
    expect(c.lines.join("\n")).toContain("ratchet: keep");
    expect(c.lines.join("\n")).toContain("ratchet decision: appended");
  });
  test("revert exits 1", async () => {
    const f = fixture({ candidateHeldOutPassed: 0 });
    const c = capture();
    const code = await runEvalCli(["--ratchet", f.specPath], c.io);
    expect(code).toBe(1);
    expect(c.lines.join("\n")).toContain("ratchet: revert");
  });
  test("a malformed spec exits 2 (refusal)", async () => {
    const dir = path.join(tmpdir(), `hz-ratchet-bad-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const bad = path.join(dir, "spec.json");
    writeFileSync(bad, "{}", "utf8");
    const c = capture();
    const code = await runEvalCli(["--ratchet", bad], c.io);
    expect(code).toBe(2);
    expect(c.errors.join("\n")).toContain("ratchet gate refused");
  });
});
