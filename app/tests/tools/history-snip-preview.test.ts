/**
 * history-snip-preview.test.ts — Group D pure deferred history_snip_preview tool.
 * Reduced, honest form of claude-code SnipTool: a PURE preview of what snipping
 * old tool results would look like. Never touches conversation state, no guard,
 * no receipt — safe in read-only mode.
 */
import { describe, expect, test } from "bun:test";
import type { ToolContext } from "../../src/contracts";
import { historySnipPreviewTool, snipPreview } from "../../src/tools/history-snip-preview";

function ctx(): ToolContext {
  return {
    cwd: "/ws",
    workspace: "/ws",
    sessionId: "s1",
    signal: new AbortController().signal,
  } as unknown as ToolContext;
}

describe("history_snip_preview tool (pure deferred)", () => {
  test("is a deferred tool discoverable by tool_search", () => {
    expect(historySnipPreviewTool.exposure).toBe("deferred");
    expect(historySnipPreviewTool.searchInfo?.keywords.join(" ")).toMatch(/snip|history|tool result/i);
  });

  test("snipPreview keeps first/last lines and marks the snipped middle", () => {
    const input = Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n");
    const out = snipPreview(input, 2, 2);
    expect(out.preview.startsWith("line-0\nline-1")).toBe(true);
    expect(out.preview.endsWith("line-8\nline-9")).toBe(true);
    expect(out.preview).toContain("[snipped");
    expect(out.snippedChars).toBeGreaterThan(0);
    expect(out.snippedLines).toBe(6);
  });

  test("short input is returned unchanged with zero snipped", () => {
    const out = snipPreview("a\nb", 2, 2);
    expect(out.preview).toBe("a\nb");
    expect(out.snippedChars).toBe(0);
  });

  test("execute is read-only and never mutates the input string", async () => {
    const input = Array.from({ length: 8 }, (_, i) => `row-${i}`).join("\n");
    const result = await historySnipPreviewTool.execute({ text: input, keepFirst: 1, keepLast: 1 }, ctx());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("[snipped");
    expect(input.split("\n")).toHaveLength(8); // unchanged
  });

  test("missing text is a typed refusal", async () => {
    const result = await historySnipPreviewTool.execute({}, ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/text/i);
  });
});
