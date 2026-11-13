import { describe, expect, test } from "bun:test";
import type { PostmortemRecord } from "../../src/core/postmortem";
import { histogramFromPostmortems, renderSessionCorpusSummary } from "../../src/core/session-corpus-stats";

describe("J-5 session corpus stats", () => {
  test("histogram merges tool counts", () => {
    const pm = {
      terminal: "failed",
      toolCalls: { read: 3, shell: 1 },
    } as PostmortemRecord;
    const summary = histogramFromPostmortems([pm]);
    expect(summary.tools[0]?.tool).toBe("read");
    const text = renderSessionCorpusSummary(summary);
    expect(text).toContain("read: 3");
  });
});
