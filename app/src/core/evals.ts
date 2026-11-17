/**
 * evals.ts — eval cases built from post-mortems, the enforced
 * answer-isolation precondition, and the executor-injected eval runner
 * (docs/30 §4 item 8, reduced form).
 *
 * Five things live here and nothing else:
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
 *     remaining docs/30 §4 item 8 pieces (named at the bottom). The runner
 *     DOES read the clock once per case (wall-clock duration) and derives USD
 *     cost from usage the executor chooses to report — see item 5.
 *  5. Cost/latency metrics (F-4, additive): every graded case carries an
 *     `EvalRunMetrics` record — measured wall-clock ms plus a USD cost whose
 *     source is stated honestly (`reported` | `harness-estimate` | `none`).
 *     A provider that reports neither cost nor usage is counted as exactly
 *     $0 with source `none`; no number is invented. Cases may carry opt-in
 *     `max_wall_ms` / `max_cost_usd` assertions, and the set runner accepts
 *     optional suite-wide caps; `runEvalSet` publishes the totals through the
 *     SAME `metricContract` as every other number here.
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
 * (the observed terminal must equal the case's value), `no_answer_leak`
 * (definition below), and the opt-in `max_wall_ms` / `max_cost_usd` thresholds
 * (F-4) — and a kind the runner cannot grade fails as
 * `unknown_assertion` rather than being silently skipped; (d) it returns
 * `{caseId, passed, failures, outcome, metrics}`. `runEvalSet` re-asserts every case
 * BEFORE the set's first execution (a leak anywhere refuses the whole set —
 * nothing has run) and publishes the run/passed/failed counts AND the F-4
 * wall-clock/USD totals as contracted blocks; the aggregate carries no bare
 * count.
 *
 * The `no_answer_leak` definition, pinned — both halves. CASE half: the case
 * record itself must contain none of the forbidden texts; step (a) proves that
 * before execution and refuses, naming the field (`$.task`, `$.setup.tools[1]`,
 * …). RUN half: with the executor's `finalAnswer` in hand, that string must
 * not contain any of the forbidden texts; the first match in list order fails
 * the assertion, naming the text. The injected executor reports
 * `{terminal, finalAnswer, toolCalls?}` plus the OPTIONAL numeric meters
 * `{usage?, provider?, model?, costUsd?}` — no transcript, tool results or
 * receipts — so the run half is exactly this finalAnswer check, stated rather
 * than implied. The meters are validated numbers, never leaked answer text.
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

import type { RunExit, TerminalState, Usage } from "../contracts";
import { notifyLearnEvalCompleted } from "./learn-events";
import { metricContract } from "./metrics";
import type { PostmortemRecord } from "./postmortem";
import { enrichUsageCost, HARNESS_PRICE_TABLE_REVISION } from "./usage-cost";

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

/**
 * One assertion a case makes about a run. The first two are the original
 * reduced-slice kinds; `max_wall_ms` / `max_cost_usd` are the F-4 opt-in
 * resource thresholds. Adding a kind here does not silently skip it: the
 * runner's `gradeAssertions` fails any kind it does not recognise.
 */
export type EvalAssertion =
  | { kind: "terminal"; value: TerminalState }
  | { kind: "no_answer_leak" }
  | { kind: "max_wall_ms"; value: number }
  | { kind: "max_cost_usd"; value: number };

/**
 * Where a case's USD number came from. `none` means the executor reported
 * neither a cost nor any usage — the case is counted as exactly $0, never as a
 * fabricated estimate. `harness-estimate` means the number was derived from
 * provider-reported usage via `usage-cost.ts` (harness price table, not a
 * billing invoice). `reported` means the executor supplied the USD directly.
 */
export type EvalCostSource = "none" | "harness-estimate" | "reported";

/** Resource metrics captured for one graded case (always present, F-4). */
export interface EvalRunMetrics {
  /** Wall-clock milliseconds around the single injected executor call. */
  wallMs: number;
  /** USD for the case. 0 when the executor reported no cost and no usage. */
  costUsd: number;
  /** Honest source of `costUsd`; see `EvalCostSource`. */
  costSource: EvalCostSource;
  /** Harness price-table revision when `costSource === "harness-estimate"`. */
  priceTableRevision?: typeof HARNESS_PRICE_TABLE_REVISION;
  /** Provider usage exactly as the executor reported it, when it did. */
  usage?: Usage;
}

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
  /**
   * Additional opt-in assertions (e.g. `max_wall_ms` / `max_cost_usd`) appended
   * AFTER the two default assertions. A post-mortem-derived case can therefore
   * carry resource thresholds without the builder inventing a measurement.
   */
  assertions?: readonly EvalAssertion[];
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
    assertions: [
      { kind: "terminal", value: pm.terminal },
      { kind: "no_answer_leak" },
      ...(opts.assertions ?? []),
    ],
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
  /** Provider-reported usage for the case, when the executor can report it. */
  usage?: Usage;
  /** Provider/model names, used only to pick the harness price table. */
  provider?: string;
  model?: string;
  /**
   * An already-computed USD cost, when the provider/harness reports one
   * directly. Takes precedence over `usage`; when neither is present the runner
   * records $0 with `costSource: "none"` (it never fabricates a number).
   */
  costUsd?: number;
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
  /**
   * F-4 suite-wide caps (additive, opt-in). When absent, no suite gate is
   * applied. A breach is a `suite_wall_ms` / `suite_cost_usd` failure on the
   * aggregate with PASS/FAIL evidence — never a silently skipped check.
   */
  maxSuiteWallMs?: number;
  maxSuiteCostUsd?: number;
}

/** Why a run failed; the closed set of failure kinds the runner produces. */
export type EvalFailureKind =
  | "terminal"
  | "no_answer_leak"
  | "executor_error"
  | "unknown_assertion"
  | "max_wall_ms"
  | "max_cost_usd"
  | "suite_wall_ms"
  | "suite_cost_usd";

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
  /** Captured cost/latency metrics — present on every result, even errors. */
  metrics: EvalRunMetrics;
}

/** The set aggregate: published numbers only (H-7). */
export interface EvalSetRunAggregate {
  /**
   * One contracted block per count (Metric/Anchor/Population/Excludes): the
   * aggregate carries no bare count — a caller that needs one counts
   * `results`, and a number that leaves here without its four slots cannot be
   * produced. F-4 appends wall-clock and USD blocks here, same contract.
   */
  published: string[];
  /**
   * Suite-wide gate failures (F-4). Empty when no suite caps were supplied or
   * every cap was met; a breach carries explicit expected/observed evidence.
   */
  suiteFailures: EvalFailure[];
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

/** A finite, non-negative number — the shape every resource cap and USD value needs. */
function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** The normalised executor observation, including the optional F-4 meters. */
interface NormalizedExecutor {
  outcome: EvalRunOutcome;
  usage?: Usage;
  costUsd?: number;
  provider?: string;
  model?: string;
}

/**
 * Normalise an executor return value; a malformed result is refused the same
 * way a throw is — as a graded `executor_error`, never a comparison. There is
 * no honest terminal to compare and no text to scan. The optional cost fields
 * are validated too: a bad usage/cost shape is malformed, not silently dropped.
 */
function normalizeExecutorResult(raw: unknown): { ok: NormalizedExecutor } | { malformed: string } {
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
  if (result.usage !== undefined) {
    if (result.usage === null || typeof result.usage !== "object" || Array.isArray(result.usage)) {
      return { malformed: "the executor returned usage that is not an object" };
    }
    for (const value of Object.values(result.usage as Record<string, unknown>)) {
      if (value !== undefined && !isNonNegativeNumber(value)) {
        return { malformed: "the executor returned usage with a non-numeric token field" };
      }
    }
  }
  if (result.costUsd !== undefined && !isNonNegativeNumber(result.costUsd)) {
    return { malformed: "the executor returned costUsd that is not a finite non-negative number" };
  }
  if (result.provider !== undefined && typeof result.provider !== "string") {
    return { malformed: "the executor returned provider that is not a string" };
  }
  if (result.model !== undefined && typeof result.model !== "string") {
    return { malformed: "the executor returned model that is not a string" };
  }
  return {
    ok: {
      outcome: {
        terminal: result.terminal as TerminalState,
        finalAnswer: result.finalAnswer,
        toolCalls: [...(toolCalls ?? [])],
      },
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      ...(result.provider !== undefined ? { provider: result.provider } : {}),
      ...(result.model !== undefined ? { model: result.model } : {}),
    },
  };
}

/**
 * Build the metrics record from a normalised observation. Honesty is the rule:
 * an explicit `costUsd` is `reported`; usage alone is a `harness-estimate`
 * through `usage-cost.ts`; neither is exactly $0 with source `none`.
 */
function metricsFrom(observed: NormalizedExecutor, wallMs: number): EvalRunMetrics {
  const base: EvalRunMetrics = { wallMs, costUsd: 0, costSource: "none" };
  if (observed.costUsd !== undefined) {
    return {
      ...base,
      costUsd: observed.costUsd,
      costSource: "reported",
      ...(observed.usage !== undefined ? { usage: observed.usage } : {}),
    };
  }
  if (observed.usage !== undefined) {
    const enriched = enrichUsageCost(observed.usage, observed.provider ?? "unknown", observed.model ?? "unknown");
    return {
      ...base,
      costUsd: enriched.cost?.totalUsd ?? 0,
      costSource: "harness-estimate",
      priceTableRevision: HARNESS_PRICE_TABLE_REVISION,
      usage: observed.usage,
    };
  }
  return base;
}

/** Metrics for the no-observation case: wall time to the failure, $0, source `none`. */
function errorMetrics(wallMs: number): EvalRunMetrics {
  return { wallMs, costUsd: 0, costSource: "none" };
}

/** The graded shape of "the executor produced no run": one failure, errored outcome. */
function executorErrorResult(caseId: string, message: string, metrics: EvalRunMetrics): EvalRunResult {
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
    metrics,
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
  metrics: EvalRunMetrics,
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
    if (assertion?.kind === "max_wall_ms") {
      const cap = assertion.value;
      if (!isNonNegativeNumber(cap)) {
        failures.push({
          kind: "unknown_assertion",
          observed: String(cap),
          detail: `assertions[${index}] (max_wall_ms) needs a finite non-negative number — ${JSON.stringify(cap)} is not one; refusing rather than skipping`,
        });
      } else if (metrics.wallMs > cap) {
        failures.push({
          kind: "max_wall_ms",
          expected: `<= ${cap}ms`,
          observed: `${metrics.wallMs}ms`,
          detail: `max_wall_ms assertion failed: observed ${metrics.wallMs}ms exceeds ${cap}ms (wall clock measured around the executor call)`,
        });
      }
      return;
    }
    if (assertion?.kind === "max_cost_usd") {
      const cap = assertion.value;
      if (!isNonNegativeNumber(cap)) {
        failures.push({
          kind: "unknown_assertion",
          observed: String(cap),
          detail: `assertions[${index}] (max_cost_usd) needs a finite non-negative number — ${JSON.stringify(cap)} is not one; refusing rather than skipping`,
        });
      } else if (metrics.costUsd > cap) {
        failures.push({
          kind: "max_cost_usd",
          expected: `<= ${displayUsd(cap)}`,
          observed: `${displayUsd(metrics.costUsd)} (${metrics.costSource})`,
          detail: `max_cost_usd assertion failed: observed ${displayUsd(metrics.costUsd)} (source ${metrics.costSource}) exceeds ${displayUsd(cap)}`,
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
 * Dependency-injected: no I/O, no provider call, no loop run, no randomness.
 * The ONE clock read is the wall-clock measurement around the injected
 * executor call (F-4) — everything graded off that measurement is still
 * deterministic for a given executor. Order is the contract: (a) the
 * answer-isolation precondition is re-asserted against the case BEFORE the
 * executor is called (a leak refuses, typed, naming the field); (b) the
 * executor is awaited inside try/catch — a throw or a malformed result becomes
 * a graded `executor_error` result, never a rejection; (c) every assertion is
 * graded, including the opt-in resource thresholds; (d) the typed result with
 * its captured metrics is returned.
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
  // The clock is read once, immediately around the call, so wallMs is the
  // duration of the execution regardless of how the execution ended.
  const started = Date.now();
  let normalized: ReturnType<typeof normalizeExecutorResult>;
  try {
    normalized = normalizeExecutorResult(await executor(evalCase));
  } catch (err) {
    return executorErrorResult(evalCase.id, `the executor threw: ${errorMessage(err)}`, errorMetrics(Date.now() - started));
  }
  const wallMs = Date.now() - started;
  if ("malformed" in normalized) {
    return executorErrorResult(
      evalCase.id,
      `the executor returned a malformed result: ${normalized.malformed}`,
      errorMetrics(wallMs),
    );
  }
  const metrics = metricsFrom(normalized.ok, wallMs);

  // (c) Grade every assertion the case carries, against the observation AND
  // the captured resource metrics.
  const failures = gradeAssertions(evalCase, normalized.ok.outcome, metrics, forbidden);

  // (d) The typed result.
  return { caseId: evalCase.id, passed: failures.length === 0, failures, outcome: normalized.ok.outcome, metrics };
}

/** Round a wall-clock total for display without changing what was measured. */
function displayMs(value: number): string {
  return `${Math.round(value)}ms`;
}

/** Six-decimal USD display; $0 is $0, never an invented estimate. */
function displayUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

/** Suite caps are programming input — validate them before any execution. */
function validateSuiteCaps(opts: EvalRunnerOptions): void {
  for (const [key, value] of [
    ["maxSuiteWallMs", opts.maxSuiteWallMs],
    ["maxSuiteCostUsd", opts.maxSuiteCostUsd],
  ] as const) {
    if (value !== undefined && !isNonNegativeNumber(value)) {
      throw new Error(`runEvalSet: opts.${key} must be a finite non-negative number — ${JSON.stringify(value)} is not one`);
    }
  }
}

/** One explicit suite-gate failure with PASS/FAIL evidence. */
function suiteGateFailure(kind: "suite_wall_ms" | "suite_cost_usd", cap: number, observed: number, unit: "ms" | "usd"): EvalFailure {
  const fmt = unit === "ms" ? displayMs : displayUsd;
  return {
    kind,
    expected: `<= ${fmt(cap)}`,
    observed: fmt(observed),
    detail: `suite ${kind} gate failed: ${fmt(observed)} total exceeds ${fmt(cap)}`,
  };
}

/**
 * Run a whole set: every case is checked against the answer side BEFORE the
 * set's first execution (a leak anywhere refuses the whole set — nothing has
 * run), then each case goes through `runEvalCase`. The aggregate publishes the
 * run/passed/failed counts AND the F-4 wall-clock/USD totals as contracted
 * blocks (H-7) and carries no bare count: a caller that needs one counts
 * `results` or reads `results[i].metrics`.
 *
 * Determinism mirrors `runEvalCase`: no I/O, no provider call, no loop run, no
 * randomness; the only clock reads are the per-case wall-clock measurements.
 */
export async function runEvalSet(
  cases: readonly PostmortemEvalCase[],
  opts: EvalRunnerOptions,
): Promise<EvalSetRun> {
  if (!Array.isArray(cases)) throw new Error("runEvalSet: cases must be an array");
  const executor = requireExecutor(opts, "runEvalSet");
  validateSuiteCaps(opts);
  // A refusal anywhere refuses the set before ANY execution.
  cases.forEach((c, index) => requireRunnableCase(c, `runEvalSet: cases[${index}]`));
  for (const c of cases) assertAnswerIsolation(c, opts.forbiddenTexts);

  const results: EvalRunResult[] = [];
  for (const c of cases) results.push(await runEvalCase(c, { executor, forbiddenTexts: opts.forbiddenTexts }));

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;

  // F-4 resource totals, derived strictly from captured per-case metrics.
  const totalWallMs = results.reduce((sum, r) => sum + r.metrics.wallMs, 0);
  const maxWallMs = results.reduce((max, r) => Math.max(max, r.metrics.wallMs), 0);
  const totalCostUsd = results.reduce((sum, r) => sum + r.metrics.costUsd, 0);
  const maxCostUsd = results.reduce((max, r) => Math.max(max, r.metrics.costUsd), 0);
  const withCostData = results.filter((r) => r.metrics.costSource !== "none").length;

  const suiteFailures: EvalFailure[] = [];
  if (opts.maxSuiteWallMs !== undefined && totalWallMs > opts.maxSuiteWallMs) {
    suiteFailures.push(suiteGateFailure("suite_wall_ms", opts.maxSuiteWallMs, totalWallMs, "ms"));
  }
  if (opts.maxSuiteCostUsd !== undefined && totalCostUsd > opts.maxSuiteCostUsd) {
    suiteFailures.push(suiteGateFailure("suite_cost_usd", opts.maxSuiteCostUsd, totalCostUsd, "usd"));
  }

  const population = `${results.length} eval case(s) run through the injected executor (core/evals.ts runEvalSet; the executor is caller-supplied — no loop or provider wiring)`;
  const anchor = "none — first eval run in this repository (no prior run of this set to compare against)";
  const excludes =
    "none — every case in the set produced a graded result (a case-side refusal refuses the whole set before its first execution; an executor throw is graded as executor_error)";
  const resourcePopulation =
    `${population}; ${withCostData}/${results.length} case(s) reported cost or usage, the rest counted at $0 with source 'none'`;
  const resourceExcludes =
    `${excludes}; executor-error cases contribute wall time to the throw and $0 cost (no usage was reported)`;
  const published = [
    metricContract({ metric: "eval cases run", anchor, population, excludes, value: results.length }),
    metricContract({ metric: "eval cases passed", anchor, population, excludes, value: passed }),
    metricContract({ metric: "eval cases failed", anchor, population, excludes, value: failed }),
    metricContract({
      metric: "eval wall-clock (milliseconds)",
      anchor,
      population,
      excludes,
      value: `${displayMs(totalWallMs)} total / ${displayMs(maxWallMs)} max case`,
    }),
    metricContract({
      metric: "eval cost (USD, harness estimate where derived from usage)",
      anchor,
      population: resourcePopulation,
      excludes: resourceExcludes,
      value: `${displayUsd(totalCostUsd)} total / ${displayUsd(maxCostUsd)} max case`,
    }),
  ];

  // RC-18: notify learn listeners so a live Runtime can project hz.learn.eval.completed (451).
  notifyLearnEvalCompleted({
    evalId: `eval-set-${results.length}-${passed}-${failed}`,
    caseCount: results.length,
    passed,
    failed,
    gate: failed === 0 && suiteFailures.length === 0 ? "pass" : "fail",
  });

  return { results, aggregate: { published, suiteFailures } };
}
