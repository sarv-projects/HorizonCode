import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import { compactHistory } from "../../src/core/compaction";
import {
  headTailTruncate,
  pruneToolResultsForCompaction,
  PRUNED_TOOL_MARKER,
  trimHistoryMessages,
  trimMessageTokens,
} from "../../src/core/compaction-pruner";

describe("compaction pruner", () => {
  test("prunes oversized tool rows", () => {
    const big = "x".repeat(20_000);
    const msgs: ChatMsg[] = [{ role: "tool", content: big }];
    const pruned = pruneToolResultsForCompaction(msgs);
    expect(pruned[0]?.content).toContain(PRUNED_TOOL_MARKER);
    expect((pruned[0]?.content ?? "").length).toBeLessThan(big.length);
  });

  test("compaction lowers elided token estimate when tool blob is pruned", () => {
    const msgs: ChatMsg[] = [];
    for (let i = 0; i < 90; i += 1) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` });
    }
    msgs.splice(3, 0, { role: "tool", content: "t".repeat(30_000) });
    const out = compactHistory(msgs, { limit: 80 });
    expect(out.compacted).toBe(true);
    expect(out.elidedTokens).toBeLessThan(5000);
  });

  test("headTailTruncate preserves leading and trailing content with omission marker", () => {
    const headText = "START_LINE_1\nSTART_LINE_2\n";
    const middleText = "M".repeat(5000);
    const tailText = "\nEND_SUMMARY_PASS_COUNT=42";
    const full = `${headText}${middleText}${tailText}`;

    const truncated = headTailTruncate(full, 200, 0.5);
    expect(truncated).toContain("START_LINE_1");
    expect(truncated).toContain("END_SUMMARY_PASS_COUNT=42");
    expect(truncated).toContain("omitted");
    expect(truncated.length).toBeLessThan(full.length);
  });

  test("trimMessageTokens trims string and multipart content", () => {
    const oversized = "A".repeat(10_000);
    const strMsg: ChatMsg = { role: "tool", content: oversized };
    const trimmedStr = trimMessageTokens(strMsg, 500);
    expect(typeof trimmedStr.content).toBe("string");
    expect((trimmedStr.content as string).length).toBeLessThan(oversized.length);
    expect((trimmedStr.content as string)).toContain("token-budget: message content trimmed");

    const multiMsg: ChatMsg = {
      role: "tool",
      content: [
        { type: "text", text: oversized },
        { type: "image", base64: "IMG_DATA", media_type: "image/png" },
      ],
    };
    const trimmedMulti = trimMessageTokens(multiMsg, 500);
    expect(Array.isArray(trimmedMulti.content)).toBe(true);
    const parts = trimmedMulti.content as Array<{ type: string; text?: string; base64?: string }>;
    expect(parts[0]!.type).toBe("text");
    expect(parts[0]!.text!.length).toBeLessThan(oversized.length);
    expect(parts[1]!.type).toBe("image");
    expect(parts[1]!.base64).toBe("IMG_DATA");
  });

  test("trimHistoryMessages filters by role and tracks trimmed counts", () => {
    const msgs: ChatMsg[] = [
      { role: "user", content: "U".repeat(10_000) },
      { role: "assistant", content: "A".repeat(10_000) },
      { role: "tool", content: "T".repeat(10_000) },
    ];

    // Default roles: ["tool"]
    const res = trimHistoryMessages(msgs, 500);
    expect(res.trimmedCount).toBe(1);
    expect(res.messages[0]!.content).toBe(msgs[0]!.content); // user unchanged
    expect(res.messages[1]!.content).toBe(msgs[1]!.content); // assistant unchanged
    expect((res.messages[2]!.content as string).length).toBeLessThan(10_000); // tool trimmed
  });
});
