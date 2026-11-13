import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  AGENT_SPAWN_CAPABILITY_ID,
  formatChildSessionStreamLines,
  subagentBoundariesFromParentEvents,
} from "../../src/core/receipt-child-session-stream";
import { sessionEventsPath } from "../../src/core/session-kernel-reconcile";

describe("receipt-child-session-stream (ruling 322)", () => {
  test("subagentBoundariesFromParentEvents extracts capability and child session id", () => {
    const events = [
      { type: "subagent.start", agentId: "child-sess-1", task: "find usages", depth: 1 },
      { type: "subagent.event", agentId: "child-sess-1", name: "agent", depth: 1, event: { type: "notice" } },
      {
        type: "subagent.end",
        agentId: "child-sess-1",
        status: "completed",
        durationMs: 1200,
        tools: 2,
        depth: 1,
      },
    ];
    const rows = subagentBoundariesFromParentEvents(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capabilityId).toBe(AGENT_SPAWN_CAPABILITY_ID);
    expect(rows[0]?.childSessionId).toBe("child-sess-1");
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.subagentEventCount).toBe(1);
  });

  test("formatChildSessionStreamLines counts child session jsonl", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-child-stream-"));
    const parent = "parent-sess";
    const child = "child-sess-2";
    try {
      const parentFile = sessionEventsPath(ws, parent);
      mkdirSync(path.dirname(parentFile), { recursive: true });
      writeFileSync(
        parentFile,
        [
          JSON.stringify({ type: "subagent.start", agentId: child, task: "t", depth: 1 }),
          JSON.stringify({ type: "subagent.end", agentId: child, status: "completed", depth: 1 }),
        ].join("\n") + "\n",
      );
      const childFile = sessionEventsPath(ws, child);
      writeFileSync(
        childFile,
        [JSON.stringify({ type: "session.start" }), JSON.stringify({ type: "tool.card" })].join("\n") + "\n",
      );
      const lines = formatChildSessionStreamLines(ws, parent, 3);
      expect(lines.some((l) => l.includes("agent.spawn"))).toBe(true);
      expect(lines.some((l) => l.includes(child))).toBe(true);
      expect(lines.some((l) => l.includes("2 event line(s)"))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
