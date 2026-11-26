/**
 * shell-output-minimizer.test.ts — declarative filter integration in shell.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  clearShellMinimizerFilters,
  getRegisteredShellMinimizerFilters,
  minimiseShellOutput,
  registerShellMinimizerFilters,
} from "../../src/tools/shell";

afterEach(() => {
  clearShellMinimizerFilters();
});

describe("shell declarative output minimizer wiring", () => {
  test("applies matching declarative filter to command output", () => {
    registerShellMinimizerFilters([
      {
        id: "git-status",
        match: /^git\s+status/,
        maxLines: 2,
        truncateLinesAt: 20,
      },
    ]);

    const longOutput = [
      "On branch main, working tree clean and ready for changes",
      "Your branch is ahead of 'origin/main' by 1 commit",
      "Line 3 should be dropped by maxLines",
      "Line 4 should also be dropped",
    ].join("\n");

    const result = minimiseShellOutput(longOutput, "git status");
    expect(result.changed).toBe(true);

    const lines = result.text.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0].length).toBeLessThanOrEqual(20);
    expect(lines[1].length).toBeLessThanOrEqual(20);
  });

  test("unmatched commands pass through filter stage to normal minimizer", () => {
    registerShellMinimizerFilters([
      {
        id: "git-status",
        match: /^git\s+status/,
        maxLines: 1,
      },
    ]);

    const out = "line 1\nline 2\nline 3";
    const res = minimiseShellOutput(out, "npm test");
    // Normal minimizer doesn't truncate lines or drop rows unless they are blank runs or have trailing spaces
    expect(res.text).toBe(out);
    expect(res.changed).toBe(false);
  });

  test("filters can be cleared cleanly", () => {
    registerShellMinimizerFilters([{ id: "test", match: /.*/, maxLines: 1 }]);
    expect(getRegisteredShellMinimizerFilters().length).toBe(1);
    clearShellMinimizerFilters();
    expect(getRegisteredShellMinimizerFilters().length).toBe(0);
  });
});
