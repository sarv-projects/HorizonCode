/**
 * eval-run.ts — the runnable eval runner (docs/30 §4 item 8).
 *
 * Cases in, a graded pass rate out. This is the CLI half over `core/evals.ts`
 * (grading) and `core/eval-executor.ts` (execution): it loads cases — from a
 * JSON file or derived from recorded post-mortems — runs each one through the
 * real harness in a scratch workspace, and prints per-case verdicts plus the
 * aggregate `runEvalSet` publishes.
 *
 * Usage:
 *   bun run src/eval-run.ts --cases <file.json> --forbidden <text-or-file> [--keep] [--live]
 *   bun run src/eval-run.ts --postmortems <state-dir> --forbidden <text> [--keep]
 *   ... [--metrics-out <metrics.json>] [--max-suite-wall-ms <ms>] [--max-suite-cost-usd <usd>]
 *
 * Defaults: the hermetic mock provider, scratch workspaces under the OS temp
 * dir, removed after each case (`--keep` leaves them for inspection). `--live`
 * runs the configured real provider — the same executor, the same grading.
 *
 * F-4 (additive): every result now carries wall-clock and USD cost metrics,
 * published by `runEvalSet` through the metric contract (so they appear in the
 * existing published-block section of the default output — no existing line
 * changes). `--metrics-out` writes the per-case numbers as JSON; the two
 * `--max-suite-*` caps are opt-in gates. USD is a harness estimate derived from
 * provider usage; a provider that reports neither usage nor cost is $0 with
 * source `none` — never a fabricated number.
 *
 * Exit codes: 0 all cases passed and all suite gates met; 1 at least one case
 * failed or a suite gate was breached; 2 usage error (a refusal — missing
 * `--forbidden`, a corrupt post-mortem store — never runs).
 */

import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { PostmortemEvalCase } from "./core/evals";
import { evalCaseFromPostmortem, runEvalSet } from "./core/evals";
import { makeRuntimeExecutor } from "./core/eval-executor";
import { loadPostmortems } from "./core/postmortem";
import {
  assertEvalApprovalFresh,
  buildEvalApproval,
  buildFrozenSplit,
} from "./core/eval-approval";
import { upsertPredsRecord, type PredsRecordV1 } from "./core/preds-writer";
import { resolveSubmitCommand, submitPredictions } from "./core/swebench-submit";
import {
  submitWithOfficialHarness,
  type OfficialHarnessExec,
} from "./core/swebench-official-harness";
import { parseRatchetGateSpec, runRatchetGate } from "./core/eval-ratchet";
import { metricContract } from "./core/metrics";
import { casesFromCorpusJsonl, runIndexedBench } from "./core/bench-runner";

export interface EvalCliIo {
  out(line: string): void;
  err(line: string): void;
}

/** Additive injection seam for hermetic J-1 official-harness tests. */
export interface EvalCliExtras {
  /** When set, `--harness swebench-official` uses this instead of spawnOwned. */
  officialHarnessExec?: OfficialHarnessExec;
  /** Explicit interpreter path (defaults to HZ_SWEBENCH_PYTHON / python3). */
  officialHarnessPython?: string;
}

const DEFAULT_IO: EvalCliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

interface CaseFileEntry {
  id: string;
  task: string;
  assertions?: PostmortemEvalCase["assertions"];
}

const USAGE =
  "usage: bun run src/eval-run.ts (--cases <file.json> | --postmortems <state-dir> | --bench-corpus <file.jsonl>) --forbidden <text-or-file> [--preds-out <preds.json>] [--submit] [--submit-cmd <cmd>] [--harness swebench-official] [--dataset <name>] [--split <split>] [--instances <id1,id2,...>] [--metrics-out <metrics.json>] [--max-suite-wall-ms <ms>] [--max-suite-cost-usd <usd>] [--approval <file.json>] [--write-approval <file.json>] [--held-out-fraction <0..1>] [--split-seed <int>] [--ratchet <spec.json>] [--keep] [--live]";

/** The value of `--flag`, or `undefined` when absent (an empty string when bare). */
function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? "" : value;
}

/** An opt-in finite non-negative numeric flag; absent → undefined, bad → usage error. */
function numericOption(argv: readonly string[], flag: string, io: EvalCliIo): number | undefined | "bad" {
  const raw = argValue(argv, flag);
  if (raw === undefined) return undefined;
  if (raw === "") {
    io.err(`${flag} needs a value\n${USAGE}`);
    return "bad";
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    io.err(`${flag} must be a finite non-negative number (got ${JSON.stringify(raw)})\n${USAGE}`);
    return "bad";
  }
  return value;
}

function loadForbidden(argv: readonly string[]): string[] {
  const raw = argValue(argv, "--forbidden") ?? "";
  if (raw === "") return [];
  // A path that names a readable file is read line-wise; anything else is the
  // text itself.
  try {
    return readFileSync(raw, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    return [raw];
  }
}

function parseCaseFile(text: string, file: string): PostmortemEvalCase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})\n${USAGE}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${file}: the case file must be a JSON array\n${USAGE}`);
  const name = path.basename(file);
  return parsed.map((raw, index) => {
    const entry = raw as Partial<CaseFileEntry>;
    if (typeof entry?.id !== "string" || entry.id.trim() === "") {
      throw new Error(`${file}: cases[${index}] has no id\n${USAGE}`);
    }
    if (typeof entry.task !== "string" || entry.task.trim() === "") {
      throw new Error(`${file}: cases[${index}] (${entry.id}) has no task — a case must state one\n${USAGE}`);
    }
    return {
      id: entry.id.trim(),
      from: `file:${name}`,
      task: entry.task,
      setup: { tools: [] },
      assertions:
        Array.isArray(entry.assertions) && entry.assertions.length > 0
          ? entry.assertions
          : [{ kind: "terminal", value: "succeeded" }],
    };
  });
}

async function casesFromPostmortems(stateDir: string): Promise<{ cases: PostmortemEvalCase[]; skipped: number }> {
  const load = await loadPostmortems(stateDir);
  if (load.corrupt) {
    const files = load.quarantine.map((q) => q.file).join(", ");
    // The module's mandate: a corrupt store is a refusal state, never
    // `postmortems: []` meaning "no post-mortems".
    throw new Error(
      `${stateDir}: at least one post-mortem file is corrupt (${files}) — refusing, not treating it as an empty set`,
    );
  }
  const cases: PostmortemEvalCase[] = [];
  const skipped: string[] = [];
  for (const pm of load.postmortems) {
    try {
      cases.push(evalCaseFromPostmortem(pm));
    } catch {
      skipped.push(pm.id);
    }
  }
  if (skipped.length > 0) {
    // Visible, never silent: a record with no task line cannot state a case.
    console.error(`note: ${skipped.length} post-mortem(s) skipped (no task line): ${skipped.join(", ")}`);
  }
  return { cases, skipped: skipped.length };
}

/**
 * H-7: every number the CLI reports has a CONTRACTED machine-readable form.
 * The default human text stays byte-identical (ruling 505/510 precedent); this
 * parallel surface is emitted in `--metrics-out` so a consumer can prove each
 * number carries Metric/Anchor/Population/Excludes.
 */
export function evalRunPublication(run: Awaited<ReturnType<typeof runEvalSet>>, skipped = 0): string[] {
  const passed = run.results.filter((r) => r.passed).length;
  const failed = run.results.length - passed;
  const totalWallMs = run.results.reduce((s, r) => s + r.metrics.wallMs, 0);
  const maxWallMs = run.results.reduce((m, r) => Math.max(m, r.metrics.wallMs), 0);
  const totalCostUsd = run.results.reduce((s, r) => s + r.metrics.costUsd, 0);
  const withCostData = run.results.filter((r) => r.metrics.costSource !== "none").length;
  const anchor = "none — first eval-run CLI run (no prior run to compare against)";
  const population = `${run.results.length} eval case(s) executed by this eval-run CLI invocation`;
  const excludes = "none — every case in the set produced a graded result (executor throws are graded as executor_error)";
  return [
    metricContract({ metric: "eval-run cases executed", anchor, population, excludes, value: run.results.length }),
    metricContract({ metric: "eval-run cases passed / failed", anchor, population, excludes, value: `${passed} passed / ${failed} failed` }),
    metricContract({ metric: "eval-run cases skipped (no task line)", anchor, population, excludes, value: skipped }),
    metricContract({ metric: "eval-run wall-clock (milliseconds)", anchor, population, excludes, value: `${Math.round(totalWallMs)}ms total / ${Math.round(maxWallMs)}ms max case` }),
    metricContract({ metric: "eval-run cost (USD, harness estimate where derived)", anchor, population, excludes, value: `$${totalCostUsd.toFixed(6)} (${withCostData}/${run.results.length} case(s) with cost data)` }),
    metricContract({ metric: "eval-run suite-gate failures", anchor, population, excludes, value: run.aggregate.suiteFailures.length }),
  ];
}

export async function runEvalCli(
  argv: readonly string[],
  io: EvalCliIo = DEFAULT_IO,
  extras: EvalCliExtras = {},
): Promise<number> {
  // G-8: on-disk ratchet gate. An alternative to running cases: load an
  // approval + baseline/candidate result files from disk, decide keep/revert on
  // the frozen split, and persist an append-only decision log. No case source
  // or --forbidden is needed in this mode. Exit 0 = keep, 1 = revert, 2 = refusal.
  const ratchetSpec = argValue(argv, "--ratchet");
  if (ratchetSpec !== undefined) {
    if (ratchetSpec === "") {
      io.err(`--ratchet needs a spec JSON path\n${USAGE}`);
      return 2;
    }
    try {
      const spec = parseRatchetGateSpec(readFileSync(ratchetSpec, "utf8"), ratchetSpec);
      const report = runRatchetGate(spec);
      io.out(`ratchet: ${report.verdict} · variant=${report.variantId} · round=${report.round} · ${report.reason}`);
      for (const block of report.published) io.out(block);
      io.out(
        `ratchet decision: ${report.append.appended ? "appended" : `no-op (${report.append.note})`} → ${spec.decisionLog}`,
      );
      return report.verdict === "keep" ? 0 : 1;
    } catch (err) {
      io.err(`ratchet gate refused: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  // G-9: index-derived bench corpus. A JSONL of `{index, salt?}` records is
  // derived into local cases, executed, and graded locally — no external
  // benchmark harness. Exit 0 = all cases passed, 1 = a case failed, 2 = refusal.
  const benchCorpus = argValue(argv, "--bench-corpus");
  if (benchCorpus !== undefined) {
    if (benchCorpus === "") {
      io.err(`--bench-corpus needs a JSONL file path\n${USAGE}`);
      return 2;
    }
    let benchCases;
    try {
      benchCases = casesFromCorpusJsonl(readFileSync(benchCorpus, "utf8"), benchCorpus);
    } catch (err) {
      io.err(`bench corpus refused: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
    const liveBench = argv.includes("--live");
    const handle = makeRuntimeExecutor({ mock: !liveBench, keepWorkspaces: argv.includes("--keep") });
    io.out(`indexed bench: ${benchCases.length} case(s) · model=${liveBench ? "configured live provider" : "mock (hermetic)"}`);
    const benchRun = await runIndexedBench(benchCases, handle.executor);
    for (const result of benchRun.results) {
      io.out(
        `${result.passed ? "PASS" : "FAIL"} ${result.caseId} · index=${result.index} · terminal=${result.terminal}${result.reason !== undefined ? ` · ${result.reason}` : ""}`,
      );
    }
    for (const block of benchRun.published) io.out(block);
    return benchRun.failed === 0 ? 0 : 1;
  }

  const casesFile = argValue(argv, "--cases");
  const postmortems = argValue(argv, "--postmortems");
  if ((casesFile === undefined) === (postmortems === undefined)) {
    io.err(`exactly one case source is required\n${USAGE}`);
    return 2;
  }

  const forbidden = loadForbidden(argv);
  if (forbidden.length === 0) {
    io.err(
      `--forbidden is required: an isolation check with nothing to check is theatre (core/evals.ts refuses an empty list)\n${USAGE}`,
    );
    return 2;
  }

  let cases: PostmortemEvalCase[];
  let skippedCases = 0;
  try {
    if (casesFile !== undefined) {
      cases = parseCaseFile(readFileSync(casesFile, "utf8"), casesFile);
    } else {
      const loaded = await casesFromPostmortems(postmortems!);
      cases = loaded.cases;
      skippedCases = loaded.skipped;
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (cases.length === 0) {
    io.err(`no runnable cases were found\n${USAGE}`);
    return 2;
  }

  const approvalPath = argValue(argv, "--approval");
  const writeApprovalPath = argValue(argv, "--write-approval");
  try {
    if (approvalPath !== undefined && approvalPath !== "") assertEvalApprovalFresh(cases, approvalPath);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const live = argv.includes("--live");
  const keep = argv.includes("--keep");
  const predsOut = argValue(argv, "--preds-out");
  const submitCmd = argValue(argv, "--submit-cmd");
  const harness = argValue(argv, "--harness");
  const dataset = argValue(argv, "--dataset");
  const split = argValue(argv, "--split");
  const instancesRaw = argValue(argv, "--instances");
  // `--harness swebench-official` is a `--submit` variant: selecting it opts
  // into submission (there is no other reason to build the official argv).
  const submitRequested =
    argv.includes("--submit") || submitCmd !== undefined || harness !== undefined;
  const metricsOut = argValue(argv, "--metrics-out");
  const maxSuiteWallMs = numericOption(argv, "--max-suite-wall-ms", io);
  const maxSuiteCostUsd = numericOption(argv, "--max-suite-cost-usd", io);
  if (maxSuiteWallMs === "bad" || maxSuiteCostUsd === "bad") return 2;
  if (metricsOut === "") {
    io.err(`--metrics-out needs a file path\n${USAGE}`);
    return 2;
  }
  if (submitCmd === "") {
    io.err(`--submit-cmd needs a command (or use HZ_SWEBENCH_HARNESS)\n${USAGE}`);
    return 2;
  }
  // J-1: --harness selects an ADAPTER, never a built-in harness. Only the
  // official argv adapter ships; the harness/dataset/credentials are external.
  if (harness !== undefined && harness !== "swebench-official") {
    io.err(`--harness ${JSON.stringify(harness)} is unsupported (use swebench-official)\n${USAGE}`);
    return 2;
  }
  if (harness !== undefined && submitCmd !== undefined) {
    io.err(`--harness and --submit-cmd are mutually exclusive\n${USAGE}`);
    return 2;
  }
  if (harness === undefined && (dataset !== undefined || split !== undefined || instancesRaw !== undefined)) {
    io.err(`--dataset/--split/--instances require --harness swebench-official\n${USAGE}`);
    return 2;
  }
  if (dataset === "" || split === "" || instancesRaw === "") {
    io.err(`--dataset/--split/--instances need non-empty values\n${USAGE}`);
    return 2;
  }
  const instanceIds =
    instancesRaw === undefined ? undefined : instancesRaw.split(",").map((id) => id.trim()).filter((id) => id !== "");
  if (instanceIds !== undefined && instanceIds.length === 0) {
    io.err(`--instances needs at least one id\n${USAGE}`);
    return 2;
  }
  if (submitRequested && (predsOut === undefined || predsOut === "")) {
    io.err(`--submit requires --preds-out <preds.json> — nothing to submit otherwise\n${USAGE}`);
    return 2;
  }
  const handle = makeRuntimeExecutor({ mock: !live, keepWorkspaces: keep });

  io.out(`eval runner: ${cases.length} case(s) · model=${live ? "configured live provider" : "mock (hermetic)"}`);
  // A case-side refusal (or a forbidden text inside a case) refuses the whole
  // set before any execution — surfaced as a usage error, never as a run.
  let run: Awaited<ReturnType<typeof runEvalSet>>;
  try {
    run = await runEvalSet(cases, {
      executor: handle.executor,
      forbiddenTexts: forbidden,
      ...(maxSuiteWallMs !== undefined ? { maxSuiteWallMs } : {}),
      ...(maxSuiteCostUsd !== undefined ? { maxSuiteCostUsd } : {}),
    });
  } catch (err) {
    io.err(`eval set refused: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const byCase = new Map(run.results.map((result) => [result.caseId, result]));
  for (const observation of handle.observations()) {
    const result = byCase.get(observation.caseId);
    const tools = observation.toolCalls.length > 0 ? observation.toolCalls.join(",") : "none";
    const kept = observation.kept ? ` · ws=${observation.workspace}` : "";
    io.out(
      `${result?.passed === true ? "PASS" : "FAIL"} ${observation.caseId} · terminal=${observation.terminal} · tools=${tools} · ${observation.durationMs}ms${kept}`,
    );
    for (const failure of result?.failures ?? []) io.out(`     ${failure.kind}: ${failure.detail}`);
    if (predsOut !== undefined && predsOut !== "") {
      const record: PredsRecordV1 = {
        instance_id: observation.caseId,
        model_name_or_path: observation.model,
        model_patch: observation.submission,
        exit_status: observation.terminal,
        horizon: {
          terminal: observation.terminal,
          durationMs: observation.durationMs,
          sessionId: observation.sessionId,
        },
      };
      upsertPredsRecord(predsOut, record);
    }
  }

  // J-1: optional EXTERNAL SWE-bench submission. The preds.json has just been
  // written above; validate it and invoke the configured harness. No harness ⇒
  // typed refusal (never a pretend "submitted" line).
  if (submitRequested) {
    try {
      if (harness === "swebench-official") {
        const submitted = await submitWithOfficialHarness({
          predsFile: predsOut!,
          ...(dataset !== undefined ? { dataset } : {}),
          ...(split !== undefined ? { split } : {}),
          ...(instanceIds !== undefined ? { instanceIds } : {}),
          ...(extras.officialHarnessPython !== undefined ? { python: extras.officialHarnessPython } : {}),
          ...(extras.officialHarnessExec !== undefined ? { exec: extras.officialHarnessExec } : {}),
        });
        io.out(`swebench submit: OK · ${submitted.predictionCount} prediction(s) · harness=swebench-official`);
        io.out(`swebench harness argv: ${submitted.argv.join(" ")}`);
      } else {
        const command = resolveSubmitCommand(submitCmd !== undefined ? { submitCmd } : {});
        const submitted = submitPredictions({ predsFile: predsOut!, command });
        io.out(`swebench submit: OK · ${submitted.predictionCount} prediction(s) · harness=${command}`);
      }
    } catch (err) {
      io.err(`swebench submit refused: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  for (const block of run.aggregate.published) io.out(block);
  const passed = run.results.filter((result) => result.passed).length;
  io.out(`summary: ${run.results.length} case(s), ${passed} passed, ${run.results.length - passed} failed`);

  // F-4: additive resource report. Every line above this point is unchanged —
  // the new numbers come from the per-case metrics and the contracted blocks
  // already printed in the loop above.
  const withCostData = run.results.filter((r) => r.metrics.costSource !== "none").length;
  const totalWallMs = run.results.reduce((sum, r) => sum + r.metrics.wallMs, 0);
  const maxWallMs = run.results.reduce((max, r) => Math.max(max, r.metrics.wallMs), 0);
  const totalCostUsd = run.results.reduce((sum, r) => sum + r.metrics.costUsd, 0);
  const maxCostUsd = run.results.reduce((max, r) => Math.max(max, r.metrics.costUsd), 0);
  io.out(
    `metrics: wall=${totalWallMs}ms total / ${maxWallMs}ms max case · cost=$${totalCostUsd.toFixed(6)} total / $${maxCostUsd.toFixed(6)} max case (harness estimate; ${withCostData}/${run.results.length} case(s) reported usage or cost)`,
  );
  if (maxSuiteWallMs !== undefined || maxSuiteCostUsd !== undefined) {
    const caps: string[] = [];
    if (maxSuiteWallMs !== undefined) caps.push(`wall<=${maxSuiteWallMs}ms`);
    if (maxSuiteCostUsd !== undefined) caps.push(`cost<=$${maxSuiteCostUsd}`);
    const gate = run.aggregate.suiteFailures.length === 0 ? "PASS" : "FAIL";
    io.out(`suite gates: ${gate} (${caps.join(", ")})`);
    for (const failure of run.aggregate.suiteFailures) io.out(`     ${failure.kind}: ${failure.detail}`);
  }
  if (metricsOut !== undefined && metricsOut !== "") {
    const report = {
      cases: run.results.map((r) => ({
        caseId: r.caseId,
        passed: r.passed,
        wallMs: r.metrics.wallMs,
        costUsd: r.metrics.costUsd,
        costSource: r.metrics.costSource,
        ...(r.metrics.priceTableRevision !== undefined ? { priceTableRevision: r.metrics.priceTableRevision } : {}),
        ...(r.metrics.usage !== undefined ? { usage: r.metrics.usage } : {}),
        failureKinds: r.failures.map((f) => f.kind),
      })),
      totals: {
        wallMs: totalWallMs,
        maxWallMs,
        costUsd: totalCostUsd,
        maxCostUsd,
        costSourceCases: withCostData,
        caseCount: run.results.length,
      },
      suiteFailures: run.aggregate.suiteFailures,
      published: evalRunPublication(run, skippedCases),
    };
    try {
      writeFileSync(metricsOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      io.out(`wrote metrics: ${metricsOut}`);
    } catch (err) {
      io.err(`could not write metrics report: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (writeApprovalPath !== undefined && writeApprovalPath !== "") {
    const heldOutRaw = argValue(argv, "--held-out-fraction");
    const splitSeedRaw = argValue(argv, "--split-seed");
    let frozenSplit = undefined;
    if (heldOutRaw !== undefined && heldOutRaw !== "") {
      const heldOutFraction = Number(heldOutRaw);
      if (!Number.isFinite(heldOutFraction)) {
        io.err(`--held-out-fraction must be a number between 0 and 1\n${USAGE}`);
        return 2;
      }
      const splitSeed =
        splitSeedRaw !== undefined && splitSeedRaw !== "" ? Number(splitSeedRaw) : undefined;
      if (splitSeed !== undefined && (!Number.isInteger(splitSeed) || splitSeed < 0)) {
        io.err(`--split-seed must be a non-negative integer\n${USAGE}`);
        return 2;
      }
      try {
        frozenSplit = buildFrozenSplit(
          cases.map((c) => c.id),
          { heldOutFraction, ...(splitSeed !== undefined ? { splitSeed } : {}) },
        );
      } catch (err) {
        io.err(err instanceof Error ? err.message : String(err));
        return 2;
      }
    } else if (splitSeedRaw !== undefined) {
      io.err(`--split-seed requires --held-out-fraction (frozen split)\n${USAGE}`);
      return 2;
    }
    const approval = buildEvalApproval(cases, undefined, frozenSplit);
    writeFileSync(writeApprovalPath, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
    const splitNote =
      approval.frozenSplit !== undefined
        ? ` · frozenSplit train=${approval.frozenSplit.trainIds.length} heldOut=${approval.frozenSplit.heldOutIds.length} seed=${approval.frozenSplit.splitSeed}`
        : "";
    io.out(
      `wrote approval: ${writeApprovalPath} (casesContentHash ${approval.casesContentHash}${splitNote})`,
    );
  }

  return passed === run.results.length && run.aggregate.suiteFailures.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await runEvalCli(process.argv.slice(2));
}
