/**
 * code-mode-vm-tool.test.ts — deferred `code_mode_vm` tool: runs a bytecode
 * program through the coherent, metered VM as PURE computation. No host
 * functions are registered, so the program cannot touch FS/net/tools.
 */
import { describe, expect, test } from "bun:test";
import type { ToolContext } from "../../src/contracts";
import { codeModeVmTool } from "../../src/tools/code-mode-vm";
import { Op } from "../../src/core/code-mode-vm";

function ctx(): ToolContext {
  return {
    cwd: "/ws",
    workspace: "/ws",
    sessionId: "s1",
    signal: new AbortController().signal,
  } as unknown as ToolContext;
}

describe("code_mode_vm tool (pure metered computation)", () => {
  test("is a deferred tool discoverable by tool_search", () => {
    expect(codeModeVmTool.exposure).toBe("deferred");
    expect(codeModeVmTool.searchInfo?.keywords.join(" ")).toMatch(/bytecode|vm|compute|code/i);
  });

  test("runs a real bytecode program and returns the computed value", async () => {
    const result = await codeModeVmTool.execute({
      words: [Op.PUSH_INT, 6, Op.PUSH_INT, 7, Op.MUL, Op.RETURN],
      consts: [],
    }, ctx());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("42");
    expect(result.output).toContain("return");
  });

  test("out-of-fuel is an honest typed result, not a crash", async () => {
    const result = await codeModeVmTool.execute({
      words: [Op.PUSH_INT, 1, Op.PUSH_INT, 2, Op.ADD, Op.RETURN],
      consts: [],
      fuel: 2,
    }, ctx());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("out_of_fuel");
  });

  test("malformed bytecode is a typed refusal", async () => {
    const result = await codeModeVmTool.execute({ words: [Op.PUSH_INT], consts: [] }, ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/truncat|operand|bytecode/i);
  });

  test("fuel and program size are bounded", async () => {
    const result = await codeModeVmTool.execute({
      words: [Op.PUSH_INT, 1, Op.RETURN],
      consts: [],
      fuel: 999999999,
    }, ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/fuel|bound/i);
  });
});
