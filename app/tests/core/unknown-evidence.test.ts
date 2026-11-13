import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EffectHost } from "../../src/core/effect-host";
import { buildUnknownEvidenceBundle, writeUnknownEvidenceBundle } from "../../src/core/unknown-evidence";
import { receiptsPath } from "../../src/core/session-kernel-reconcile";
import { kernelStateDir } from "../../src/core/paths";

describe("unknown evidence export (ruling 282)", () => {
  test("writes bundle under state exports", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-unknown-ev-"));
    try {
      mkdirSync(kernelStateDir(workspace), { recursive: true });
      const host = new EffectHost();
      const id = "00000000-0000-4000-8000-0000000000aa";
      host.begin(id, "write", "call-1");
      host.recordAllow(id);
      host.recordExecute(id, { ok: true });
      const receipt = {
        id: "rcpt-test-1",
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        prevHash: null,
        hash: "abc",
        action: "tool.execute",
        tool: "write",
        argsDigest: "a".repeat(64),
        resultDigest: "b".repeat(64),
        effectId: id,
      };
      writeFileSync(receiptsPath(workspace), JSON.stringify(receipt) + "\n");
      const bundle = buildUnknownEvidenceBundle({
        workspace,
        sessionId: "sess-1",
        rows: [{ effectId: id, tool: "write", callId: "call-1", receiptId: receipt.id }],
        getRecord: (e) => host.getRecord(e),
        exportedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(bundle.effects).toHaveLength(1);
      expect(bundle.effects[0]?.receipt?.id).toBe("rcpt-test-1");
      const out = writeUnknownEvidenceBundle(workspace, bundle);
      expect(out).toContain("unknown-evidence");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
