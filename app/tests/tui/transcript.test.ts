import { describe, expect, test } from "bun:test";
import { formatTranscriptPlain } from "../../src/tui/transcript";

describe("transcript export", () => {
  test("plain sections", () => {
    const text = formatTranscriptPlain([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(text).toContain("## user");
    expect(text).toContain("hi");
    expect(text).toContain("hello");
  });
});
