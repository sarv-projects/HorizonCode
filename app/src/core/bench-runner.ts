/**
 * bench-runner.ts — G-9 product runner for index-derived benchmark corpora.
 *
 * `bench-ground-truth.ts` derives a stimulus per trial index; this module
 * EXECUTES those cases through an injected eval executor and GRADES them
 * locally with `gradeIndexedAnswer` (a substring match on the derived expected
 * token). No external benchmark harness is contacted. The executor is injected
 * exactly as in `evals.ts`, so the runner is hermetically unit-testable.
 *
 * Every published number is a `metricContract` block (H-7). A case whose
 * executor throws is graded as failed with a typed reason — never skipped.
 */

import type { TerminalState } from "../contracts";
import {
  buildIndexedEvalCasesFromCorpus,
  gradeIndexedAnswer,
  parseIndexedCorpusJsonl,
  type IndexedCorpusRecord,
  type IndexedEvalCase,
} from "./bench-ground-truth";
import type { EvalExecutor } from "./evals";
import { metricContract } from "./metrics";

const ANCHOR = "none — first indexed bench run (no prior run to compare against)";
const POPULATION = "index-derived bench cases (local grading via gradeIndexedAnswer)";
const EXCLUDES = "none — every corpus trial is graded; an executor throw is graded as a failed case";

/** Load a corpus from JSONL text and derive its cases. */
export function casesFromCorpusJsonl(text: string, source?: string): IndexedEvalCase[] {
  return buildIndexedEvalCasesFromCorpus(parseIndexedCorpusJsonl(text, source));
}

export interface IndexedBenchResult {
  caseId: string;
  index: number;
  passed: boolean;
  terminal: TerminalState;
  finalAnswer: string;
  durationMs: number;
  reason?: string;
}

export interface IndexedBenchRun {
  results: IndexedBenchResult[];
  passed: number;
  failed: number;
  /** H-7: contracted numeric facts about this run. */
  published: string[];
}

/**
 * Run every derived case through the executor and grade locally. The executor
 * is injected; a throw is graded as a failed case (typed reason), never
 * re-thrown, so one flaky trial cannot hide the rest of the corpus.
 */
export async function runIndexedBench(
  cases: readonly IndexedEvalCase[],
  executor: EvalExecutor,
  opts: { now?: () => number } = {},
): Promise<IndexedBenchRun> {
  const clock = opts.now ?? (() => Date.now());
  const results: IndexedBenchResult[] = [];
  for (const c of cases) {
    const started = clock();
    let finalAnswer = "";
    let terminal: TerminalState = "succeeded";
    let reason: string | undefined;
    try {
      const observed = await executor({
        id: c.id,
        from: "bench-corpus",
        task: c.task,
        setup: { tools: [] },
        assertions: [],
      });
      finalAnswer = observed.finalAnswer;
      terminal = observed.terminal;
    } catch (err) {
      terminal = "failed";
      reason = `executor threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    const passed = reason === undefined && gradeIndexedAnswer(c.expectedToken, finalAnswer);
    results.push({
      caseId: c.id,
      index: Number(c.id.split("-").pop() ?? 0),
      passed,
      terminal,
      finalAnswer,
      durationMs: clock() - started,
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const published = [
    metricContract({ metric: "indexed bench cases run", anchor: ANCHOR, population: POPULATION, excludes: EXCLUDES, value: results.length }),
    metricContract({ metric: "indexed bench cases passed / failed", anchor: ANCHOR, population: POPULATION, excludes: EXCLUDES, value: `${passed} passed / ${failed} failed` }),
    metricContract({
      metric: "indexed bench wall-clock (milliseconds)",
      anchor: ANCHOR,
      population: POPULATION,
      excludes: EXCLUDES,
      value: `${Math.round(results.reduce((s, r) => s + r.durationMs, 0))}ms`,
    }),
  ];
  return { results, passed, failed, published };
}
