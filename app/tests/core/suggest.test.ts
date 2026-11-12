import { describe, expect, test } from "bun:test";
import { cleanSuggestedCommand, suggestPrompt } from "../../src/core/suggest";

describe("hzcode suggest", () => {
  test("prompt asks for one line and strips C1 from the task", () => {
    const p = suggestPrompt("list\x80 files");
    expect(p).toContain("one shell command");
    expect(p).not.toContain("\x80");
  });

  test("cleanSuggestedCommand strips fences and control-heavy replies", () => {
    expect(cleanSuggestedCommand("```sh\nls -la\n```")).toBe("ls -la");
    expect(cleanSuggestedCommand('"\u001b[31mls\u001b[0m"')).not.toContain("\u001b");
  });
});
