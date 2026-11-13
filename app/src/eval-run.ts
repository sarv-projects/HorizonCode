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
 *
 * Defaults: the hermetic mock provider, scratch workspaces under the OS temp
 * dir, removed after each case (`--keep` leaves them for inspection). `--live`
 * runs the configured real provider — the same executor, the same grading.
 *
 * Exit codes: 0 all cases passed; 1 at least one failed; 2 usage error (a
 * refusal — missing `--forbidden`, a corrupt post-mortem store — never runs).
 */

import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { PostmortemEvalCase } from "./core/evals";
import { evalCaseFromPostmortem, runEvalSet } from "./core/evals";
import { makeRuntimeExecutor } from "./core/eval-executor";
import { loadPostmortems } from "./core/postmortem";
import { assertEvalApprovalFresh, buildEvalApproval } from "./core/eval-approval";
import { upsertPredsRecord, type PredsRecordV1 } from "./core/preds-writer";

export interface EvalCliIo {
  out(line: string): void;
  err(line: string): void;
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
  "usage: bun run src/eval-run.ts (--cases <file.json> | --postmortems <state-dir>) --forbidden <text-or-file> [--preds-out <preds.json>] [--approval <file.json>] [--write-approval <file.json>] [--keep] [--live]";

/** The value of `--flag`, or `undefined` when absent (an empty string when bare). */
function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? "" : value;
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

async function casesFromPostmortems(stateDir: string): Promise<PostmortemEvalCase[]> {
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
  return cases;
}

export async function runEvalCli(argv: readonly string[], io: EvalCliIo = DEFAULT_IO): Promise<number> {
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
  try {
    cases = casesFile !== undefined ? parseCaseFile(readFileSync(casesFile, "utf8"), casesFile) : await casesFromPostmortems(postmortems!);
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
  const handle = makeRuntimeExecutor({ mock: !live, keepWorkspaces: keep });

  io.out(`eval runner: ${cases.length} case(s) · model=${live ? "configured live provider" : "mock (hermetic)"}`);
  // A case-side refusal (or a forbidden text inside a case) refuses the whole
  // set before any execution — surfaced as a usage error, never as a run.
  let run: Awaited<ReturnType<typeof runEvalSet>>;
  try {
    run = await runEvalSet(cases, { executor: handle.executor, forbiddenTexts: forbidden });
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

  for (const block of run.aggregate.published) io.out(block);
  const passed = run.results.filter((result) => result.passed).length;
  io.out(`summary: ${run.results.length} case(s), ${passed} passed, ${run.results.length - passed} failed`);

  if (writeApprovalPath !== undefined && writeApprovalPath !== "") {
    const approval = buildEvalApproval(cases);
    writeFileSync(writeApprovalPath, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
    io.out(`wrote approval: ${writeApprovalPath} (casesContentHash ${approval.casesContentHash})`);
  }

  return passed === run.results.length ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await runEvalCli(process.argv.slice(2));
}
