import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { hashReceipt } from "../../src/contracts";
import {
  readHeadSync,
  verifyCompactionAnchorSync,
  verifyReceiptAnchorSync,
  verifySessionEventAnchorSync,
} from "../../src/core/chain-anchor-verify";
import { kernelStateDir } from "../../src/core/paths";
import { receiptsPath } from "../../src/core/session-kernel-reconcile";

describe("chain-anchor-verify (ruling 294)", () => {
  test("receipt anchor detects truncated tail", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-anchor-rcpt-"));
    try {
      const base = {
        id: "r1",
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        prevHash: null as string | null,
        action: "tool.execute" as const,
        tool: "read",
        argsDigest: "a",
        resultDigest: "b",
      };
      const r1 = { ...base, hash: hashReceipt(base) };
      const file = receiptsPath(ws);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(r1)}\n`);
      writeFileSync(`${file}.head`, `${JSON.stringify({ seq: 1, hash: r1.hash })}\n`);
      expect(verifyReceiptAnchorSync(ws).ok).toBe(true);
      writeFileSync(file, "");
      expect(verifyReceiptAnchorSync(ws).ok).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("session events anchor skipped when log missing", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-anchor-sess-"));
    try {
      const v = verifySessionEventAnchorSync(ws, "sess-missing");
      expect(v.skipped).toBe(true);
      expect(v.ok).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("legacy compaction chain line-count head", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-anchor-compact-"));
    try {
      const file = `${kernelStateDir(ws)}/compactions.jsonl`;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ id: "c1" })}\n${JSON.stringify({ id: "c2" })}\n`);
      writeFileSync(`${file}.head`, `${JSON.stringify({ seq: 2, hash: "ab".repeat(32) })}\n`);
      const v = verifyCompactionAnchorSync(file);
      expect(v.ok).toBe(true);
      expect(readHeadSync(file)?.seq).toBe(2);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
