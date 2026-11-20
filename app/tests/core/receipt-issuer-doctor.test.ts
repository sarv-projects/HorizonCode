import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessReceiptIssuerDoctorPosture,
  formatReceiptIssuerDoctorDetail,
} from "../../src/core/receipt-issuer-doctor";
import { checkReceiptIssuerAttestation, type DoctorEnv } from "../../src/core/doctor";
import {
  issuerStampForHash,
  RECEIPT_ISSUER_KEY_FILE,
} from "../../src/core/receipt-issuer-verify";
import { hashReceiptVersioned } from "../../src/core/receipt-schema";
import { kernelStateDir } from "../../src/core/paths";
import { receiptsPath } from "../../src/core/session-kernel-reconcile";

const TEST_KEY = Buffer.alloc(32, 0x42);

function fakeEnv(workspace: string): DoctorEnv {
  return {
    env: { HOME: "/tmp" },
    stdinIsTTY: false,
    stdoutIsTTY: false,
    workspace,
    home: "/tmp",
  };
}

describe("receipt issuer doctor (ruling 725)", () => {
  test("WARN when parentReceiptId without key", () => {
    const root = mkdtempSync(join(tmpdir(), "hz-issuer-doc-warn-"));
    try {
      const body = {
        id: "rcp_c",
        seq: 1,
        ts: "2026-11-19T00:00:00Z",
        action: "tool.execute" as const,
        tool: "agent",
        argsDigest: "a",
        resultDigest: "b",
        prevHash: null,
        schemaVersion: 2 as const,
        effectId: "fx",
        parentReceiptId: "rcp_p",
      };
      const hash = hashReceiptVersioned(body as unknown as Record<string, unknown>);
      const file = receiptsPath(root);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ ...body, hash })}\n`);
      const line = checkReceiptIssuerAttestation(fakeEnv(root));
      expect(line.id).toBe("receipt.issuer");
      expect(line.status).toBe("warn");
      expect(formatReceiptIssuerDoctorDetail(assessReceiptIssuerDoctorPosture(root))).toMatch(/absent/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("OK when stamped nested receipt and key present", () => {
    const root = mkdtempSync(join(tmpdir(), "hz-issuer-doc-ok-"));
    try {
      const kdir = kernelStateDir(root);
      mkdirSync(kdir, { recursive: true });
      writeFileSync(join(kdir, RECEIPT_ISSUER_KEY_FILE), TEST_KEY.toString("hex"), { mode: 0o600 });
      const body = {
        id: "rcp_c",
        seq: 1,
        ts: "2026-11-19T00:00:00Z",
        action: "tool.execute" as const,
        tool: "agent",
        argsDigest: "a",
        resultDigest: "b",
        prevHash: null,
        schemaVersion: 2 as const,
        effectId: "fx",
        parentReceiptId: "rcp_p",
      };
      const hash = hashReceiptVersioned(body as unknown as Record<string, unknown>);
      const stamped = { ...body, hash, issuerStamp: issuerStampForHash(TEST_KEY, hash) };
      const file = receiptsPath(root);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, `${JSON.stringify(stamped)}\n`);
      const posture = assessReceiptIssuerDoctorPosture(root);
      expect(posture.attestationOk).toBe(true);
      expect(checkReceiptIssuerAttestation(fakeEnv(root)).status).toBe("ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});