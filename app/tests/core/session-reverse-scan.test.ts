/**
 * session-reverse-scan.test.ts — reverse JSONL scanner wired to session rollout recovery.
 */

import { describe, expect, test } from "bun:test";
import { scanReverseJsonlRecords } from "../../src/core/reverse-jsonl-scanner";
import { scanRecentSessionRolloutRecords } from "../../src/core/session";

describe("reverse JSONL session rollout scanning", () => {
  test("scanReverseJsonlRecords returns parsed objects newest-first up to maxRecords", () => {
    const lines = [
      JSON.stringify({ seq: 1, type: "session.start" }),
      JSON.stringify({ seq: 2, type: "turn.start" }),
      JSON.stringify({ seq: 3, type: "tool.card" }),
      JSON.stringify({ seq: 4, type: "turn.end" }),
    ].join("\n") + "\n";

    const records = scanReverseJsonlRecords<{ seq: number; type: string }>(lines, { maxRecords: 2 });
    expect(records.length).toBe(2);
    expect(records[0].seq).toBe(4);
    expect(records[0].type).toBe("turn.end");
    expect(records[1].seq).toBe(3);
    expect(records[1].type).toBe("tool.card");
  });

  test("scanRecentSessionRolloutRecords exposed on session.ts mirrors the reverse scan", () => {
    const lines = [
      JSON.stringify({ id: "e1", kind: "prompt" }),
      JSON.stringify({ id: "e2", kind: "response" }),
    ].join("\n") + "\n";

    const recent = scanRecentSessionRolloutRecords<{ id: string; kind: string }>(lines);
    expect(recent.length).toBe(2);
    expect(recent[0].id).toBe("e2");
    expect(recent[1].id).toBe("e1");
  });
});
