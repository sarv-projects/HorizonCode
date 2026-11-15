import { describe, expect, test } from "bun:test";
import {
  approvalCardScreenRows,
  normalizeApprovalKeyPrompt,
  refreshApprovalCardAboveCursor,
} from "../../src/tui/approval-key-prompt";

describe("approval-key-prompt", () => {
  test("normalize array prompt", () => {
    const n = normalizeApprovalKeyPrompt(["a", "b"]);
    expect(n.lines).toEqual(["a", "b"]);
    expect(n.screenRows).toBe(3);
    expect(n.onTick).toBeUndefined();
  });

  test("normalize object with onTick", () => {
    let tick = 0;
    const n = normalizeApprovalKeyPrompt({
      lines: ["x"],
      onTick: () => [`y${tick++}`],
    });
    expect(n.onTick?.()).toEqual(["y0"]);
    expect(n.onTick?.()).toEqual(["y1"]);
  });

  test("refreshApprovalCardAboveCursor emits cursor-up and clear", () => {
    const chunks: string[] = [];
    refreshApprovalCardAboveCursor((c) => chunks.push(c), approvalCardScreenRows(2), ["line1", "line2"]);
    const joined = chunks.join("");
    expect(joined).toContain("\x1b[3A");
    expect(joined).toContain("line1");
    expect(joined).toContain("line2");
  });
});