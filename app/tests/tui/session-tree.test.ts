import { describe, expect, test } from "bun:test";
import { buildSessionTree } from "../../src/tui/session-tree";
import type { SessionInfo } from "../../src/core/session";

describe("session-tree", () => {
  test("indents fork children", () => {
    const parent: SessionInfo = {
      id: "p",
      title: "parent",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-02T00:00:00Z",
    };
    const child: SessionInfo = {
      id: "c",
      title: "child",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-03T00:00:00Z",
      forkedFrom: { sessionId: "p", messageIndex: 3, parentSeq: 1 },
    };
    const lines = buildSessionTree([parent, child], "c");
    expect(lines.some((l) => l.includes("p") && l.includes("parent"))).toBe(true);
    expect(lines.some((l) => l.includes("c") && l.includes("*"))).toBe(true);
  });
});
