/**
 * H-5 / ruling 495: the empty-tool-result repair extracted from four adapters
 * into one pure util. The same sentinel is used by cacheable-messages-prefix.ts.
 */

import { describe, expect, test } from "bun:test";
import { NO_TOOL_OUTPUT, toolResultContent } from "../../src/core/providers/tool-result-content";
import { toOpenAiMessages } from "../../src/core/providers/openai";
import { toAnthropicMessages } from "../../src/core/providers/anthropic";
import { toGoogleContents } from "../../src/core/providers/google";
import { toOllamaMessages } from "../../src/core/providers/ollama";

describe("H-5 toolResultContent util", () => {
  test("sentinel is the documented wire value", () => {
    expect(NO_TOOL_OUTPUT).toBe("(no output)");
  });

  test("non-empty strings pass through byte-identically", () => {
    expect(toolResultContent("hello")).toBe("hello");
    expect(toolResultContent(" ")).toBe(" "); // whitespace is a non-empty string
    expect(toolResultContent("0")).toBe("0");
  });

  test("empty / missing / non-string values fail closed to the sentinel", () => {
    expect(toolResultContent("")).toBe(NO_TOOL_OUTPUT);
    expect(toolResultContent(undefined)).toBe(NO_TOOL_OUTPUT);
    expect(toolResultContent(null)).toBe(NO_TOOL_OUTPUT);
    expect(toolResultContent(0)).toBe(NO_TOOL_OUTPUT);
    expect(toolResultContent({})).toBe(NO_TOOL_OUTPUT);
  });

  test("no mutation, no loop: pure" , () => {
    const input = "ok";
    expect(toolResultContent(input)).toBe("ok");
    expect(input).toBe("ok");
  });
});

describe("H-5 extraction is wired into all four adapters", () => {
  test("OpenAI tool result", () => {
    expect(toOpenAiMessages([{ role: "tool", content: "", toolCallId: "c1" }])).toEqual([
      { role: "tool", tool_call_id: "c1", content: NO_TOOL_OUTPUT },
    ]);
  });

  test("Anthropic tool_result block", () => {
    expect(toAnthropicMessages([{ role: "tool", content: "", toolCallId: "c1" }])).toEqual([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: NO_TOOL_OUTPUT }] },
    ]);
  });

  test("Google functionResponse", () => {
    expect(toGoogleContents([{ role: "tool", content: "", toolCallId: "c1", toolName: "glob" }])).toEqual([
      { role: "user", parts: [{ functionResponse: { name: "glob", response: { result: NO_TOOL_OUTPUT } } }] },
    ]);
  });

  test("Ollama tool message", () => {
    expect(toOllamaMessages([{ role: "tool", content: "", toolName: "glob" }])).toEqual([
      { role: "tool", content: NO_TOOL_OUTPUT, tool_name: "glob" },
    ]);
  });
});
