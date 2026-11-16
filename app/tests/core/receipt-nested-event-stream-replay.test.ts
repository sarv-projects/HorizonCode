import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { hashEnvelope } from "../../src/contracts";
import {
  formatNestedEventStreamReplayLines,
  replayNestedEventStreams,
} from "../../src/core/receipt-nested-event-stream-replay";
import { sessionEventsPath } from "../../src/core/session-kernel-reconcile";

function writeChainedSession(
  ws: string,
  sessionId: string,
  entries: { type: string; payload: Record<string, unknown> }[],
): string {
  const file = sessionEventsPath(ws, sessionId);
  mkdirSync(path.dirname(file), { recursive: true });
  let prevHash: string | null = null;
  const rows = entries.map(({ type, payload }, index) => {
    const preimage = {
      id: `evt_${sessionId}_${index}`,
      seq: index + 1,
      ts: "2026-11-15T00:00:00.000Z",
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

describe("receipt-nested-event-stream-replay (ruling 478)", () => {
  test("two-level nested walk trusts verified child and grandchild streams", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-nested-evt-ok-"));
    const parent = "parent-sess";
    const child = "child-sess";
    const gchild = "gchild-sess";
    try {
      writeChainedSession(ws, parent, [
        { type: "subagent.start", payload: { agentId: child, task: "delegate", depth: 1 } },
        { type: "subagent.end", payload: { agentId: child, status: "completed", depth: 1 } },
      ]);
      writeChainedSession(ws, child, [
        { type: "session.start", payload: {} },
        { type: "subagent.start", payload: { agentId: gchild, task: "nested", depth: 2 } },
        { type: "subagent.end", payload: { agentId: gchild, status: "completed", depth: 2 } },
      ]);
      writeChainedSession(ws, gchild, [
        { type: "session.start", payload: {} },
        { type: "tool.card", payload: {} },
      ]);
      const verdict = replayNestedEventStreams(ws, parent);
      expect(verdict.ok).toBe(true);
      expect(verdict.visited).toBe(2);
      expect(verdict.trusted).toBe(2);
      expect(verdict.refused).toBe(0);
      expect(verdict.nodes[0]?.sessionId).toBe(child);
      expect(verdict.nodes[0]?.evidence).toBe("hash_and_anchor_valid");
      expect(verdict.nodes[0]?.children[0]?.sessionId).toBe(gchild);
      expect(verdict.nodes[0]?.children[0]?.evidence).toBe("hash_and_anchor_valid");
      const lines = formatNestedEventStreamReplayLines(verdict);
      expect(lines.some((l) => l.includes("nested event-stream replay: ok"))).toBe(true);
      expect(lines.some((l) => l.includes(`depth 1 session ${gchild}`))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("depth budget refuses deeper grandchildren without trusting them", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-nested-evt-depth-"));
    const parent = "p";
    const child = "c";
    const gchild = "g";
    try {
      writeChainedSession(ws, parent, [
        { type: "subagent.start", payload: { agentId: child, task: "t" } },
      ]);
      writeChainedSession(ws, child, [
        { type: "subagent.start", payload: { agentId: gchild, task: "t2" } },
      ]);
      writeChainedSession(ws, gchild, [{ type: "session.start", payload: {} }]);
      const verdict = replayNestedEventStreams(ws, parent, { maxDepth: 0 });
      expect(verdict.ok).toBe(false);
      expect(verdict.nodes[0]?.evidence).toBe("hash_and_anchor_valid");
      expect(verdict.nodes[0]?.children[0]?.evidence).toBe("depth_exceeded");
      expect(verdict.refused).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("cycle in nested child session ids is refused", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-nested-evt-cycle-"));
    try {
      writeChainedSession(ws, "a", [
        { type: "subagent.start", payload: { agentId: "b", task: "to-b" } },
      ]);
      writeChainedSession(ws, "b", [
        { type: "subagent.start", payload: { agentId: "a", task: "back-to-a" } },
      ]);
      const verdict = replayNestedEventStreams(ws, "a");
      expect(verdict.ok).toBe(false);
      expect(verdict.nodes[0]?.sessionId).toBe("b");
      expect(verdict.nodes[0]?.evidence).toBe("hash_and_anchor_valid");
      expect(verdict.nodes[0]?.children[0]?.evidence).toBe("cycle");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("broken parent refuses to discover or trust child names", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-nested-evt-parent-"));
    const parent = "parent-broke";
    try {
      const parentFile = writeChainedSession(ws, parent, [
        { type: "subagent.start", payload: { agentId: "secret-child", task: "t" } },
      ]);
      writeFileSync(parentFile, readFileSync(parentFile, "utf8").replace("secret-child", "forged-child"));
      writeChainedSession(ws, "forged-child", [{ type: "session.start", payload: {} }]);
      const verdict = replayNestedEventStreams(ws, parent);
      expect(verdict.ok).toBe(false);
      expect(verdict.rootEvidence).toBe("broken_chain");
      expect(verdict.nodes).toHaveLength(0);
      expect(formatNestedEventStreamReplayLines(verdict).some((l) => l.includes("forged-child"))).toBe(
        false,
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("tampered child stream is refused under nested replay", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-nested-evt-child-"));
    const parent = "parent";
    const child = "child-bad";
    try {
      writeChainedSession(ws, parent, [
        { type: "subagent.start", payload: { agentId: child, task: "t" } },
      ]);
      const childFile = writeChainedSession(ws, child, [
        { type: "session.start", payload: {} },
        { type: "tool.card", payload: {} },
      ]);
      writeFileSync(childFile, readFileSync(childFile, "utf8").replace("tool.card", "tool.fake"));
      const verdict = replayNestedEventStreams(ws, parent);
      expect(verdict.ok).toBe(false);
      expect(verdict.nodes[0]?.evidence).toBe("broken_chain");
      expect(verdict.refused).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("missing child stream is refused rather than verified", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-nested-evt-miss-"));
    try {
      writeChainedSession(ws, "parent", [
        { type: "subagent.start", payload: { agentId: "missing-child" } },
      ]);
      const verdict = replayNestedEventStreams(ws, "parent");
      expect(verdict.ok).toBe(false);
      expect(verdict.nodes[0]?.evidence).toBe("missing_stream");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("absent root stream is ok with no children", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-nested-evt-empty-"));
    try {
      const verdict = replayNestedEventStreams(ws, "no-events-yet");
      expect(verdict.ok).toBe(true);
      expect(verdict.rootEvidence).toBe("missing_stream");
      expect(formatNestedEventStreamReplayLines(verdict)[0]).toContain("root stream absent");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
