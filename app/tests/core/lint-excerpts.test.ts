import { describe, expect, test } from "bun:test";
import {
  LINT_EXCERPT_MARK,
  LINT_EXCERPT_STRUCTURAL_MAX_SPAN,
  lintErrorLinesFromFindings,
  lintErrorLinesFromMessages,
  lintExcerptStructuralWindow,
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

  test("flat sources keep the plain ±context window (backward compatible)", () => {
    const plain = renderMarkedLintExcerpt(source, [4], { context: 1, structural: false });
    const structured = renderMarkedLintExcerpt(source, [4], { context: 1, structural: true });
    expect(structured).toBe(plain);
    expect(plain).not.toContain("line1");
  });
});

describe("lint excerpts - best-effort structural windows (no tree-sitter)", () => {
  test("widens to the enclosing balanced block (function signature included)", () => {
    const src = [
      "function foo() {",
      "  const a = 1;",
      "  const b = 2;",
      "  const c = 3;",
      "  const d = 4;",
      "  const e = 5;",
      "  bad();",
      "  return a;",
      "}",
      "const tail = 0;",
    ].join("\n");
    const structured = renderMarkedLintExcerpt(src, [7], { context: 3 });
    const plain = renderMarkedLintExcerpt(src, [7], { context: 3, structural: false });
    expect(structured).toContain("function foo() {");
    expect(plain).not.toContain("function foo() {");
    expect(structured).toMatch(/█\s+7\|\s*bad\(\);/);
  });

  test("dedent boundary groups an indented block without braces", () => {
    const src = [
      "root = 1",
      "  child = 2",
      "  child = 3",
      "  child = 4",
      "  child = 5",
      "  bad = 6",
      "  child = 7",
      "next = 8",
    ].join("\n");
    const structured = renderMarkedLintExcerpt(src, [6], { context: 3 });
    const plain = renderMarkedLintExcerpt(src, [6], { context: 3, structural: false });
    expect(structured).toContain("root = 1");
    expect(plain).not.toContain("root = 1");
  });

  test("ignores braces inside strings and comments", () => {
    const src = [
      "function f() {",
      "  const a = 1;",
      "  // { stray in comment",
      '  const s = "{";',
      "  bad();",
      "  const d = 4;",
      "}",
      "const after = 1;",
      "const after2 = 2;",
    ].join("\n");
    const text = renderMarkedLintExcerpt(src, [5], { context: 3 });
    expect(text).toContain("function f() {");
    // A stray comment/string brace would leave an unclosed open spanning to EOF.
    expect(text).not.toContain("const after2 = 2;");
  });

  test("caps a runaway block span", () => {
    const lines = ["function big() {"];
    for (let i = 0; i < 60; i++) lines.push(`  const v${i} = ${i};`);
    lines.push("  bad();");
    lines.push("}");
    const errorLine = 61;
    const w = lintExcerptStructuralWindow(lines, errorLine, { context: 3 });
    expect(w.start).toBeGreaterThan(1);
    expect(w.end - w.start + 1).toBeLessThanOrEqual(LINT_EXCERPT_STRUCTURAL_MAX_SPAN);
    expect(w.start).toBeLessThanOrEqual(errorLine);
    expect(w.end).toBeGreaterThanOrEqual(errorLine);
  });
});
