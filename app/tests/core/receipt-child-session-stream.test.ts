import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { hashEnvelope } from "../../src/contracts";
import {
  AGENT_SPAWN_CAPABILITY_ID,
  formatChildSessionStreamLines,
  subagentBoundariesFromParentEvents,
} from "../../src/core/receipt-child-session-stream";
import { sessionEventsPath } from "../../src/core/session-kernel-reconcile";

function writeChainedSession(
  ws: string, sessionId: string,
  entries: { type: string; payload: Record<string, unknown> }[],
): string {
  const file = sessionEventsPath(ws, sessionId);
  mkdirSync(path.dirname(file), { recursive: true });
  let prevHash: string | null = null;
  const rows = entries.map(({ type, payload }, index) => {
    const preimage = {
      id: `evt_${sessionId}_${index}`,
      seq: index + 1,
      ts: "2026-11-14T00:00:00.000Z",
      stream: `session:${sessionId}`,
      type,
      actor: { kind: "system" as const, id: "fixture" },
      payload,
      prevHash,
    };
    const hash = hashEnvelope(preimage);
    prevHash = hash;
    return { ...preimage, hash };
  });
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(file + ".head", JSON.stringify({ seq: rows.length, hash: prevHash }) + "\n");
  return file;
}

describe("receipt-child-session-stream (rulings 322, 357)", () => {
  test("subagentBoundariesFromParentEvents extracts capability and child session id", () => {
    const events = [
      { type: "subagent.start", agentId: "child-sess-1", task: "find usages", depth: 1 },
      { type: "subagent.event", agentId: "child-sess-1", name: "agent", depth: 1, event: { type: "notice" } },
      { type: "subagent.end", agentId: "child-sess-1", status: "completed", durationMs: 1200, tools: 2, depth: 1 },
    ];
    const rows = subagentBoundariesFromParentEvents(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capabilityId).toBe(AGENT_SPAWN_CAPABILITY_ID);
    expect(rows[0]?.childSessionId).toBe("child-sess-1");
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.subagentEventCount).toBe(1);
  });

  test("inspector independently verifies hash + head for child session stream", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-child-stream-"));
    const parent = "parent-sess";
    const child = "child-sess-2";
    try {
      writeChainedSession(ws, parent, [
        { type: "subagent.start", payload: { agentId: child, task: "t", depth: 1 } },
        { type: "subagent.end", payload: { agentId: child, status: "completed", depth: 1 } },
      ]);
      const childFile = writeChainedSession(ws, child, [
        { type: "session.start", payload: {} },
        { type: "tool.card", payload: {} },
      ]);
      const lines = formatChildSessionStreamLines(ws, parent, 3);
      expect(lines.some((l) => l.includes("agent.spawn"))).toBe(true);
      expect(lines.some((l) => l.includes(child))).toBe(true);
      expect(lines.some((l) => l.includes("2 event line(s)"))).toBe(true);
      expect(lines.some((l) => l.includes("VERIFIED hash chain + head (2)"))).toBe(true);

      // A valid parent does not make an altered child stream trustworthy.
      const forged = readFileSync(childFile, "utf8").replace("tool.card", "tool.fake");
      writeFileSync(childFile, forged);
      const tampered = formatChildSessionStreamLines(ws, parent, 3);
      expect(tampered.some((l) => l.includes("INVALID chain at seq 2"))).toBe(true);
      expect(tampered.some((l) => l.includes("VERIFIED hash chain"))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("corrupted parent chain refuses to name or trust inferred children", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-parent-chain-"));
    const parent = "parent-corrupt";
    try {
      const parentFile = writeChainedSession(ws, parent, [
        { type: "subagent.start", payload: { agentId: "secret-child", task: "task" } },
      ]);
      writeFileSync(parentFile, readFileSync(parentFile, "utf8").replace("secret-child", "forged-child"));
      const lines = formatChildSessionStreamLines(ws, parent, 1);
      expect(lines.some((l) => l.includes("parent stream INVALID chain at seq 1"))).toBe(true);
      expect(lines.some((l) => l.includes("refusing child names"))).toBe(true);
      expect(lines.some((l) => l.includes("forged-child"))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("missing child stream is explicitly missing rather than verified", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-child-missing-"));
    try {
      writeChainedSession(ws, "parent", [
        { type: "subagent.start", payload: { agentId: "missing-child" } },
      ]);
      const lines = formatChildSessionStreamLines(ws, "parent", 0);
      expect(lines.some((l) => l.includes("MISSING (no child stream evidence)"))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
