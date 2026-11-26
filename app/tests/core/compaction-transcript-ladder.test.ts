/**
 * compaction-transcript-ladder.test.ts -- progressive transcript rungs
 * (plan Task 11). Pure seam; compactView remains the production path.
 */
import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import {
  progressiveTranscriptView,
  TRANSCRIPT_LADDER,
} from "../../src/core/compaction-transcript-ladder";

const PINNED = "Do not touch contracts.ts";

function sample(): ChatMsg[] {
  return [
    { role: "user", content: PINNED },
    { role: "assistant", content: "ok" },
    ...Array.from({ length: 6 }, (_, i) => ({ role: "user" as const, content: `u${i}` })),
  ];
}

const GEN = { sessionId: "s1", generation: 2, viewDigest: "d" };

describe("progressive transcript ladder", () => {
  test("every rung keeps pinned constraints and starts on a user turn", () => {
    const msgs = sample();
    for (let i = 0; i < TRANSCRIPT_LADDER.length; i += 1) {
      const out = progressiveTranscriptView(msgs, i, [PINNED], GEN);
      if (out.rung === "omitted") {
        expect(out.messages).toHaveLength(0);
        continue;
      }
      expect(out.messages[0].role).toBe("user");
      expect(JSON.stringify(out.messages)).toContain(PINNED);
      expect(out.dropped).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(JSON.stringify(out.messages)).toContain("generation 2");
    }
  });

  test("full rung returns the input untouched", () => {
    const msgs = sample();
    const out = progressiveTranscriptView(msgs, 0, [PINNED], GEN);
    expect(out.messages).toBe(msgs);
    expect(out.dropped).toBe(0);
    expect(out.rung).toBe("full");
  });

  test("later rungs drop more messages and out-of-range clamps", () => {
    const msgs = sample();
    const summarized = progressiveTranscriptView(msgs, 1, [PINNED], GEN);
    const pinned = progressiveTranscriptView(msgs, 99, [PINNED], GEN);
    expect(summarized.dropped).toBeGreaterThan(0);
    expect(pinned.rung).toBe("omitted"); // out-of-range clamps to the last (omitted) rung
    expect(pinned.messages.length).toBeLessThan(summarized.messages.length);
  });

  test("empty input never throws", () => {
    expect(progressiveTranscriptView([], 1, [], GEN).messages).toEqual([]);
  });

  test("full five-rung ladder maps whole/clipped/removed/user-only/omitted", () => {
    expect(TRANSCRIPT_LADDER).toEqual(["full", "summarized", "pinned", "user_only", "omitted"]);
    const msgs = sample();
    const userOnly = progressiveTranscriptView(msgs, 3, [PINNED], GEN);
    expect(userOnly.rung).toBe("user_only");
    expect(userOnly.messages.every((m) => m.role === "user")).toBe(true);
    expect(JSON.stringify(userOnly.messages)).toContain(PINNED);
    const omitted = progressiveTranscriptView(msgs, 4, [PINNED], GEN);
    expect(omitted.rung).toBe("omitted");
    expect(omitted.messages).toHaveLength(0);
    expect(omitted.dropped).toBe(msgs.length);
  });
});
