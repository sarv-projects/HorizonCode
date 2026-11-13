import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EventTypes } from "../../src/contracts";
import { EffectHost, createEffectId } from "../../src/core/effect-host";
import { probeEffectEvidence } from "../../src/core/effect-evidence-gate";
import { WorkspaceEffectLedger } from "../../src/core/effect-ledger";
import { sessionEventsPath } from "../../src/core/session-kernel-reconcile";
import {
  SESSION_VERIFY_FAIL_EXIT,
  buildSessionVerifyReport,
  sessionVerifyExitCode,
} from "../../src/core/session-verify-cli";
import { SessionStore } from "../../src/core/session";

describe("effect-evidence-gate (ruling 295)", () => {
  test("detects observe-step evidence flags on durable ledger", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-ev-gate-"));
    try {
      const host = new EffectHost(new WorkspaceEffectLedger(ws));
      const id = createEffectId();
      host.begin(id, "write", "c1");
      host.recordAllow(id);
      host.recordExecute(id, { ok: true });
      host.recordObserve(id, {
        receiptId: "r1",
        receiptSeq: 1,
        resultDigestEvidenceStable: false,
      });
      host.persistRecord(id, "unknown");
      const report = probeEffectEvidence(ws);
      expect(report.failures.some((f) => f.effectId === id && f.kind === "result_digest_unstable")).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("session receipt.issued events contribute failures", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-ev-gate-ev-"));
    try {
      const sid = "sess-ev";
      const id = createEffectId();
      const evFile = sessionEventsPath(ws, sid);
      mkdirSync(path.dirname(evFile), { recursive: true });
      writeFileSync(
        evFile,
        JSON.stringify({
          id: "ev1",
          seq: 1,
          type: EventTypes.receiptIssued,
          payload: {
            effectId: id,
            tool: "write",
            receiptId: "r-ev",
            postimageMissingAtObserve: true,
          },
        }) + "\n",
      );
      const report = probeEffectEvidence(ws, { sessionId: sid });
      expect(report.failures.some((f) => f.effectId === id && f.kind === "postimage_missing")).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("session verify exits 3 on evidence failure", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-ev-gate-verify-"));
    try {
      const store = new SessionStore(ws);
      const session = store.createSession("ev-fail");
      const host = new EffectHost(new WorkspaceEffectLedger(ws));
      const id = createEffectId();
      host.begin(id, "read", "c1");
      host.recordAllow(id);
      host.recordExecute(id, { ok: true });
      host.recordObserve(id, {
        receiptId: "r1",
        receiptSeq: 1,
        postimageMissingAtObserve: true,
      });
      host.persistRecord(id, "settled");
      const report = buildSessionVerifyReport(ws, session.id);
      expect(report.evidence.failures.length).toBeGreaterThan(0);
      expect(sessionVerifyExitCode(report)).toBe(SESSION_VERIFY_FAIL_EXIT);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
