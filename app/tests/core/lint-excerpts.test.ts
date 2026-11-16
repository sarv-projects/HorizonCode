import { describe, expect, test } from "bun:test";
import {
  LINT_EXCERPT_MARK,
  lintErrorLinesFromFindings,
  lintErrorLinesFromMessages,
  renderMarkedLintExcerpt,
  withLintExcerpts,
} from "../../src/core/lint-excerpts";

describe("lint excerpts (F-1/F-3 reduced)", () => {
  const source = [
    "line1",
    "line2",
    "line3",
    "bad4",
    "line5",
    "line6",
    "line7",
    "bad8",
    "line9",
  ].join("\n");

  test("parse error lines from LSP-shaped messages", () => {
    expect(
      lintErrorLinesFromMessages([
        "src/a.ts:4:1 error boom",
        "src/a.ts:8:3 error again",
        "src/a.ts:4:9 error boom-dup",
        "src/a.ts:2:1 warning skip",
      ]),
    ).toEqual([4, 8]);
  });

  test("parse error lines from structured findings", () => {
    expect(lintErrorLinesFromFindings([{ line: 4 }, { line: 4 }, { line: 8 }])).toEqual([4, 8]);
  });

  test("marks offending lines with █ and merges overlapping windows", () => {
    const text = renderMarkedLintExcerpt(source, [4, 8], { context: 1 });
    expect(text).toContain("--- lint excerpt ---");
    expect(text).toContain(`${LINT_EXCERPT_MARK} 4|bad4`);
    expect(text).toContain(`${LINT_EXCERPT_MARK} 8|bad8`);
    expect(text).toContain("  3|line3");
    expect(text).toContain("  5|line5");
    // context=1 around 4 and 8 does not overlap → separator
    expect(text).toContain("⋯");
    expect(text).not.toContain("line1");
  });

  test("overlapping errors collapse into one window", () => {
    const text = renderMarkedLintExcerpt(source, [4, 5], { context: 1 });
    expect(text).toContain(`${LINT_EXCERPT_MARK} 4|bad4`);
    expect(text).toContain(`${LINT_EXCERPT_MARK} 5|line5`);
    expect(text).not.toContain("⋯");
  });

  test("empty error list yields empty excerpt", () => {
    expect(renderMarkedLintExcerpt(source, [])).toBe("");
    expect(withLintExcerpts("ok", source, [])).toBe("ok");
  });

  test("withLintExcerpts appends the block", () => {
    const out = withLintExcerpts("src/a.ts: 1 error(s)\nsrc/a.ts:4:1 error boom", source, [4]);
    expect(out.startsWith("src/a.ts: 1 error(s)")).toBe(true);
    expect(out).toContain("--- lint excerpt ---");
    expect(out).toContain(`${LINT_EXCERPT_MARK} 4|bad4`);
  });

  test("respects maxChars with a truncation marker", () => {
    const text = renderMarkedLintExcerpt(source, [4], { context: 3, maxChars: 80 });
    expect(text).toContain("… [lint excerpt truncated]");
  });
});
