import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import { compactHistory } from "../../src/core/compaction";
import { pruneToolResultsForCompaction, PRUNED_TOOL_MARKER } from "../../src/core/compaction-pruner";

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
});
