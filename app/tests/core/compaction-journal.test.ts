import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  appendCompactionRecord,
  compactionsLedgerPath,
} from "../../src/core/compaction-journal";
import { verifyCompactionAnchorSync } from "../../src/core/chain-anchor-verify";
import { sha256Hex } from "../../src/core/canon";

describe("compaction-journal (ruling 296)", () => {
  test("append writes CompactionRecordV1 chain with head", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-compact-journal-"));
    try {
      const summaryDigest = sha256Hex("summary block");
      const r1 = appendCompactionRecord(ws, {
        sessionId: "sess-1",
        trigger: "history-window",
        tokensBefore: 100,
        tokensAfter: 40,
        dropped: 8,
        kept: 4,
        window: 12,
        summaryDigest,
      });
      expect(r1?.seq).toBe(1);
      const file = compactionsLedgerPath(ws);
      expect(existsSync(file)).toBe(true);
      expect(existsSync(`${file}.head`)).toBe(true);
      const v = verifyCompactionAnchorSync(file);
      expect(v.ok).toBe(true);
      expect(v.count).toBe(1);
      const r2 = appendCompactionRecord(ws, {
        trigger: "hold-swap",
        tokensBefore: 90,
        tokensAfter: 35,
        dropped: 6,
        kept: 4,
        window: 12,
        summaryDigest,
      });
      expect(r2?.seq).toBe(2);
      expect(r2?.prevHash).toBe(r1?.hash);
      expect(verifyCompactionAnchorSync(file).count).toBe(2);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("verify fails when CompactionRecordV1 row is tampered", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-compact-tamper-"));
    try {
      appendCompactionRecord(ws, {
        trigger: "emergency-context-window",
        tokensBefore: 1,
        tokensAfter: 1,
        dropped: 0,
        kept: 1,
        window: 1,
        summaryDigest: sha256Hex("x"),
      });
      const ledger = compactionsLedgerPath(ws);
      const tampered = readFileSync(ledger, "utf8").replace(`"dropped":0`, `"dropped":9`);
      writeFileSync(ledger, tampered);
      expect(verifyCompactionAnchorSync(ledger).ok).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
