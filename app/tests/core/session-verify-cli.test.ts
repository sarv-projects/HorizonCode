import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { hashEnvelope, hashReceipt } from "../../src/contracts";
import { EffectHost, createEffectId } from "../../src/core/effect-host";
import { WorkspaceEffectLedger } from "../../src/core/effect-ledger";
import { hashReceiptVersioned } from "../../src/core/receipt-schema";
import { SessionStore } from "../../src/core/session";
import { receiptsPath, sessionEventsPath } from "../../src/core/session-kernel-reconcile";
import {
  SESSION_VERIFY_FAIL_EXIT,
  buildSessionVerifyReport,
  renderSessionVerify,
  sessionVerifyExitCode,
} from "../../src/core/session-verify-cli";

function writeChainedSession(
  ws: string,
  sessionId: string,
  entries: { type: string; payload: Record<string, unknown> }[],
): void {
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
}

/** Windows keeps SQLite handles briefly after close(); retry before failing. */
function cleanupWorkspace(ws: string): void {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      rmSync(ws, { recursive: true, force: true });
      return;
    } catch {
      // Best effort: a Windows SQLite handle may keep the temp dir locked
      // until process exit. Temp cleanup is not a product assertion.
      Bun.sleepSync(50);
    }
  }
}

describe("session verify strict keyed posture (ruling 754)", () => {
  test("report and rendering name whether HZ_R172_REQUIRE_KEYED was used", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-sess-strict-"));
    try {
      const plain = buildSessionVerifyReport(ws, "strict-session");
      expect(plain.strictKeyed).toBe(false);
      process.env.HZ_R172_REQUIRE_KEYED = "1";
      try {
        const strict = buildSessionVerifyReport(ws, "strict-session");
        expect(strict.strictKeyed).toBe(true);
        expect(renderSessionVerify(strict)).toContain("strict keyed verify: on");
      } finally {
        delete process.env.HZ_R172_REQUIRE_KEYED;
      }
    } finally {
      cleanupWorkspace(ws);
    }
  });
});

describe("session-verify-cli (ruling 291)", () => {
  test("ok session exits 0", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-sess-verify-ok-"));
    let store: SessionStore | undefined;
    try {
      store = new SessionStore(ws);
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
      store?.close();
      cleanupWorkspace(ws);
    }
  });

  test("broken receipt chain exits 3 with brokenAt", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-sess-verify-brk-"));
    let store: SessionStore | undefined;
    try {
      store = new SessionStore(ws);
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
      store?.close();
      cleanupWorkspace(ws);
    }
  });

  test("truncated receipt anchor exits 3", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-sess-verify-anchor-"));
    let store: SessionStore | undefined;
    try {
      store = new SessionStore(ws);
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
      store?.close();
      cleanupWorkspace(ws);
    }
  });

  test("reconcile probe mismatch exits 3", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-sess-verify-mis-"));
    let store: SessionStore | undefined;
    try {
      store = new SessionStore(ws);
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
      store?.close();
      cleanupWorkspace(ws);
    }
  });

  test("nested childEffectIds missing receipt exits 3 (ruling 456)", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-sess-verify-nested-"));
    let store: SessionStore | undefined;
    try {
      store = new SessionStore(ws);
      const session = store.createSession("verify-nested");
      const base = {
        id: "r-parent",
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        prevHash: null as string | null,
        action: "tool.execute" as const,
        tool: "agent",
        argsDigest: "a",
        resultDigest: "b",
        effectId: "eff-parent",
        schemaVersion: 2 as const,
        childEffectIds: ["missing-child"],
      };
      const row = { ...base, hash: hashReceiptVersioned(base) };
      const file = receiptsPath(ws);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(row)}\n`);
      writeFileSync(file + ".head", JSON.stringify({ seq: 1, hash: row.hash }));
      const report = buildSessionVerifyReport(ws, session.id);
      expect(report.chain.ok).toBe(true);
      expect(report.nestedReceipts.ok).toBe(false);
      expect(sessionVerifyExitCode(report)).toBe(SESSION_VERIFY_FAIL_EXIT);
      expect(renderSessionVerify(report)).toContain("nested receipt replay: refused");
    } finally {
      store?.close();
      cleanupWorkspace(ws);
    }
  });

  test("nested child event-stream missing exits 3 (ruling 478)", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-sess-verify-evt-"));
    let store: SessionStore | undefined;
    try {
      store = new SessionStore(ws);
      const session = store.createSession("verify-evt");
      writeChainedSession(ws, session.id, [
        { type: "subagent.start", payload: { agentId: "missing-nested-child", task: "t" } },
      ]);
      const report = buildSessionVerifyReport(ws, session.id);
      expect(report.nestedEventStreams.ok).toBe(false);
      expect(report.nestedEventStreams.nodes[0]?.evidence).toBe("missing_stream");
      expect(sessionVerifyExitCode(report)).toBe(SESSION_VERIFY_FAIL_EXIT);
      expect(renderSessionVerify(report)).toContain("nested event-stream replay: refused");
    } finally {
      store?.close();
      cleanupWorkspace(ws);
    }
  });
});
