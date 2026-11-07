/**
 * evals.ts — eval cases built from post-mortems, with an enforced
 * answer-isolation precondition (docs/30 §4 item 8, reduced form).
 *
 * Three things live here and nothing else:
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
 *
 * Refusals are typed (`EvalCaseRefusal`) and carry a machine-readable `code`;
 * the four codes and their exact message prefixes are: `no_task`, `bad_source`,
 * `answer_leak`, `bad_forbidden` (the strings are pinned in
 * `tests/core/postmortems-evals.test.ts`).
 *
 * Not in this slice, named: no eval RUNNER exists (cases are data; replaying a
 * trajectory and grading assertions belongs to the eval harness), there is no
 * live wiring into the loop, and docs/30 §4 item 8's test-model-in-library is
 * not here. The answer-isolation precondition here is the string-level half
 * (Reasonix `answer_isolation.go`'s OS read sandbox is the other half, docs/29
 * C-27): a case whose task *is* the answer has nothing to leak and still must
 * not be run.
 */

import type { TerminalState } from "../contracts";
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

  const population = `${cases.length} post-mortem-derived eval case(s) in this set (local candidate form, core/evals.ts; no runner exists in this slice)`;
  const anchor = "none — first measurement (no prior eval set or run to compare against)";
  const excludes =
    "eval runs and their outcomes — no runner exists in this slice, so these are case-population numbers, not results";
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
