import { describe, expect, test } from "bun:test";
import {
  appendAttributionToMessage,
  commitAttributionTrailers,
  parseCommitAttributeArgs,
} from "../../src/core/commit-attribution";

describe("commit attribution", () => {
  test("parseCommitAttributeArgs strips flags", () => {
    const { attribution, rest } = parseCommitAttributeArgs([
      "--preview",
      "--attribute-coauthor",
      "Bot <bot@example.com>",
      "extra",
    ]);
    expect(attribution.coauthor).toBe("Bot <bot@example.com>");
    expect(rest).toEqual(["--preview", "extra"]);
  });

  test("trailers follow documented table", () => {
    expect(
      commitAttributionTrailers({
        coauthor: "A",
        signedOffBy: "B",
      }),
    ).toEqual(["Co-authored-by: A", "Signed-off-by: B"]);
    expect(appendAttributionToMessage("subject", { reviewedBy: "C" })).toBe("subject\n\nReviewed-by: C");
  });
});
