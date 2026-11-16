import { describe, expect, test } from "bun:test";
import {
  benchGroundTruthPublication,
  buildIndexedEvalCases,
  gradeIndexedAnswer,
  stimulusFromIndex,
} from "../../src/core/bench-ground-truth";
import { assertPublishedNumber, parsePublishedNumber } from "../../src/core/metrics";

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

  test("ruling 510: every published bench number is a contracted block", () => {
    const blocks = [
      ...benchGroundTruthPublication(),
      ...stimulusFromIndex(3).published,
      ...buildIndexedEvalCases(2).flatMap((c) => c.published),
    ];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) assertPublishedNumber(block);
    // No runner/population data exists in this module, so the population slot
    // is honestly "unknown" rather than fabricated.
    const parsed = parsePublishedNumber(benchGroundTruthPublication()[0]!);
    expect(parsed.metric).toBe("bench stimulus version");
    expect(parsed.population).toContain("unknown");
  });
});
