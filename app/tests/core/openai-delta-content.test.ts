import { describe, expect, test } from "bun:test";
import { textFromOpenAiDeltaContent } from "../../src/core/providers/openai-delta-content";

describe("textFromOpenAiDeltaContent", () => {
  test("string passthrough", () => {
    expect(textFromOpenAiDeltaContent("hi")).toBe("hi");
  });

  test("multipart text parts", () => {
    expect(
      textFromOpenAiDeltaContent([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });

  test("unknown shapes return empty", () => {
    expect(textFromOpenAiDeltaContent(null)).toBe("");
    expect(textFromOpenAiDeltaContent({})).toBe("");
  });
});
