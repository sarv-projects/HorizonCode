import { describe, expect, test } from "bun:test";
import { resetStatusLineCache, runStatusLineScript } from "../../src/tui/status-line";

describe("status line script", () => {
  test("strips escape sequences from output", () => {
    // The sync path budgets 500ms for the child — correct for a status line
    // that must never stall the UI. On a loaded WSL box spawning Bun can exceed
    // that once, so retry a bounded number of times. The assertion is about
    // ANSI stripping, not spawn latency.
    let lines: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      resetStatusLineCache();
      lines = runStatusLineScript(
        { command: process.argv[0], args: ["-e", "console.log('\\u001b[31mhi\\u001b[0m')"] },
        { model: "m", provider: "mock" },
        "k1",
      );
      if (lines.length > 0) break;
    }
    expect(lines[0]).toBe("hi");
  });
});
