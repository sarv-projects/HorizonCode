import { describe, expect, test } from "bun:test";
import { formatExecOutputForModel, wallSeconds } from "../../src/tools/exec-output-format";

describe("exec-output-format", () => {
  test("wallSeconds rounds to 0.1s", () => {
    expect(wallSeconds(1234)).toBe("1.2");
    expect(wallSeconds(50)).toBe("0.1");
  });

  test("formatExecOutputForModel matches codex shape", () => {
    const text = formatExecOutputForModel({
      exitCode: 0,
      wallMs: 100,
      body: "hello",
      outputTruncated: false,
    });
    expect(text).toBe("Exit code: 0\nWall time: 0.1s\nOutput:\nhello");
  });

  test("includes Total output lines only when truncated", () => {
    const text = formatExecOutputForModel({
      exitCode: 1,
      wallMs: 200,
      body: "a\nb",
      outputTruncated: true,
    });
    expect(text).toContain("Total output lines: 2");
  });
});
