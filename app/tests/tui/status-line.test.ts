import { describe, expect, test } from "bun:test";
import { resetStatusLineCache, runStatusLineScript } from "../../src/tui/status-line";

describe("status line script", () => {
  test("strips escape sequences from output", () => {
    resetStatusLineCache();
    const lines = runStatusLineScript(
      { command: process.argv[0], args: ["-e", "console.log('\\u001b[31mhi\\u001b[0m')"] },
      { model: "m", provider: "mock" },
      "k1",
    );
    expect(lines[0]).toBe("hi");
  });
});
