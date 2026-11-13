import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import { compactHistory, elidedPrefixForCompaction, SUMMARY_HEADING } from "../../src/core/compaction";
import { CompactionHoldBuffer, compactionHoldKey, summariseElidedWithHold } from "../../src/core/compaction-hold";

function msg(role: ChatMsg["role"], content: string): ChatMsg {
  return { role, content };
}

describe("compaction hold-then-swap", () => {
  test("swaps injected summary when prefix key matches", () => {
    const elided = [msg("user", "old"), msg("assistant", "reply")];
    const hold = new CompactionHoldBuffer(() => "SHOULD_NOT_RUN");
    hold.prepareHold(elided, 10, 8);
    const { summary } = summariseElidedWithHold(elided, 10, 8, hold);
    expect(summary).toBe("SHOULD_NOT_RUN");
    expect(hold.peekHeldSummary()).toBeNull();
  });

  test("compactHistory uses held summary on swap", () => {
    const history: ChatMsg[] = [msg("user", "task: ship it")];
    for (let i = 0; i < 90; i += 1) {
      history.push(msg("assistant", `a ${i}`));
      history.push(msg("user", `u ${i}`));
    }
    const hold = new CompactionHoldBuffer(() => `${SUMMARY_HEADING}\n\nHELD_SUMMARY_STUB`);
    const elided = elidedPrefixForCompaction(history, 80);
    expect(elided).not.toBeNull();
    hold.prepareHold(elided as ChatMsg[], history.length, 80);
    const result = compactHistory(history, { limit: 80, holdBuffer: hold });
    expect(result.compacted).toBe(true);
    expect(result.summary).toContain("HELD_SUMMARY_STUB");
    expect(result.history[0]?.content).toContain("HELD_SUMMARY_STUB");
  });

  test("hold key changes when elided prefix changes", () => {
    const a = [msg("user", "one")];
    const b = [msg("user", "two")];
    expect(compactionHoldKey(a)).not.toBe(compactionHoldKey(b));
  });
});
