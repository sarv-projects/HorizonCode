import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { hashReceipt } from "../../src/contracts";
import { hashReceiptVersioned } from "../../src/core/receipt-schema";
import {
  formatNestedReceiptReplayLines,
  replayNestedChildReceipts,
  replayNestedReceiptsInWorkspace,
} from "../../src/core/receipt-nested-replay";
import { receiptsPath } from "../../src/core/session-kernel-reconcile";

function writeChain(ws: string, rows: Record<string, unknown>[]): void {
  const file = receiptsPath(ws);
  mkdirSync(path.dirname(file), { recursive: true });
  let prev: string | null = null;
  const hashed = rows.map((row, i) => {
    const base = { ...row, seq: i + 1, prevHash: prev };
    const hash = hashReceiptVersioned(base);
    const full = { ...base, hash };
    prev = hash;
    return full;
  });
  writeFileSync(file, hashed.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const last = hashed[hashed.length - 1]!;
  writeFileSync(file + ".head", JSON.stringify({ seq: last.seq, hash: last.hash }));
}

describe("receipt-nested-replay (ruling 456)", () => {
  test("two-level nested walk trusts v2 children from one snapshot", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-nested-ok-"));
    try {
      writeChain(ws, [
        {
          id: "r-gchild",
          ts: "2026-01-01T00:00:00.000Z",
          action: "tool.execute",
          tool: "grep",
          argsDigest: "a",
          resultDigest: "b",
          effectId: "eff-gchild",
          schemaVersion: 2,
        },
        {
          id: "r-child",
          ts: "2026-01-01T00:00:01.000Z",
          action: "tool.execute",
          tool: "agent",
          argsDigest: "a",
          resultDigest: "b",
          effectId: "eff-child",
          schemaVersion: 2,
          childEffectIds: ["eff-gchild"],
        },
        {
          id: "r-parent",
          ts: "2026-01-01T00:00:02.000Z",
          action: "tool.execute",
          tool: "agent",
          argsDigest: "a",
          resultDigest: "b",
          effectId: "eff-parent",
          schemaVersion: 2,
          childEffectIds: ["eff-child"],
        },
      ]);
      const verdict = replayNestedChildReceipts(ws, ["eff-child"]);
      expect(verdict.ok).toBe(true);
      expect(verdict.visited).toBe(2);
      expect(verdict.trusted).toBe(2);
      expect(verdict.refused).toBe(0);
      expect(verdict.nodes[0]?.receiptId).toBe("r-child");
      expect(verdict.nodes[0]?.children[0]?.effectId).toBe("eff-gchild");
      expect(verdict.nodes[0]?.children[0]?.evidence).toBe("hash_and_anchor_valid");
      const lines = formatNestedReceiptReplayLines(verdict);
      expect(lines.some((l) => l.includes("nested receipt replay: ok"))).toBe(true);
      expect(lines.some((l) => l.includes("depth 1 effect eff-gchild"))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("depth budget refuses deeper grandchildren without trusting them", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-nested-depth-"));
    try {
      writeChain(ws, [
        {
          id: "r-gchild",
          ts: "2026-01-01T00:00:00.000Z",
          action: "tool.execute",
          tool: "read",
          argsDigest: "a",
          resultDigest: "b",
          effectId: "eff-gchild",
          schemaVersion: 2,
        },
        {
          id: "r-child",
          ts: "2026-01-01T00:00:01.000Z",
          action: "tool.execute",
          tool: "agent",
          argsDigest: "a",
          resultDigest: "b",
          effectId: "eff-child",
          schemaVersion: 2,
          childEffectIds: ["eff-gchild"],
        },
      ]);
      const verdict = replayNestedChildReceipts(ws, ["eff-child"], { maxDepth: 0 });
      expect(verdict.ok).toBe(false);
      expect(verdict.nodes[0]?.evidence).toBe("hash_and_anchor_valid");
      expect(verdict.nodes[0]?.children[0]?.evidence).toBe("depth_exceeded");
      expect(verdict.refused).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("cycle in childEffectIds is refused", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-nested-cycle-"));
    try {
      writeChain(ws, [
        {
          id: "r-a",
          ts: "2026-01-01T00:00:00.000Z",
          action: "tool.execute",
          tool: "agent",
          argsDigest: "a",
          resultDigest: "b",
          effectId: "eff-a",
          schemaVersion: 2,
          childEffectIds: ["eff-b"],
        },
        {
          id: "r-b",
          ts: "2026-01-01T00:00:01.000Z",
          action: "tool.execute",
          tool: "agent",
          argsDigest: "a",
          resultDigest: "b",
          effectId: "eff-b",
          schemaVersion: 2,
          childEffectIds: ["eff-a"],
        },
      ]);
      const verdict = replayNestedChildReceipts(ws, ["eff-a"]);
      expect(verdict.ok).toBe(false);
      expect(verdict.nodes[0]?.evidence).toBe("hash_and_anchor_valid");
      expect(verdict.nodes[0]?.children[0]?.evidence).toBe("hash_and_anchor_valid");
      expect(verdict.nodes[0]?.children[0]?.children[0]?.evidence).toBe("cycle");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("legacy v1 child effectId stays unbound under nested replay", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-nested-v1-"));
    try {
      const file = receiptsPath(ws);
      mkdirSync(path.dirname(file), { recursive: true });
      // v1 row: hash without schemaVersion/effectId binding (effectId sidecar unbound).
      const base = {
        id: "old",
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        prevHash: null as string | null,
        action: "tool.execute",
        tool: "read",
        argsDigest: "a",
        resultDigest: "b",
      };
      const row = { ...base, hash: hashReceipt(base), effectId: "legacy-child" };
      writeFileSync(file, JSON.stringify(row) + "\n");
      writeFileSync(file + ".head", JSON.stringify({ seq: 1, hash: row.hash }));
      const verdict = replayNestedChildReceipts(ws, ["legacy-child"]);
      expect(verdict.ok).toBe(false);
      expect(verdict.nodes[0]?.evidence).toBe("legacy_unbound_effect_id");
      expect(verdict.nodes[0]?.receiptId).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("workspace-wide scan finds parent roots and refuses missing children", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-nested-ws-"));
    try {
      writeChain(ws, [
        {
          id: "r-parent",
          ts: "2026-01-01T00:00:00.000Z",
          action: "tool.execute",
          tool: "agent",
          argsDigest: "a",
          resultDigest: "b",
          effectId: "eff-parent",
          schemaVersion: 2,
          childEffectIds: ["missing-child"],
        },
      ]);
      const verdict = replayNestedReceiptsInWorkspace(ws);
      expect(verdict.ok).toBe(false);
      expect(verdict.rootEffectIds).toEqual(["missing-child"]);
      expect(verdict.nodes[0]?.evidence).toBe("missing_receipt");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("empty roots are ok", () => {
    const verdict = replayNestedChildReceipts("/tmp", []);
    expect(verdict.ok).toBe(true);
    expect(formatNestedReceiptReplayLines(verdict)[0]).toContain("no childEffectIds");
  });
});
