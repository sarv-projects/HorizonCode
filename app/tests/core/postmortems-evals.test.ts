/**
 * postmortems-evals.test.ts — post-mortems and evals from post-mortems
 * (docs/30 §4 item 8, reduced form; the answer-isolation precondition).
 *
 * What this pins, all recomputed independently with the frozen primitives of
 * `../../src/contracts.ts` where a digest is involved: the record round-trips
 * through its file; the transcript range and both digests mean exactly what the
 * module header says; a corrupt file is quarantined (renamed, `corrupt: true`)
 * and never read as an empty history; a case is built only from a post-mortem
 * that carries a task; the answer-isolation precondition refuses a leak at any
 * nesting depth and names the field; and the eval-set summary publishes its
 * numbers through the metric contract (all four slots, never a bare number).
 *
 * Not here, by design: no eval runner, no loop wiring, no test model.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { TerminalState } from "../../src/contracts";
import { canonicalJson, sha256Hex } from "../../src/contracts";
import {
  answerIsolationPrecondition,
  assertAnswerIsolation,
  EvalCaseRefusal,
  evalCaseFromPostmortem,
  summarizeEvalSet,
  type PostmortemEvalCase,
} from "../../src/core/evals";
import { metricContract } from "../../src/core/metrics";
import {
  failureSignatureDigest,
  loadPostmortems,
  postmortemPath,
  postmortemsDir,
  recordPostmortem,
  type FailureClass,
  type PostmortemRecord,
  type TranscriptEvent,
} from "../../src/core/postmortem";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(cleanupTemps);

const NOW = 1_760_000_000_000;
const TASK = "Fix the failing parser test";
const TRANSCRIPT: TranscriptEvent[] = [
  { seq: 1, role: "system", text: "system rail" },
  { seq: 2, role: "user", text: `${TASK}\nand keep the diff small` },
  { seq: 3, role: "assistant", text: "on it" },
];

/** The typed-refusal idiom: run it, insist on an EvalCaseRefusal, return it. */
function refusalOf(fn: () => unknown): EvalCaseRefusal {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EvalCaseRefusal);
    return err as EvalCaseRefusal;
  }
  throw new Error("expected an EvalCaseRefusal, but the call returned");
}

async function onePostmortem(stateDir: string, now = NOW): Promise<PostmortemRecord> {
  return recordPostmortem({
    stateDir,
    sessionId: "sess-1",
    terminal: "failed",
    detail: "provider_error",
    transcript: TRANSCRIPT,
    toolCalls: ["read", "edit", "read"],
    failureClass: "provider_error",
    now,
  });
}

/* ------------------------------ the record ------------------------------ */

describe("post-mortem records", () => {
  test("round-trip: record → <stateDir>/postmortems/<epochMillis>-<shortid>.json → load", async () => {
    const stateDir = tempDir("hz-pm-");
    const record = await onePostmortem(stateDir);

    expect(record.id).toMatch(/^\d+-[0-9a-f]{8}$/);
    expect(record.id.startsWith(`${NOW}-`)).toBe(true);
    expect(record.ts).toBe(new Date(NOW).toISOString());

    const file = postmortemPath(stateDir, record.id);
    expect(path.dirname(file)).toBe(postmortemsDir(stateDir));
    expect(existsSync(file)).toBe(true);

    // The on-disk shape is the record, exactly — no extra fields, no friends.
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(onDisk).sort()).toEqual([
      "detail",
      "failureClass",
      "failureDigest",
      "id",
      "sessionId",
      "task",
      "terminal",
      "toolCalls",
      "transcript",
      "ts",
    ]);
    expect(onDisk).toEqual(record);

    // Range and digests, recomputed from contracts.ts alone.
    expect(record.transcript).toEqual({
      firstSeq: 1,
      lastSeq: 3,
      count: 3,
      textDigest: sha256Hex(TRANSCRIPT.map((event) => event.text).join("\n")),
    });
    const signature = { terminal: "failed" as const, detail: "provider_error", failureClass: "provider_error" as const };
    expect(record.failureDigest).toBe(sha256Hex(canonicalJson(signature)));
    expect(failureSignatureDigest(signature)).toBe(record.failureDigest);
    expect(record.task).toBe(TASK);
    expect(record.toolCalls).toEqual({ edit: 1, read: 2 });

    const load = await loadPostmortems(stateDir);
    expect(load.corrupt).toBe(false);
    expect(load.quarantine).toEqual([]);
    expect(load.postmortems).toEqual([record]);
  });

  test("an opaque text transcript digests verbatim and has no range and no task", async () => {
    const stateDir = tempDir("hz-pm-opaque-");
    const record = await recordPostmortem({
      stateDir,
      sessionId: "sess-2",
      terminal: "budget_exhausted",
      transcript: "raw log text",
      failureClass: "budget",
      now: NOW,
    });
    expect(record.task).toBeNull();
    expect(record.detail).toBeNull();
    expect(record.transcript).toEqual({
      firstSeq: null,
      lastSeq: null,
      count: 1,
      textDigest: sha256Hex("raw log text"),
    });
    expect((await loadPostmortems(stateDir)).postmortems).toEqual([record]);
  });

  test("load sorts by ts and both tool-call input forms normalise to name → count", async () => {
    const stateDir = tempDir("hz-pm-order-");
    const late = await recordPostmortem({
      stateDir,
      sessionId: "sess-late",
      terminal: "failed",
      transcript: TRANSCRIPT,
      toolCalls: { shell: 3 },
      failureClass: "tool_error",
      now: NOW + 2_000,
    });
    const early = await recordPostmortem({
      stateDir,
      sessionId: "sess-early",
      terminal: "timeout",
      transcript: TRANSCRIPT,
      toolCalls: ["shell"],
      failureClass: "unknown",
      now: NOW + 1_000,
    });
    const load = await loadPostmortems(stateDir);
    expect(load.postmortems.map((pm) => pm.id)).toEqual([early.id, late.id]);
    expect(load.postmortems.map((pm) => pm.sessionId)).toEqual(["sess-early", "sess-late"]);
    expect(load.postmortems[0]?.toolCalls).toEqual({ shell: 1 });
    expect(load.postmortems[1]?.toolCalls).toEqual({ shell: 3 });
  });

  test("bad input refuses before anything is written", async () => {
    const stateDir = tempDir("hz-pm-bad-");
    const base = {
      stateDir,
      sessionId: "sess-1",
      terminal: "failed" as const,
      transcript: TRANSCRIPT,
      failureClass: "provider_error" as FailureClass,
      now: NOW,
    };
    await expect(recordPostmortem({ ...base, sessionId: "  " })).rejects.toThrow("sessionId is required");
    await expect(recordPostmortem({ ...base, terminal: "nope" as TerminalState })).rejects.toThrow(
      "terminal must be an RC-7 value",
    );
    await expect(recordPostmortem({ ...base, failureClass: "nope" as FailureClass })).rejects.toThrow(
      "failureClass must be one of",
    );
    await expect(recordPostmortem({ ...base, transcript: [{ seq: 0, role: "user", text: "x" }] })).rejects.toThrow(
      "seq must be a positive integer",
    );
    await expect(recordPostmortem({ ...base, toolCalls: { read: -1 } })).rejects.toThrow("non-negative integer");
    expect(existsSync(postmortemsDir(stateDir))).toBe(false);
  });
});

/* ------------------------------ quarantine ------------------------------ */

describe("corrupt post-mortem files quarantine", () => {
  test("a non-JSON file is renamed aside, marked corrupt, and the good records still load", async () => {
    const stateDir = tempDir("hz-pm-corrupt-");
    const good = await onePostmortem(stateDir);
    const junk = "1111111111111-deadbeef.json";
    writeFileSync(path.join(postmortemsDir(stateDir), junk), "this is not json at all\n", "utf8");

    const load = await loadPostmortems(stateDir);
    expect(load.corrupt).toBe(true);
    expect(load.postmortems).toEqual([good]); // never read as an empty history
    expect(load.quarantine.length).toBe(1);
    const entry = load.quarantine[0];
    expect(entry?.corrupt).toBe(true);
    expect(entry?.file).toBe(junk);
    expect(entry?.reason).toContain("not JSON");
    const quarantinedTo = entry?.quarantinedTo as string;
    expect(path.basename(quarantinedTo)).toMatch(/^1111111111111-deadbeef\.json\.corrupt-\d+$/);
    // The bytes are preserved for inspection — quarantined, never dropped.
    expect(readFileSync(quarantinedTo, "utf8")).toContain("not json at all");
    expect(existsSync(path.join(postmortemsDir(stateDir), junk))).toBe(false);

    // The refusal is not sticky: a quarantined file is not quarantined twice.
    const again = await loadPostmortems(stateDir);
    expect(again.corrupt).toBe(false);
    expect(again.postmortems).toEqual([good]);
  });

  test("a file that parses but is not a postmortem record also quarantines", async () => {
    const stateDir = tempDir("hz-pm-shape-");
    mkdirSync(postmortemsDir(stateDir), { recursive: true });
    writeFileSync(
      path.join(postmortemsDir(stateDir), "2222222222222-badf00d1.json"),
      JSON.stringify({ hello: 1 }),
      "utf8",
    );
    const load = await loadPostmortems(stateDir);
    expect(load.corrupt).toBe(true);
    expect(load.postmortems).toEqual([]);
    expect(load.quarantine[0]?.reason).toContain("not a postmortem record");
  });

  test("a missing directory is empty and healthy, never unreadable", async () => {
    const stateDir = tempDir("hz-pm-none-");
    expect(await loadPostmortems(stateDir)).toEqual({ postmortems: [], quarantine: [], corrupt: false });
  });
});

/* ---------------------------- the eval case ---------------------------- */

describe("evalCaseFromPostmortem", () => {
  test("extracts the task, the tools exercised and the two assertions", async () => {
    const stateDir = tempDir("hz-eval-");
    const pm = await onePostmortem(stateDir);
    const evalCase = evalCaseFromPostmortem(pm);
    expect(evalCase).toEqual({
      id: `eval-from-${pm.id}`,
      from: pm.id,
      task: TASK,
      setup: { tools: ["edit", "read"] },
      assertions: [
        { kind: "terminal", value: "failed" },
        { kind: "no_answer_leak" },
      ],
    });
    expect(evalCaseFromPostmortem(pm, { id: "local-42" }).id).toBe("local-42");
  });

  test("refuses when there is no task — typed, and never invented", async () => {
    const stateDir = tempDir("hz-eval-notask-");
    const noTask = await recordPostmortem({
      stateDir,
      sessionId: "sess-3",
      terminal: "failed",
      transcript: [{ seq: 1, role: "assistant", text: "nothing user-visible here" }],
      failureClass: "refusal",
      now: NOW,
    });
    expect(noTask.task).toBeNull();

    const err = refusalOf(() => evalCaseFromPostmortem(noTask));
    expect(err.code).toBe("no_task");
    expect(err.message).toContain("no_task");
    expect(err.message).toContain(noTask.id);

    const handBuilt = { ...noTask, id: "hand-1", task: null } as PostmortemRecord;
    expect(refusalOf(() => evalCaseFromPostmortem(handBuilt)).code).toBe("no_task");

    const noSource = { ...noTask, id: "  ", task: "x" } as PostmortemRecord;
    const sourceErr = refusalOf(() => evalCaseFromPostmortem(noSource));
    expect(sourceErr.code).toBe("bad_source");
    expect(sourceErr.message).toContain("bad_source");
  });
});

/* -------------------------- answer isolation -------------------------- */

describe("the answer-isolation precondition", () => {
  const ANSWER = "the final answer is 42";

  async function cleanCase(): Promise<PostmortemEvalCase> {
    const stateDir = tempDir("hz-eval-iso-");
    return evalCaseFromPostmortem(await onePostmortem(stateDir));
  }

  test("a clean case passes; the predicate agrees", async () => {
    const evalCase = await cleanCase();
    expect(() => assertAnswerIsolation(evalCase, [ANSWER])).not.toThrow();
    expect(answerIsolationPrecondition(evalCase, [ANSWER])).toBe(true);
  });

  test("a leak is refused at every depth, naming the field", async () => {
    const evalCase = await cleanCase();

    // Depth 1: a top-level string field.
    const depth1 = { ...evalCase, task: `prefix ${ANSWER} suffix` };
    const err1 = refusalOf(() => assertAnswerIsolation(depth1, [ANSWER]));
    expect(err1.code).toBe("answer_leak");
    expect(err1.field).toBe("$.task");
    expect(err1.message).toContain("answer_leak");
    expect(err1.message).toContain("$.task");
    expect(answerIsolationPrecondition(depth1, [ANSWER])).toBe(false);

    // Depth 2: an element of an array inside a nested object.
    const depth2 = { ...evalCase, setup: { tools: ["read", ANSWER] } };
    expect(refusalOf(() => assertAnswerIsolation(depth2, [ANSWER])).field).toBe("$.setup.tools[1]");
    expect(answerIsolationPrecondition(depth2, [ANSWER])).toBe(false);

    // Depth 3: an object inside an array inside an object.
    const depth3 = {
      ...evalCase,
      assertions: [{ kind: "terminal", value: ANSWER as TerminalState }, { kind: "no_answer_leak" }],
    };
    expect(refusalOf(() => assertAnswerIsolation(depth3, [ANSWER])).field).toBe("$.assertions[0].value");

    // Depth 4, and object keys are scanned too (a leak hidden as a name).
    expect(refusalOf(() => assertAnswerIsolation({ wrap: { inner: { text: ANSWER } } }, [ANSWER])).field).toBe(
      "$.wrap.inner.text",
    );
    expect(refusalOf(() => assertAnswerIsolation({ setup: { tools: { [ANSWER]: 1 } } }, [ANSWER])).field).toBe(
      `$.setup.tools["${ANSWER}"]`,
    );
  });

  test("an unusable forbidden list is a refusal, not a pass", async () => {
    const evalCase = await cleanCase();
    expect(refusalOf(() => assertAnswerIsolation(evalCase, [])).code).toBe("bad_forbidden");
    expect(refusalOf(() => assertAnswerIsolation(evalCase, ["  "])).code).toBe("bad_forbidden");
    expect(answerIsolationPrecondition(evalCase, [])).toBe(false);
    expect(answerIsolationPrecondition(evalCase, [" "])).toBe(false);
  });
});

/* ------------------------- the metric contract ------------------------- */

describe("summarizeEvalSet publishes through the metric contract", () => {
  test("every published number carries all four slots", async () => {
    const stateDir = tempDir("hz-eval-metrics-");
    const failed = await recordPostmortem({
      stateDir,
      sessionId: "sess-a",
      terminal: "failed",
      transcript: TRANSCRIPT,
      toolCalls: ["read"],
      failureClass: "provider_error",
      now: NOW,
    });
    const budgeted = await recordPostmortem({
      stateDir,
      sessionId: "sess-b",
      terminal: "budget_exhausted",
      transcript: TRANSCRIPT,
      toolCalls: { shell: 2 },
      failureClass: "budget",
      now: NOW + 1_000,
    });
    const summary = summarizeEvalSet([evalCaseFromPostmortem(failed), evalCaseFromPostmortem(budgeted)]);

    expect(summary.cases).toBe(2);
    expect(summary.withNoAnswerLeakAssertion).toBe(2);
    expect(summary.terminals).toEqual({ budget_exhausted: 1, failed: 1 });
    expect(summary.tools).toEqual({ read: 1, shell: 1 });
    expect(summary.published.length).toBe(4);
    for (const block of summary.published) {
      for (const slot of ["metric:", "anchor:", "population:", "excludes:", "value:"]) {
        expect(block).toContain(slot);
      }
    }
    expect(summary.published[0]).toContain("value: 2");
    expect(summary.published[2]).toContain("value: budget_exhausted=1, failed=1");
    expect(summary.published[3]).toContain("value: 2 distinct / 2 entries");
  });

  test("an empty set still publishes zeroes with their slots", () => {
    const summary = summarizeEvalSet([]);
    expect(summary.cases).toBe(0);
    expect(summary.published.length).toBe(4);
    expect(summary.published[2]).toContain("value: none");
    expect(summary.published.every((block) => block.includes("metric: ") && block.includes("excludes: "))).toBe(true);
  });

  test("a number without the four slots cannot be published", () => {
    // Compile-time: Metric/Anchor/Population/Excludes are required by the
    // contract; the directive below fails a typecheck if that ever loosens.
    // @ts-expect-error — the four slots are required (metrics.ts, H-7)
    expect(() => metricContract({ value: 3 })).toThrow("missing metric, anchor, population, excludes");
  });
});
