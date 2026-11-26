/**
 * ctx-inspect.test.ts — Group D first-class ctx_inspect tool (claude-code
 * CtxInspectTool port). Pure deferred inspection: no effect, no guard, no receipt.
 */
import { describe, expect, test } from "bun:test";
import type { ToolContext } from "../../src/contracts";
import { ctxInspectTool } from "../../src/tools/ctx-inspect";

function ctx(): ToolContext {
  return {
    cwd: "/ws",
    workspace: "/ws",
    sessionId: "s1",
    signal: new AbortController().signal,
    contextWindowTokens: 128000,
  } as unknown as ToolContext;
}

describe("ctx_inspect tool (deferred)", () => {
  test("is a deferred tool discoverable by tool_search", () => {
    expect(ctxInspectTool.exposure).toBe("deferred");
    expect(ctxInspectTool.searchInfo?.keywords.join(" ")).toMatch(/context|window|token/i);
  });

  test("reports the model-visible context budget without mutating anything", async () => {
    const result = await ctxInspectTool.execute({}, ctx());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("128000");
    expect(result.output).toContain("/ws");
  });

  test("a topic filter narrows the reported fields", async () => {
    const result = await ctxInspectTool.execute({ topic: "tokens" }, ctx());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("128000");
    expect(result.output).not.toContain("/ws");
  });
});
