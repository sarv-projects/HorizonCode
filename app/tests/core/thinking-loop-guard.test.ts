/**
 * thinking-loop-guard.test.ts — port of oh-my-pi semantic thinking-loop
 * detectors (must-steal #13): word-trigram Jaccard near-duplicate clustering
 * + progress-lexicon stall with concrete-anchor reset.
 */
import { describe, expect, test } from "bun:test";
import {
  detectNearDuplicateSegments,
  detectProgressLexiconStall,
  wordTrigrams,
} from "../../src/core/guards/thinking-loop-guard";

describe("semantic thinking-loop guard (oh-my-pi port)", () => {
  test("word trigrams are order-sensitive and whitespace-normalized", () => {
    const a = wordTrigrams("alpha beta gamma delta");
    const b = wordTrigrams("alpha  beta\ngamma delta");
    expect(a).toEqual(b);
    expect(wordTrigrams("alpha beta gamma")).not.toEqual(wordTrigrams("beta alpha gamma"));
  });

  test("near-duplicate paragraph clusters trip at 4 similar segments", () => {
    const base =
      "Confirming the current safety properties of the implementation before we proceed with further verification steps and then carefully recheck every single one of the remaining outstanding concerns one final time";
    const paragraphs = [
      base,
      base.replace("final time", "final pass"),
      base.replace("final time", "final round"),
      base.replace("final time", "final check"),
      base.replace("final time", "final step"),
      base.replace("final time", "final look"),
      base.replace("final time", "final review"),
      base.replace("final time", "final audit"),
      base.replace("final time", "final scan"),
      "Completely unrelated content about a different subject with distinct vocabulary and structure",
    ];
    expect(detectNearDuplicateSegments(paragraphs)).toBe(true);
  });

  test("distinct paragraphs do not trip the near-duplicate detector", () => {
    const paragraphs = [
      "The parser tokenizes the input stream and preserves byte offsets for later analysis passes",
      "Database migrations create a new table with an index on the aggregate identifier column",
      "The cache layer implements an LRU eviction policy with a bounded sixty four entry capacity",
      "Network retries use exponential backoff with jitter and respect the server provided retry after header",
    ];
    expect(detectNearDuplicateSegments(paragraphs)).toBe(false);
  });

  test("progress-lexicon stall trips on reworded filler naming nothing concrete", () => {
    const filler = [
      "just doing it and pushing ahead while maintaining steady momentum in the work",
      "pushing ahead with the work while just doing it and maintaining momentum steadily",
      "maintaining momentum and just doing it while steadily pushing ahead in the work",
      "just doing it while pushing ahead and maintaining the momentum of the work steadily",
      "pushing ahead and maintaining momentum while just doing it in the ongoing work",
      "maintaining steady momentum while just doing it and pushing ahead with the work",
      "just doing it and maintaining momentum while pushing ahead with the steady work",
      "pushing ahead while maintaining momentum and just doing it in the work steadily",
      "just doing it and pushing ahead while maintaining the momentum of the work steadily",
    ];
    expect(detectProgressLexiconStall(filler)).toBe(true);
  });

  test("a concrete anchor (file path / identifier) resets the stall run", () => {
    const filler = [
      "just doing it and pushing ahead while maintaining steady momentum in the work",
      "pushing ahead with the work while just doing it and maintaining momentum steadily",
      "now editing src/parser.ts to fix the parseToken function and preserve offsets",
      "maintaining momentum and just doing it while steadily pushing ahead in the work",
      "pushing ahead and maintaining momentum while just doing it in the ongoing work",
      "maintaining steady momentum while just doing it and pushing ahead with the work",
      "just doing it and maintaining momentum while pushing ahead with the steady work",
      "pushing ahead while maintaining momentum and just doing it in the work steadily",
    ];
    expect(detectProgressLexiconStall(filler)).toBe(false);
  });
});
