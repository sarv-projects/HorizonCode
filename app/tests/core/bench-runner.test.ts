/** bench-runner.test.ts — G-9 product runner (index corpus → local grading). */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  buildIndexedEvalCasesFromCorpus,
  parseIndexedCorpusJsonl,
  stimulusFromIndex,
} from "../../src/core/bench-ground-truth";
import { casesFromCorpusJsonl, runIndexedBench } from "../../src/core/bench-runner";
import { assertPublishedNumber } from "../../src/core/metrics";
import { runEvalCli, type EvalCliIo } from "../../src/eval-run";

const FIXTURE = path.resolve(import.meta.dir, "../fixtures/bench-corpus.jsonl");

function capture(): { lines: string[]; errors: string[]; io: EvalCliIo } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, io: { out: (l) => lines.push(l), err: (l) => errors.push(l) } };
}

describe("index-derived corpus fixtures", () => {
  test("committed JSONL fixture parses into records and derives cases", () => {
    const text = readFileSync(FIXTURE, "utf8");
    const records = parseIndexedCorpusJsonl(text, FIXTURE);
    expect(records.map((r) => r.index)).toEqual([2, 7]);
    const cases = buildIndexedEvalCasesFromCorpus(records);
    expect(cases).toHaveLength(2);
    expect(cases[0]!.expectedToken).toBe(stimulusFromIndex(2).expectedToken);
    for (const c of cases) for (const block of c.published) assertPublishedNumber(block);
  });

  test("malformed corpus fails closed", () => {
    expect(() => parseIndexedCorpusJsonl("{not json")).toThrow(/not valid JSON/);
    expect(() => parseIndexedCorpusJsonl('{"index": -1}')).toThrow(/non-negative integer/);
    expect(() => parseIndexedCorpusJsonl("   ")).toThrow(/empty/);
    expect(() => parseIndexedCorpusJsonl('{"index": 1, "salt": 9}')).toThrow(/salt/);
  });
});

describe("runIndexedBench (injected executor, local grading)", () => {
  test("grades locally with an executor that returns the derived token", async () => {
    const cases = casesFromCorpusJsonl(readFileSync(FIXTURE, "utf8"), FIXTURE);
    const run = await runIndexedBench(cases, async () => ({ terminal: "succeeded", finalAnswer: "answer" }), {
      now: (() => { let t = 0; return () => (t += 1); })(),
    });
    // A wrong answer fails locally; expected tokens are never fabricated.
    expect(run.failed).toBe(2);
    for (const block of run.published) assertPublishedNumber(block);
  });

  test("passes when the executor emits the expected token", async () => {
    const cases = casesFromCorpusJsonl(readFileSync(FIXTURE, "utf8"), FIXTURE);
    const run = await runIndexedBench(
      cases,
      async (c) => {
        // The expected token is the case's ground truth; a scripted model that
        // "computed" it can echo it. Grading is still done locally by the runner.
        const expected = cases.find((x) => x.id === c.id)?.expectedToken ?? "";
        return { terminal: "succeeded", finalAnswer: `gt: ${expected}` };
      },
      { now: () => 0 },
    );
    expect(run.passed).toBe(2);
    expect(run.failed).toBe(0);
  });

  test("an executor throw is graded as a failed case, never skipped", async () => {
    const cases = casesFromCorpusJsonl('{"index": 1}', "inline");
    const run = await runIndexedBench(cases, async () => { throw new Error("boom"); }, { now: () => 0 });
    expect(run.results[0]!.terminal).toBe("failed");
    expect(run.results[0]!.passed).toBe(false);
    expect(run.results[0]!.reason).toContain("boom");
  });
});

describe("--bench-corpus CLI path", () => {
  test("loads the fixture corpus and grades locally (honest FAIL with mock)", async () => {
    const c = capture();
    const code = await runEvalCli(["--bench-corpus", FIXTURE], c.io);
    expect(code).toBe(1);
    const text = c.lines.join("\n");
    expect(text).toContain("indexed bench: 2 case(s)");
    expect(text).toContain("bench-corp-0-2");
    expect(text).toContain("indexed bench cases passed / failed");
  }, 30000);

  test("a malformed corpus is a refusal (exit 2)", async () => {
    const dir = path.dirname(FIXTURE);
    const bad = path.join(dir, "bench-bad-inline.jsonl");
    const { writeFileSync, rmSync } = await import("node:fs");
    writeFileSync(bad, "{bad", "utf8");
    try {
      const c = capture();
      const code = await runEvalCli(["--bench-corpus", bad], c.io);
      expect(code).toBe(2);
      expect(c.errors.join("\n")).toContain("bench corpus refused");
    } finally {
      rmSync(bad, { force: true });
    }
  });
});
