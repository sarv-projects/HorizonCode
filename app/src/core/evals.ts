/**
 * evals.ts — eval cases built from post-mortems, the enforced
 * answer-isolation precondition, and the executor-injected eval runner
 * (docs/30 §4 item 8, reduced form).
 *
 * Four things live here and nothing else:
 *  1. `evalCaseFromPostmortem(pm)`: a candidate case in a LOCAL form, plainly
 *     named `PostmortemEvalCase`. The wire schema is docs/05 §4.10
 *     `EvalCaseV1` (`evl_<ulid>`, a different field set, `DESIGNED` in that
 *     document) — this record is NOT it and must not be mistaken for it. The
 *     local id prefix is `eval-from-` on purpose.
 *  2. `assertAnswerIsolation` / `answerIsolationPrecondition`: the case must
 *     not carry the answer side of the trajectory. The caller passes the final
 *     assistant output(s) as the forbidden texts; the scan is deep (string
 *     field values and object keys, any nesting) and the refusal names the
 *     JSONPath-style field where the leak was found. Nothing is waived: a
 *     forbidden string is either absent or the case is refused.
 *  3. `summarizeEvalSet(cases)`: publishes its numbers THROUGH
 *     `metricContract()` from `core/metrics.ts` (H-7, docs/16 §2.4.3) — every
 *     count leaves this module as a contracted block (Metric/Anchor/Population/
 *     Excludes), never as a bare number.
 *  4. `runEvalCase` / `runEvalSet`: the eval RUNNER, executor-INJECTED. The
 *     caller supplies `opts.executor`; the runner itself performs no I/O, no
 *     provider call and no loop run, which is what makes the grader fully
 *     unit-testable today. NOTHING in the product wires this to the live loop:
 *     the loop/provider executor and the test-model-in-library are the
 *     remaining docs/30 §4 item 8 pieces (named at the bottom).
 *
 * The runner, as pinned (one case): (a) it re-asserts the answer-isolation
 * precondition against the case with the caller's `forbiddenTexts` FIRST — a
 * case-side leak or an unusable list throws the typed `EvalCaseRefusal` before
 * any execution, naming the leaking field; (b) it executes through the
 * injected `executor` inside try/catch — a throw (or a malformed result) is
 * GRADED, never re-thrown: exactly one `executor_error` failure and an errored
 * outcome `{terminal: "failed", error}` (the loop's own internal-error shape:
 * `loop.ts` reports `detail: "internal_error"` as terminal `failed`, and the
 * RC-7 terminal vocabulary has no `internal_error` value, so it cannot be a
 * terminal here); (c) it grades every assertion the case carries — `terminal`
 * (the observed terminal must equal the case's value) and `no_answer_leak`
 * (definition below) — and a kind the runner cannot grade fails as
 * `unknown_assertion` rather than being silently skipped; (d) it returns
 * `{caseId, passed, failures, outcome}`. `runEvalSet` re-asserts every case
 * BEFORE the set's first execution (a leak anywhere refuses the whole set —
 * nothing has run) and publishes the run/passed/failed counts as contracted
 * blocks; the aggregate carries no bare count.
 *
 * The `no_answer_leak` definition, pinned — both halves. CASE half: the case
 * record itself must contain none of the forbidden texts; step (a) proves that
 * before execution and refuses, naming the field (`$.task`, `$.setup.tools[1]`,
 * …). RUN half: with the executor's `finalAnswer` in hand, that string must
 * not contain any of the forbidden texts; the first match in list order fails
 * the assertion, naming the text. The injected executor reports only
 * `{terminal, finalAnswer, toolCalls?}` — no transcript, tool results or
 * receipts — so the run half is exactly this finalAnswer check, stated rather
 * than implied.
 *
 * Refusals are typed (`EvalCaseRefusal`) and carry a machine-readable `code`;
 * the four codes and their exact message prefixes are: `no_task`, `bad_source`,
 * `answer_leak`, `bad_forbidden` (the strings are pinned in
 * `tests/core/postmortems-evals.test.ts`).
 *
 * Not in this slice, named: the live-loop/provider executor (nothing builds
 * one here; nothing in the product calls `runEvalCase`/`runEvalSet` yet), and
 * test-model-in-library. The answer-isolation precondition here is the
 * string-level half (Reasonix `answer_isolation.go`'s OS read sandbox is the
 * other half, docs/29 C-27): a case whose task *is* the answer has nothing to
 * leak and still must not be run.
 */

import type { RunExit, TerminalState } from "../contracts";
import { metricContract } from "./metrics";
import type { PostmortemRecord } from "./postmortem";

/** Why a case was refused (the `code` carried by every `EvalCaseRefusal`). */
export type EvalCaseRefusalCode = "no_task" | "bad_source" | "answer_leak" | "bad_forbidden";

/** The typed refusal of eval-case construction and of answer isolation. */
export class EvalCaseRefusal extends Error {
  readonly code: EvalCaseRefusalCode;
  /** JSONPath-style location of the leak (`answer_leak` only). */
  readonly field?: string;

  constructor(code: EvalCaseRefusalCode, message: string, field?: string) {
    super(message);
    this.name = "EvalCaseRefusal";
    this.code = code;
    this.field = field;
  }
}

/** One assertion a case makes about a run (the two kinds this slice builds). */
export type EvalAssertion = { kind: "terminal"; value: TerminalState } | { kind: "no_answer_leak" };

/**
 * The local candidate form (NOT docs/05 `EvalCaseV1` — see the header): the
 * task to state, the tools the run exercised, and what must hold afterwards.
 */
export interface PostmortemEvalCase {
  /** Local id; default `eval-from-<postmortem id>` (never an `evl_` wire id). */
  id: string;
  /** `PostmortemRecord.id` — the traceability link back to the run's record. */
  from: string;
  /** The post-mortem's first user-visible task line (never invented). */
  task: string;
  /** The tool names the run exercised, sorted and deduplicated. */
  setup: { tools: string[] };
  assertions: EvalAssertion[];
}

/** How much of a forbidden string the refusal message may echo. */
const FORBIDDEN_PREVIEW_CHARS = 60;
/** A guard against pathological nesting; a case is data, not a data structure. */
const MAX_SCAN_DEPTH = 64;

export interface EvalCaseFromPostmortemOptions {
  /** Override the local id (default `eval-from-<pm.id>`). */
  id?: string;
}

/**
 * Build a candidate eval case from one post-mortem.
 *
 * Refusals (typed): `bad_source` when the post-mortem has no id to trace back
 * to, `no_task` when it carries no first user-visible task line — inventing a
 * task from a failure's prose would make the case measure something else.
 */
export function evalCaseFromPostmortem(
  pm: PostmortemRecord,
  opts: EvalCaseFromPostmortemOptions = {},
): PostmortemEvalCase {
  const from = typeof pm?.id === "string" ? pm.id.trim() : "";
  if (from === "") {
    throw new EvalCaseRefusal(
      "bad_source",
      "eval case refused (bad_source): the post-mortem has no id — a case must be traceable to the record it came from",
    );
  }
  const task = typeof pm.task === "string" ? pm.task.trim() : "";
  if (task === "") {
    throw new EvalCaseRefusal(
      "no_task",
      `eval case refused (no_task): post-mortem "${from}" carries no first user-visible task line — nothing can be stated as the task (refusing rather than inventing one)`,
    );
  }
  const id = typeof opts.id === "string" && opts.id.trim() !== "" ? opts.id.trim() : `eval-from-${from}`;
  const tools = Object.keys(pm.toolCalls ?? {}).sort();
  return {
    id,
    from,
    task,
    setup: { tools },
    assertions: [{ kind: "terminal", value: pm.terminal }, { kind: "no_answer_leak" }],
  };
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

interface Leak {
  field: string;
  /** The caller's forbidden text that matched. */
  text: string;
}

function preview(text: string): string {
  return text.length > FORBIDDEN_PREVIEW_CHARS ? `${text.slice(0, FORBIDDEN_PREVIEW_CHARS)}…` : text;
}

/**
 * The forbidden-text list, validated. An empty list is refused: an isolation
 * check with no answer side to check asserts nothing and would be read as a
 * pass — the refusal is the honest answer.
 */
function normalizeForbidden(forbiddenTexts: readonly string[]): string[] {
  if (!Array.isArray(forbiddenTexts) || forbiddenTexts.length === 0) {
    throw new EvalCaseRefusal(
      "bad_forbidden",
      "eval case refused (bad_forbidden): forbiddenTexts is empty — pass the final assistant output(s); an isolation check with nothing to check is theatre",
    );
  }
  for (const entry of forbiddenTexts) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new EvalCaseRefusal(
        "bad_forbidden",
        "eval case refused (bad_forbidden): every forbidden text must be a non-blank string",
      );
    }
  }
  return [...forbiddenTexts];
}

/**
 * Deep scan for any forbidden text in string field values or object keys.
 * Objects visited once (a repeated or cyclic object is not re-scanned) and the
 * walk stops at `MAX_SCAN_DEPTH`. Non-string leaves carry no text and are
 * skipped. The first match in walk order is returned.
 */
function findLeak(value: unknown, forbidden: readonly string[], seen: WeakSet<object> = new WeakSet()): Leak | undefined {
  const walk = (node: unknown, path: string, depth: number): Leak | undefined => {
    if (depth > MAX_SCAN_DEPTH) return undefined;
    if (typeof node === "string") {
      const hit = forbidden.find((text) => node.includes(text));
      return hit === undefined ? undefined : { field: path, text: hit };
    }
    if (node === null || typeof node !== "object") return undefined;
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const found = walk(node[index], `${path}[${index}]`, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      const keyPath = childPath(path, key);
      const hit = forbidden.find((text) => key.includes(text));
      if (hit !== undefined) return { field: keyPath, text: hit };
      const found = walk((node as Record<string, unknown>)[key], keyPath, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(value, "$", 0);
}

/**
 * The enforced precondition: refuse (typed, naming the field) when any
 * forbidden text — the answer side of the trajectory — appears anywhere in the
 * case. Throws `EvalCaseRefusal("answer_leak")` on a leak and
 * `EvalCaseRefusal("bad_forbidden")` when the list is unusable.
 */
export function assertAnswerIsolation(caseObj: unknown, forbiddenTexts: readonly string[]): void {
  const forbidden = normalizeForbidden(forbiddenTexts);
  const leak = findLeak(caseObj, forbidden);
  if (leak === undefined) return;
  throw new EvalCaseRefusal(
    "answer_leak",
    `eval case refused (answer_leak): answer-side text ${JSON.stringify(preview(leak.text))} appears at ${leak.field} — the case must not carry the answer side of the trajectory`,
    leak.field,
  );
}

/**
 * The non-throwing form of the precondition: true only when the case carries
 * none of the answer-side texts. An unusable list (empty or blank entries) is
 * false, not an exception — the caller cannot call this "isolated" without
 * something to check against.
 *
 * The parameter keeps the work item's name (`allowed`): these are the texts
 * whose presence makes the case *not* allowed to run. There is no waiver
 * mechanism — a case either lacks the answer or is refused.
 */
export function answerIsolationPrecondition(caseObj: unknown, allowed: readonly string[]): boolean {
  try {
    const forbidden = normalizeForbidden(allowed);
    return findLeak(caseObj, forbidden) === undefined;
  } catch {
    return false;
  }
}

/** The summary of one eval set: raw counts plus their contracted publications. */
export interface EvalSetSummary {
  cases: number;
  /** Cases carrying at least one `no_answer_leak` assertion. */
  withNoAnswerLeakAssertion: number;
  /** Terminal assertion counts by outcome value. */
  terminals: Record<string, number>;
  /** Case counts by tool name (a case counts once per tool it exercises). */
  tools: Record<string, number>;
  /** One contracted block per published number (H-7) — never a bare number. */
  published: string[];
}

/**
 * Summarise an eval set under the metric contract (H-7, docs/16 §2.4.3).
 * Every number is rendered by `metricContract`, so a block without its four
 * slots cannot be produced here; `published` is the only machine-readable
 * surface, and the raw counts are returned beside it for callers that need to
 * branch, not to publish.
 *
 * The anchor is deliberately "none — first measurement": no eval run has ever
 * reported a number in this repository, so a comparison baseline would be
 * invented. The population and excludes slots say what this is (case
 * population, not results) in the block itself.
 */
export function summarizeEvalSet(cases: readonly PostmortemEvalCase[]): EvalSetSummary {
  if (!Array.isArray(cases)) throw new Error("summarizeEvalSet: cases must be an array");
  const list: unknown[] = cases as unknown[];
  const terminals: Record<string, number> = {};
  const tools: Record<string, number> = {};
  let withNoAnswerLeakAssertion = 0;

  list.forEach((raw, index) => {
    const c = raw as Partial<PostmortemEvalCase> | null;
    if (
      c === null ||
      typeof c !== "object" ||
      typeof c.id !== "string" ||
      c.id === "" ||
      typeof c.from !== "string" ||
      c.from === ""
    ) {
      throw new Error(`summarizeEvalSet: cases[${index}] is not an eval case (id/from missing)`);
    }
    let carriesIsolation = false;
    for (const assertion of Array.isArray(c.assertions) ? c.assertions : []) {
      if (assertion?.kind === "terminal" && typeof assertion.value === "string") {
        terminals[assertion.value] = (terminals[assertion.value] ?? 0) + 1;
      }
      if (assertion?.kind === "no_answer_leak") carriesIsolation = true;
    }
    if (carriesIsolation) withNoAnswerLeakAssertion += 1;
    for (const tool of Array.isArray(c.setup?.tools) ? c.setup.tools : []) {
      if (typeof tool === "string" && tool !== "") tools[tool] = (tools[tool] ?? 0) + 1;
    }
  });

  const population = `${cases.length} eval case(s) in this set (local candidate form, core/evals.ts; this is a case-population summary — run results are published by runEvalSet)`;
  const anchor = "none — first measurement (no prior eval set or run to compare against)";
  const excludes =
    "eval runs and their outcomes — this summary is case-population, not results; run outcomes are published by runEvalSet";
  const terminalDistribution = Object.keys(terminals)
    .sort()
    .map((key) => `${key}=${terminals[key]}`)
    .join(", ");
  const totalToolEntries = Object.values(tools).reduce((sum, count) => sum + count, 0);

  const published = [
    metricContract({ metric: "eval cases in set", anchor, population, excludes, value: cases.length }),
    metricContract({
      metric: "cases carrying the no_answer_leak assertion",
      anchor,
      population,
      excludes,
      value: withNoAnswerLeakAssertion,
    }),
    metricContract({
      metric: "terminal assertions by outcome (RC-7 vocabulary)",
      anchor,
      population,
      excludes,
      value: terminalDistribution === "" ? "none" : terminalDistribution,
    }),
    metricContract({
      metric: "tool names exercised across the set (case-tool pairs)",
      anchor,
      population,
      excludes,
      value: `${Object.keys(tools).length} distinct / ${totalToolEntries} entries`,
    }),
  ];

  return { cases: cases.length, withNoAnswerLeakAssertion, terminals, tools, published };
}

/* ------------------------------- the runner ------------------------------- */

/** What one injected execution observed — the executor's contract, exactly. */
export interface EvalExecutorResult {
  /** The RC-7 terminal the run ended on (`RunExit.terminal`). */
  terminal: RunExit["terminal"];
  /** The run's final assistant output: the only run text the runner grades. */
  finalAnswer: string;
  /** The tool names the run exercised, when the executor can report them. */
  toolCalls?: string[];
}

/**
 * The injected executor: runs one case and reports what the run observed. The
 * runner never builds one — no loop wiring, no provider harness — which is
 * what keeps the grading logic pure and unit-testable today.
 */
export type EvalExecutor = (caseObj: PostmortemEvalCase) => Promise<EvalExecutorResult>;

/** The runner's options: who executes, and the answer side to check against. */
export interface EvalRunnerOptions {
  executor: EvalExecutor;
  /**
   * The answer side of the trajectory (the final assistant output(s)). A
   * forbidden text in the CASE refuses (typed, before any execution); a
   * forbidden text in the run's `finalAnswer` fails `no_answer_leak`.
   */
  forbiddenTexts: readonly string[];
}

/** Why a run failed; the closed set of failure kinds the runner produces. */
export type EvalFailureKind = "terminal" | "no_answer_leak" | "executor_error" | "unknown_assertion";

/** One graded failure: what was expected, what was observed, and why. */
export interface EvalFailure {
  kind: EvalFailureKind;
  /** The assertion's expected value (`terminal` only). */
  expected?: string;
  /** What was observed instead: the terminal, the matched text, the thrown message. */
  observed?: string;
  detail: string;
}

/** The normalised observation the runner graded. */
export interface EvalRunOutcome {
  terminal: TerminalState;
  finalAnswer: string;
  toolCalls: string[];
  /**
   * Set when the executor threw or returned a malformed result: no run was
   * observed. The terminal is then the loop's internal-error shape — `failed`,
   * exactly what `loop.ts` reports for `detail: "internal_error"` (the RC-7
   * vocabulary has no `internal_error` value, so it cannot be a terminal here).
   */
  error?: string;
}

/** The graded result of one case: the failures, the observation, the verdict. */
export interface EvalRunResult {
  caseId: string;
  passed: boolean;
  failures: EvalFailure[];
  outcome: EvalRunOutcome;
}

/** The set aggregate: published numbers only (H-7). */
export interface EvalSetRunAggregate {
  /**
   * One contracted block per count (Metric/Anchor/Population/Excludes): the
   * aggregate carries no bare count — a caller that needs one counts
   * `results`, and a number that leaves here without its four slots cannot be
   * produced.
   */
  published: string[];
}

/** `runEvalSet`'s full result: per-case results in input order + the aggregate. */
export interface EvalSetRun {
  results: EvalRunResult[];
  aggregate: EvalSetRunAggregate;
}

/**
 * The RC-7 terminal vocabulary as data, exhaustive by construction (the same
 * pattern as `core/postmortem.ts`): adding a value to `TerminalState` in
 * `../contracts.ts` makes this declaration fail to compile instead of silently
 * missing a value here. Used to refuse a malformed executor result — a
 * terminal outside the closed vocabulary cannot be compared honestly.
 */
const RC7: Record<TerminalState, true> = {
  succeeded: true,
  failed: true,
  denied: true,
  cancelled: true,
  unknown: true,
  budget_exhausted: true,
  timeout: true,
  interrupted: true,
};
const TERMINALS: readonly string[] = Object.keys(RC7);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A case must be runnable before anything else happens (programming errors). */
function requireRunnableCase(caseObj: unknown, label: string): PostmortemEvalCase {
  const candidate = caseObj as Partial<PostmortemEvalCase> | null;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof candidate.id !== "string" ||
    candidate.id.trim() === ""
  ) {
    throw new Error(`${label} is not an eval case (id missing)`);
  }
  if (!Array.isArray(candidate.assertions) || candidate.assertions.length === 0) {
    throw new Error(`${label} carries no assertions — an eval case that asserts nothing is theatre`);
  }
  return caseObj as PostmortemEvalCase;
}

function requireExecutor(opts: EvalRunnerOptions | undefined, label: string): EvalExecutor {
  const executor = opts?.executor;
  if (typeof executor !== "function") {
    throw new Error(`${label}: opts.executor must be a function — the runner never builds one (no loop/provider wiring in this slice)`);
  }
  return executor;
}

/**
 * Normalise an executor return value; a malformed result is refused the same
 * way a throw is — as a graded `executor_error`, never a comparison. There is
 * no honest terminal to compare and no text to scan.
 */
function normalizeExecutorResult(raw: unknown): { outcome: EvalRunOutcome } | { malformed: string } {
  const result = raw as Partial<EvalExecutorResult> | null;
  if (result === null || typeof result !== "object") {
    return { malformed: "the executor returned a non-object result" };
  }
  if (typeof result.terminal !== "string" || !TERMINALS.includes(result.terminal)) {
    return {
      malformed: `the executor returned terminal ${JSON.stringify(result.terminal)} — not an RC-7 value (${TERMINALS.join(", ")})`,
    };
  }
  if (typeof result.finalAnswer !== "string") {
    return { malformed: "the executor returned no finalAnswer string" };
  }
  const toolCalls = result.toolCalls;
  if (toolCalls !== undefined && (!Array.isArray(toolCalls) || !toolCalls.every((name) => typeof name === "string"))) {
    return { malformed: "the executor returned toolCalls that is not an array of strings" };
  }
  return {
    outcome: {
      terminal: result.terminal as TerminalState,
      finalAnswer: result.finalAnswer,
      toolCalls: [...(toolCalls ?? [])],
    },
  };
}

/** The graded shape of "the executor produced no run": one failure, errored outcome. */
function executorErrorResult(caseId: string, message: string): EvalRunResult {
  return {
    caseId,
    passed: false,
    failures: [
      {
        kind: "executor_error",
        observed: message,
        detail: `executor_error: ${message} — graded, not re-thrown; there was no observation, so no assertion is graded against one`,
      },
    ],
    outcome: { terminal: "failed", finalAnswer: "", toolCalls: [], error: message },
  };
}

/**
 * Grade every assertion the case carries (step (c)) against the observation. A
 * kind the runner cannot grade is a failure, not a skip: a case the runner
 * cannot check must not pass.
 */
function gradeAssertions(
  caseObj: PostmortemEvalCase,
  outcome: EvalRunOutcome,
  forbidden: readonly string[],
): EvalFailure[] {
  const failures: EvalFailure[] = [];
  caseObj.assertions.forEach((raw, index) => {
    const assertion = raw as { kind?: unknown; value?: unknown } | null;
    if (assertion?.kind === "terminal") {
      const expected = assertion.value;
      if (outcome.terminal !== expected) {
        failures.push({
          kind: "terminal",
          expected: typeof expected === "string" ? expected : String(expected),
          observed: outcome.terminal,
          detail: `terminal assertion failed: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(outcome.terminal)}`,
        });
      }
      return;
    }
    if (assertion?.kind === "no_answer_leak") {
      // The RUN half of the pinned definition: the run's own output must not
      // contain the answer side. The CASE half was proved by step (a) before
      // any execution.
      const hit = forbidden.find((text) => outcome.finalAnswer.includes(text));
      if (hit !== undefined) {
        failures.push({
          kind: "no_answer_leak",
          observed: hit,
          detail: `no_answer_leak assertion failed: the run's finalAnswer carries answer-side text ${JSON.stringify(preview(hit))} — the run's own output must not contain the answer side`,
        });
      }
      return;
    }
    failures.push({
      kind: "unknown_assertion",
      observed: assertion?.kind === undefined ? "undefined" : String(assertion.kind),
      detail: `assertions[${index}] carries kind ${JSON.stringify(assertion?.kind)} — not a kind this runner grades; a case the runner cannot grade must not pass`,
    });
  });
  return failures;
}

/**
 * Run one eval case (docs/30 §4 item 8, runner half — reduced form).
 *
 * Pure and dependency-injected: no I/O, no clock, no randomness; the same case
 * and the same executor yield the same result. Order is the contract: (a) the
 * answer-isolation precondition is re-asserted against the case BEFORE the
 * executor is called (a leak refuses, typed, naming the field); (b) the
 * executor is awaited inside try/catch — a throw or a malformed result becomes
 * a graded `executor_error` result, never a rejection; (c) every assertion is
 * graded; (d) the typed result is returned.
 */
export async function runEvalCase(caseObj: PostmortemEvalCase, opts: EvalRunnerOptions): Promise<EvalRunResult> {
  const evalCase = requireRunnableCase(caseObj, "runEvalCase: caseObj");
  const executor = requireExecutor(opts, "runEvalCase");

  // (a) FIRST, before any execution: the case must not carry the answer side.
  assertAnswerIsolation(evalCase, opts.forbiddenTexts);
  // The same pure validation, reused so the run-half scan is exactly the list
  // step (a) accepted.
  const forbidden = normalizeForbidden(opts.forbiddenTexts);

  // (b) Execute; an executor throw or a malformed result is graded, not thrown.
  let outcome: EvalRunOutcome;
  try {
    const normalized = normalizeExecutorResult(await executor(evalCase));
    if ("malformed" in normalized) {
      return executorErrorResult(evalCase.id, `the executor returned a malformed result: ${normalized.malformed}`);
    }
    outcome = normalized.outcome;
  } catch (err) {
    return executorErrorResult(evalCase.id, `the executor threw: ${errorMessage(err)}`);
  }

  // (c) Grade every assertion the case carries.
  const failures = gradeAssertions(evalCase, outcome, forbidden);

  // (d) The typed result.
  return { caseId: evalCase.id, passed: failures.length === 0, failures, outcome };
}

/**
 * Run a whole set: every case is checked against the answer side BEFORE the
 * set's first execution (a leak anywhere refuses the whole set — nothing has
 * run), then each case goes through `runEvalCase`. The aggregate publishes the
 * run/passed/failed counts as contracted blocks (H-7) and carries no bare
 * count: a caller that needs one counts `results`.
 *
 * Determinism mirrors `runEvalCase`: no I/O, no clock, no randomness; the same
 * cases and the same executor yield the same results, twice in a row.
 */
export async function runEvalSet(
  cases: readonly PostmortemEvalCase[],
  opts: EvalRunnerOptions,
): Promise<EvalSetRun> {
  if (!Array.isArray(cases)) throw new Error("runEvalSet: cases must be an array");
  const executor = requireExecutor(opts, "runEvalSet");
  // A refusal anywhere refuses the set before ANY execution.
  cases.forEach((c, index) => requireRunnableCase(c, `runEvalSet: cases[${index}]`));
  for (const c of cases) assertAnswerIsolation(c, opts.forbiddenTexts);

  const results: EvalRunResult[] = [];
  for (const c of cases) results.push(await runEvalCase(c, { executor, forbiddenTexts: opts.forbiddenTexts }));

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const population = `${results.length} eval case(s) run through the injected executor (core/evals.ts runEvalSet; the executor is caller-supplied — no loop or provider wiring)`;
  const anchor = "none — first eval run in this repository (no prior run of this set to compare against)";
  const excludes =
    "none — every case in the set produced a graded result (a case-side refusal refuses the whole set before its first execution; an executor throw is graded as executor_error)";
  const published = [
    metricContract({ metric: "eval cases run", anchor, population, excludes, value: results.length }),
    metricContract({ metric: "eval cases passed", anchor, population, excludes, value: passed }),
    metricContract({ metric: "eval cases failed", anchor, population, excludes, value: failed }),
  ];

  return { results, aggregate: { published } };
}
