import { describe, expect, test } from "bun:test";
import {
  LINT_OUTPUT_MAX_FINDINGS,
  lintCatchAllDiagnostic,
  parseLintConfig,
  parseLintOutputLines,
  resolveLintCommand,
  shellQuotePath,
  substituteLintFile,
} from "../../src/core/lint-commands";

describe("F-3 lint commands", () => {
  test("parse + resolve by extension with catch-all", () => {
    const cfg = parseLintConfig({
      commands: [
        { extensions: ["ts"], command: "eslint {file}" },
        { extensions: ["*"], command: "echo {file}" },
      ],
    });
    expect(cfg?.commands.length).toBe(2);
    expect(cfg?.rejected).toEqual([]);
    expect(resolveLintCommand("/w/foo.ts", cfg)?.command).toBe("eslint {file}");
    expect(resolveLintCommand("/w/foo.py", cfg)?.command).toBe("echo {file}");
  });

  test("substitute and parse filename:line", () => {
    const cmd = substituteLintFile("echo {file}", "/w/a.ts");
    // POSIX single-quote keeps the path one inert shell word.
    expect(cmd).toBe("echo '/w/a.ts'");
    const rows = parseLintOutputLines("src/a.ts:3:1 error: bad\nnoise");
    expect(rows.length).toBe(1);
    expect(rows[0]?.line).toBe(3);
    expect(rows[0]?.col).toBe(1);
    expect(rows[0]?.message).toBe("error: bad");
  });

  test("catch-all diagnostic: 0 or 1 is fine, many are reported", () => {
    expect(lintCatchAllDiagnostic([])).toBeUndefined();
    expect(
      lintCatchAllDiagnostic([{ extensions: ["*"], command: "x {file}" }]),
    ).toBeUndefined();
    const many = lintCatchAllDiagnostic([
      { extensions: ["*"], command: "a {file}" },
      { extensions: ["ts"], command: "b {file}" },
      { extensions: ["*"], command: "c {file}" },
      { extensions: ["*"], command: "d {file}" },
    ]);
    expect(many).toContain("3 catch-all");
    expect(many).toContain("indices 0, 2, 3");
    expect(many).toContain("last one (index 3)");

    const cfg = parseLintConfig({
      commands: [
        { extensions: ["*"], command: "a {file}" },
        { extensions: ["*"], command: "b {file}" },
      ],
    });
    expect(cfg?.rejected.some((r) => r.includes("catch-all"))).toBe(true);
  });

  test("catch-all selection is deterministic: last wins, specific beats catch-all", () => {
    const cfg = parseLintConfig({
      commands: [
        { extensions: ["*"], command: "first {file}" },
        { extensions: ["*"], command: "last {file}" },
        { extensions: ["py"], command: "python-lint {file}" },
      ],
    });
    expect(resolveLintCommand("/w/unknown.xyz", cfg)?.command).toBe("last {file}");
    expect(resolveLintCommand("/w/foo.py", cfg)?.command).toBe("python-lint {file}");
  });

  test("{file} substitution is shell-inert: spaces, $, backticks and quotes", () => {
    expect(substituteLintFile("lint {file}", "/w/a b.ts")).toBe("lint '/w/a b.ts'");
    expect(substituteLintFile("lint {file}", "/w/a$(touch pwned).ts")).toBe(
      "lint '/w/a$(touch pwned).ts'",
    );
    expect(substituteLintFile("lint {file}", "/w/a`id`.ts")).toBe("lint '/w/a`id`.ts'");
    expect(shellQuotePath("it's.ts")).toBe("'it'\\''s.ts'");
    expect(substituteLintFile("lint {file}", "it's.ts")).toBe("lint 'it'\\''s.ts'");
    // No double quotes: nothing inside the substituted word is expanded by /bin/sh.
    expect(substituteLintFile("lint {file}", "/w/a b.ts")).not.toContain('"');
  });

  test("parse Windows drive paths", () => {
    const rows = parseLintOutputLines("C:\\src\\app\\a.ts:12:7 error broken");
    expect(rows.length).toBe(1);
    expect(rows[0]?.path).toBe("C:\\src\\app\\a.ts");
    expect(rows[0]?.line).toBe(12);
    expect(rows[0]?.col).toBe(7);
    expect(rows[0]?.message).toBe("error broken");
  });

  test("parse multiple findings on one line", () => {
    const rows = parseLintOutputLines(
      "a.ts:3:1 error one; b.ts:5:2 error two src/c.ts:7 error three",
    );
    expect(rows.map((r) => [r.path, r.line, r.col])).toEqual([
      ["a.ts", 3, 1],
      ["b.ts", 5, 2],
      ["src/c.ts", 7, undefined],
    ]);
    expect(rows[0]?.message).toBe("error one");
    expect(rows[1]?.message).toBe("error two");
    expect(rows[2]?.message).toBe("error three");
  });

  test("a non-path token with :digits inside a message is not a new finding", () => {
    const rows = parseLintOutputLines("a.ts:3:1 see line:7 for detail");
    expect(rows.length).toBe(1);
    expect(rows[0]?.message).toBe("see line:7 for detail");
  });

  test("strips ANSI colour codes and caps findings", () => {
    const rows = parseLintOutputLines("\u001b[31ma.ts:3:1 error red\u001b[0m");
    expect(rows.length).toBe(1);
    expect(rows[0]?.message).toBe("error red");

    const many = Array.from({ length: 10 }, (_, i) => `a.ts:${i + 1}:1 error e${i}`).join("\n");
    expect(parseLintOutputLines(many).length).toBe(10);
    expect(parseLintOutputLines(many, { maxFindings: 2 }).length).toBe(2);
    const cap = parseLintOutputLines(many, { maxFindings: LINT_OUTPUT_MAX_FINDINGS });
    expect(cap.length).toBe(10);
  });
});
