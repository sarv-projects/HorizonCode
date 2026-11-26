import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  canonicalHumanApprovalPayload,
  generateHumanKeyPair,
  humanKeyFingerprint,
  humanKeyPaths,
  signHumanApprovalPayload,
  verifyApproval,
  verifyHumanApprovalPayload,
} from "../../src/core/human-principal-keys";
import {
  HUMAN_APPROVAL_PRINCIPAL,
  mintHumanApprovalGrant,
  mintHumanApprovalLease,
} from "../../src/core/human-approval-principal";
import type { KernelClient } from "../../src/core/kernel";
import type { GuardKind, Lease } from "../../src/contracts";

describe("TS human-principal canonical signing", () => {
  test("canonicalHumanApprovalPayload matches exact byte-for-byte Rust format", () => {
    const payload = canonicalHumanApprovalPayload({
      intentDigest: "abc123def456",
      kind: "fs.write",
      target: "/workspace/file.ts",
      sessionId: "sess-42",
      ttlMs: 60_000,
      nonce: "deadbeef01",
      issuedAt: 1732589445000,
    });
    expect(payload).toBe(
      "hz-human-approval-v1\n" +
        "intent=abc123def456\n" +
        "kind=fs.write\n" +
        "target=/workspace/file.ts\n" +
        "session=sess-42\n" +
        "ttl_ms=60000\n" +
        "nonce=deadbeef01\n" +
        "issued_at=1732589445000",
    );
  });

  test("humanKeyFingerprint returns first 12 lowercase hex chars of SHA-256(publicKeyHex)", () => {
    const pair = generateHumanKeyPair();
    const expected = createHash("sha256").update(pair.publicKeyHex, "utf8").digest("hex").slice(0, 12);
    const fp = humanKeyFingerprint(pair.publicKeyHex);
    expect(fp).toBe(expected);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  test("signHumanApprovalPayload signs canonical payload and rejects field tampering", () => {
    const keyPair = generateHumanKeyPair();
    const signed = signHumanApprovalPayload({
      intentDigest: "intent-sha256-hex",
      kind: "shell.exec",
      target: "bun test",
      sessionId: "sess-sign-1",
      ttlMs: 30_000,
      nonce: "nonce-fixed-1",
      issuedAt: 1700000000123,
      keyPair,
    });

    expect(signed.humanPubKeyHex).toBe(keyPair.publicKeyHex);
    expect(signed.humanNonce).toBe("nonce-fixed-1");
    expect(signed.humanIssuedAt).toBe(1700000000123);
    expect(signed.fingerprint).toBe(humanKeyFingerprint(keyPair.publicKeyHex));

    const baseInput = {
      intentDigest: "intent-sha256-hex",
      kind: "shell.exec",
      target: "bun test",
      sessionId: "sess-sign-1",
      ttlMs: 30_000,
      nonce: signed.humanNonce,
      issuedAt: signed.humanIssuedAt,
    };
    expect(verifyHumanApprovalPayload(baseInput, signed.humanPubKeyHex, signed.humanSig)).toBe(true);
    expect(verifyApproval(signed.humanPubKeyHex, canonicalHumanApprovalPayload(baseInput), signed.humanSig)).toBe(true);

    // Tampering any field must fail verification
    expect(verifyHumanApprovalPayload({ ...baseInput, target: "rm -rf /" }, signed.humanPubKeyHex, signed.humanSig)).toBe(false);
    expect(verifyHumanApprovalPayload({ ...baseInput, ttlMs: 99_999 }, signed.humanPubKeyHex, signed.humanSig)).toBe(false);
    expect(verifyHumanApprovalPayload({ ...baseInput, sessionId: "other" }, signed.humanPubKeyHex, signed.humanSig)).toBe(false);
    expect(verifyHumanApprovalPayload({ ...baseInput, nonce: "replay" }, signed.humanPubKeyHex, signed.humanSig)).toBe(false);
  });

  test("mintHumanApprovalLease and mintHumanApprovalGrant attach verified signature fields to kernel opts", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "hz-sign-mint-"));
    try {
      const leaseCalls: Array<{ args: unknown[] }> = [];
      const grantCalls: Array<{ args: unknown[] }> = [];
      const fakeKernel = {
        makeLease: async (
          kind: GuardKind,
          pattern: string,
          ttlMs: number,
          sessionId?: string,
          opts?: Record<string, unknown>,
        ): Promise<Lease> => {
          leaseCalls.push({ args: [kind, pattern, ttlMs, sessionId, opts] });
          return {
            leaseId: "lease-1",
            kind,
            pattern,
            expiry: new Date(Date.now() + ttlMs).toISOString(),
            owner: `human:${sessionId}`,
            principal: HUMAN_APPROVAL_PRINCIPAL,
          };
        },
        makeGrant: async (
          kind: GuardKind,
          pattern: string,
          ttlMs: number,
          sessionId?: string,
          opts?: Record<string, unknown>,
        ): Promise<Lease> => {
          grantCalls.push({ args: [kind, pattern, ttlMs, sessionId, opts] });
          return {
            leaseId: "grant-1",
            kind,
            pattern,
            expiry: new Date(Date.now() + ttlMs).toISOString(),
            owner: `human:${sessionId}`,
            principal: HUMAN_APPROVAL_PRINCIPAL,
          };
        },
      } as unknown as KernelClient;

      await mintHumanApprovalLease(fakeKernel, "fs.write", "/ws/a.ts", "sess-1", 60_000, {
        home,
        intentDigest: "digest-lease-1",
        nonce: "n-lease",
        issuedAt: 1700000001000,
      });
      expect(leaseCalls.length).toBe(1);
      const leaseOpts = leaseCalls[0]!.args[4] as Record<string, unknown>;
      expect(leaseOpts.principal).toBe(HUMAN_APPROVAL_PRINCIPAL);
      expect(typeof leaseOpts.humanSig).toBe("string");
      expect(typeof leaseOpts.humanPubKeyHex).toBe("string");
      expect(leaseOpts.humanNonce).toBe("n-lease");
      expect(leaseOpts.humanIssuedAt).toBe(1700000001000);
      expect(
        verifyHumanApprovalPayload(
          {
            intentDigest: "digest-lease-1",
            kind: "fs.write",
            target: "/ws/a.ts",
            sessionId: "sess-1",
            ttlMs: 60_000,
            nonce: "n-lease",
            issuedAt: 1700000001000,
          },
          String(leaseOpts.humanPubKeyHex),
          String(leaseOpts.humanSig),
        ),
      ).toBe(true);

      await mintHumanApprovalGrant(fakeKernel, "mcp.invoke", "crm:lookup", "sess-1", 120_000, {
        home,
        intentDigest: "digest-grant-1",
        nonce: "n-grant",
        issuedAt: 1700000002000,
      });
      expect(grantCalls.length).toBe(1);
      const grantOpts = grantCalls[0]!.args[4] as Record<string, unknown>;
      expect(grantOpts.principal).toBe(HUMAN_APPROVAL_PRINCIPAL);
      expect(
        verifyHumanApprovalPayload(
          {
            intentDigest: "digest-grant-1",
            kind: "mcp.invoke",
            target: "crm:lookup",
            sessionId: "sess-1",
            ttlMs: 120_000,
            nonce: "n-grant",
            issuedAt: 1700000002000,
          },
          String(grantOpts.humanPubKeyHex),
          String(grantOpts.humanSig),
        ),
      ).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("mintHumanApprovalLease stays backwards-compatible when keypair cannot be loaded", async () => {
    const hostile = mkdtempSync(path.join(tmpdir(), "hz-sign-symlink-"));
    try {
      const paths = humanKeyPaths(hostile);
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(path.join(hostile, "outside.key"), "outside");
      symlinkSync(path.join(hostile, "outside.key"), paths.privateKey);

      let receivedOpts: Record<string, unknown> | undefined;
      const fakeKernel = {
        makeLease: async (
          kind: GuardKind,
          pattern: string,
          ttlMs: number,
          sessionId?: string,
          opts?: Record<string, unknown>,
        ): Promise<Lease> => {
          receivedOpts = opts;
          return {
            leaseId: "lease-fallback",
            kind,
            pattern,
            expiry: new Date(Date.now() + ttlMs).toISOString(),
            owner: `human:${sessionId}`,
            principal: HUMAN_APPROVAL_PRINCIPAL,
          };
        },
      } as unknown as KernelClient;

      const lease = await mintHumanApprovalLease(fakeKernel, "fs.write", "/ws/b.ts", "sess-2", 60_000, {
        home: hostile,
      });
      expect(lease.principal).toBe(HUMAN_APPROVAL_PRINCIPAL);
      expect(receivedOpts).toEqual({ principal: HUMAN_APPROVAL_PRINCIPAL });
    } finally {
      rmSync(hostile, { recursive: true, force: true });
    }
  });
});
