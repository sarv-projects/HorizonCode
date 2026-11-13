import { describe, expect, test } from "bun:test";
import { renderLearningGraphAscii } from "../../src/core/learning-graph";
import type { StoredProposalRow } from "../../src/core/curator";
import { REVIEW_FORK_ORIGIN } from "../../src/core/review";

function row(partial: Partial<StoredProposalRow> & Pick<StoredProposalRow, "title" | "digest">): StoredProposalRow {
  return {
    schemaVersion: 1,
    kind: "memory",
    title: partial.title,
    body: "b",
    evidence: [],
    reads: [],
    digest: partial.digest,
    origin: REVIEW_FORK_ORIGIN,
    createdAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

describe("renderLearningGraphAscii", () => {
  test("empty store", () => {
    expect(renderLearningGraphAscii([])).toContain("no curator proposals");
  });

  test("chains nodes with ascii edges", () => {
    const text = renderLearningGraphAscii([
      row({ title: "first", digest: "a".repeat(64) }),
      row({ title: "second", digest: "b".repeat(64) }),
    ]);
    expect(text).toContain("|");
    expect(text).toContain("v");
    expect(text).toContain("first");
    expect(text).toContain("2 proposal");
  });
});
