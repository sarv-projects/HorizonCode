/**
 * output-minimizer.test.ts — declarative shell-output minimizer filters
 * (oh-my-pi pi-shell minimizer defs ADAPT). Pure data-driven line/ANSI/row caps.
 */
import { describe, expect, test } from "bun:test";
import {
  minimiseOutput,
  OutputMinimizer,
  type MinimizerFilter,
} from "../../src/core/output-minimizer";

const FILTERS: MinimizerFilter[] = [
  { id: "df", match: /^df$/, stripAnsi: true, truncateLinesAt: 80, maxLines: 20 },
  { id: "npm-install", match: /^npm (?:install|i)$/, stripAnsi: false, maxLines: 10 },
];

const mini = new OutputMinimizer(FILTERS);

describe("declarative output minimizer", () => {
  test("unmatched commands pass through byte-identical", () => {
    const out = "unchanged\noutput\n";
    expect(minimiseOutput("echo", out, FILTERS)).toBe(out);
    expect(mini.applied("echo", out)).toBe(false);
  });

  test("df filter strips ANSI, truncates wide lines and caps rows", () => {
    const wide = "a".repeat(120);
    const ansi = `\x1b[31m${wide}\x1b[0m\n` + Array.from({ length: 30 }, (_, i) => `row${i}`).join("\n");
    const out = minimiseOutput("df", ansi, FILTERS);
    expect(out.split("\n").length).toBeLessThanOrEqual(21);
    expect(out).not.toContain("\x1b[");
    expect(out.split("\n")[0]!.length).toBeLessThanOrEqual(80);
    expect(mini.applied("df", ansi)).toBe(true);
  });

  test("npm-install matches by subcommand regex and caps lines", () => {
    const out = Array.from({ length: 25 }, (_, i) => `pkg ${i}`).join("\n");
    expect(minimiseOutput("npm install", out, FILTERS).split("\n").length).toBeLessThanOrEqual(10);
    // npm run is not matched
    expect(minimiseOutput("npm run build", out, FILTERS)).toBe(out);
  });

  test("empty output and empty filter set are no-ops", () => {
    expect(minimiseOutput("df", "", FILTERS)).toBe("");
    expect(minimiseOutput("df", "x\n", [])).toBe("x\n");
  });
});
