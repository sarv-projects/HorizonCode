import { describe, expect, test } from "bun:test";
import {
  buildIndexedEvalCases,
  gradeIndexedAnswer,
  stimulusFromIndex,
} from "../../src/core/bench-ground-truth";

describe("G-9 bench ground truth", () => {
  test("stimulus is stable and paraphrase-safe", () => {
    const a = stimulusFromIndex(7, "salt-a");
    const b = stimulusFromIndex(7, "salt-a");
    expect(a.expectedToken).toBe(b.expectedToken);
    expect(a.prompt).toContain("#7");
    expect(a.prompt).not.toContain(a.expectedToken);
  });

  test("indexed cases grade locally", () => {
    const cases = buildIndexedEvalCases(3);
    expect(cases[1]?.expectedToken).toBe(stimulusFromIndex(1).expectedToken);
    expect(gradeIndexedAnswer(cases[0]!.expectedToken, `done ${cases[0]!.expectedToken}`)).toBe(true);
  });
});
