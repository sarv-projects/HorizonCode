import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { hashReceipt } from "../../src/contracts";
import { EffectHost, createEffectId } from "../../src/core/effect-host";
import { WorkspaceEffectLedger } from "../../src/core/effect-ledger";
import { SessionStore } from "../../src/core/session";
import { receiptsPath } from "../../src/core/session-kernel-reconcile";
import {
  SESSION_VERIFY_FAIL_EXIT,
  buildSessionVerifyReport,
  renderSessionVerify,
  sessionVerifyExitCode,
} from "../../src/core/session-verify-cli";

describe("session-verify-cli (ruling 291)", () => {
  test("ok session exits 0", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-sess-verify-ok-"));
    try {
      const store = new SessionStore(ws);
      const session = store.createSession("verify-ok");
      const host = new EffectHost(new WorkspaceEffectLedger(ws));
      const id = createEffectId();
      host.begin(id, "read", "c1");
      host.recordAllow(id);
      host.recordExecute(id, { ok: true });
      host.recordObserve(id, { receiptId: "r1", receiptSeq: 1 });
      host.persistRecord(id, "settled");
      const report = buildSessionVerifyReport(ws, session.id);
      expect(report.ok).toBe(true);
      expect(sessionVerifyExitCode(report)).toBe(0);
      expect(renderSessionVerify(report)).toContain("verdict: verified");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("broken receipt chain exits 3 with brokenAt", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-sess-verify-brk-"));
    try {
      const store = new SessionStore(ws);
      const session = store.createSession("verify-broken");
      const base = {
        id: "r1",
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        prevHash: "bad",
        action: "tool.execute" as const,
        tool: "read",
        argsDigest: "a",
        resultDigest: "b",
      };
      const file = receiptsPath(ws);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ ...base, hash: hashReceipt({ ...base, prevHash: null }) })}\n`);
      const report = buildSessionVerifyReport(ws, session.id);
      expect(report.chain.ok).toBe(false);
      expect(report.ok).toBe(false);
      expect(sessionVerifyExitCode(report)).toBe(SESSION_VERIFY_FAIL_EXIT);
      expect(renderSessionVerify(report)).toContain("brokenAt seq");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("truncated receipt anchor exits 3", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-sess-verify-anchor-"));
    try {
      const store = new SessionStore(ws);
      const session = store.createSession("verify-anchor");
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
      writeFileSync(file, "");
      const report = buildSessionVerifyReport(ws, session.id);
      expect(report.chain.ok).toBe(false);
      expect(sessionVerifyExitCode(report)).toBe(SESSION_VERIFY_FAIL_EXIT);
      expect(renderSessionVerify(report)).toContain("compaction chain");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("reconcile probe mismatch exits 3", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-sess-verify-mis-"));
    try {
      const store = new SessionStore(ws);
      const session = store.createSession("verify-mismatch");
      const host = new EffectHost(new WorkspaceEffectLedger(ws));
      const id = createEffectId();
      host.begin(id, "write", "c1");
      host.recordAllow(id);
      host.recordExecute(id, { ok: true });
      host.recordObserve(id, { receiptId: "r1", receiptSeq: 1 });
      host.persistRecord(id, "unknown");
      const report = buildSessionVerifyReport(ws, session.id);
      expect(report.reconcile.mismatches.length).toBeGreaterThan(0);
      expect(sessionVerifyExitCode(report)).toBe(SESSION_VERIFY_FAIL_EXIT);
      expect(renderSessionVerify(report)).toContain("reconcile mismatches");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
