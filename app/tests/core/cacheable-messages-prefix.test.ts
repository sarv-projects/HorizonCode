import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import {
  cacheableBlocksCutIndex,
  cacheableMessagesCutIndex,
  cacheableMessagesPrefix,
  toolResultMayStillGrow,
} from "../../src/core/providers/cacheable-messages-prefix";
import {
  planCacheBreakpoints,
  planCacheBreakpointsForMessages,
} from "../../src/core/providers/cache-breakpoints";

describe("cacheableMessagesPrefix", () => {
  test("returns full history when the last tool result is settled", () => {
    const messages: ChatMsg[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: "{}" }] },
      { role: "tool", content: "file body", toolCallId: "c1", toolName: "read" },
      { role: "assistant", content: "done" },
    ];
    expect(cacheableMessagesCutIndex(messages)).toBe(messages.length);
    expect(cacheableMessagesPrefix(messages)).toEqual(messages);
  });

  test("stops before a trailing empty tool result (in-flight)", () => {
    const messages: ChatMsg[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: "{}" }] },
      { role: "tool", content: "", toolCallId: "c1", toolName: "read" },
    ];
    expect(cacheableMessagesCutIndex(messages)).toBe(2);
    expect(cacheableMessagesPrefix(messages)).toEqual(messages.slice(0, 2));
    expect(toolResultMayStillGrow(messages[2]!, 2, messages)).toBe(true);
  });

  test("stops before resumable truncated tool output", () => {
    const truncated = `head\n[truncated: 100 → 50 bytes\nnextOffset: 50\n`;
    const messages: ChatMsg[] = [
      { role: "user", content: "go" },
      { role: "tool", content: truncated, toolCallId: "c1", toolName: "read" },
    ];
    expect(cacheableMessagesCutIndex(messages)).toBe(1);
    expect(cacheableMessagesPrefix(messages)).toEqual([messages[0]!]);
  });

  test("prior tool rows with nextOffset are stable when later messages exist", () => {
    const truncated = `part\nnextOffset: 10\n`;
    const messages: ChatMsg[] = [
      { role: "tool", content: truncated, toolCallId: "a", toolName: "read" },
      { role: "user", content: "continue" },
    ];
    expect(cacheableMessagesCutIndex(messages)).toBe(2);
  });

  test("planCacheBreakpointsForMessages skips volatile trailing tool_result", () => {
    const messages: ChatMsg[] = [
      { role: "user", content: "u" },
      { role: "tool", content: "settled", toolCallId: "a", toolName: "read" },
      { role: "tool", content: "", toolCallId: "b", toolName: "read" },
    ];
    const without = planCacheBreakpointsForMessages(messages, { enabled: true, useCacheablePrefix: false });
    const withPrefix = planCacheBreakpointsForMessages(messages, { enabled: true, useCacheablePrefix: true });
    const toolBp = (p: typeof without) => p.filter((x) => x.kind === "tool_result").map((x) => x.index);
    expect(toolBp(without)).toContain(2);
    expect(toolBp(withPrefix)).not.toContain(2);
    expect(toolBp(withPrefix)).toContain(1);
  });

  test("cacheableBlocksCutIndex excludes volatile tail tool_result only at end", () => {
    const blocks = [
      { kind: "system" as const, text: "sys" },
      { kind: "stable" as const, text: "u" },
      { kind: "tool_result" as const, text: "settled" },
      { kind: "tool_result" as const, text: "" },
    ];
    expect(cacheableBlocksCutIndex(blocks)).toBe(3);
    const withAssistantTail = [
      ...blocks.slice(0, 3),
      { kind: "other" as const, text: "thinking" },
    ];
    expect(cacheableBlocksCutIndex(withAssistantTail)).toBe(withAssistantTail.length);
  });

  test("stablePrefixLength on planCacheBreakpoints", () => {
    const blocks = [
      { kind: "stable" as const, text: "u" },
      { kind: "tool_result" as const, text: "t1" },
      { kind: "tool_result" as const, text: "t2" },
    ];
    const all = planCacheBreakpoints(blocks, { enabled: true, stablePrefixLength: 2 });
    expect(all.some((p) => p.index === 2)).toBe(false);
    expect(all.some((p) => p.index === 1)).toBe(true);
  });
});
