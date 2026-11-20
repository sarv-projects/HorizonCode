import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  receiptLinksForAutoEmit,
  tryAutoEmitVerificationArtifactSessionVerify,
  tryAutoEmitVerificationArtifactTurn,
  verificationArtifactAutoEmitEnabled,
} from "../../src/core/verification-artifact-auto";
import type { SessionVerifyReport } from "../../src/core/session-verify-cli";

describe("verification-artifact auto-emit (ruling 708)", () => {
  test("verificationArtifactAutoEmitEnabled is off by default", () => {
    expect(verificationArtifactAutoEmitEnabled({})).toBe(false);
    expect(verificationArtifactAutoEmitEnabled({ HZ_VERIFY_ARTIFACT_AUTO_EMIT: "1" })).toBe(true);
  });

  test("turn auto-emit skipped when env unset", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-vaa-off-"));
    try {
      const res = await tryAutoEmitVerificationArtifactTurn({
        workspace: dir,
        sessionId: "s1",
        goal: "ship",
        exitTerminal: "succeeded",
        changedPaths: ["a.ts"],
        env: {},
      });
      expect(res).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("turn auto-emit fail-closed on non-succeeded exit", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-vaa-fail-"));
    try {
      const res = await tryAutoEmitVerificationArtifactTurn({
        workspace: dir,
        sessionId: "s1",
        goal: "ship",
        exitTerminal: "failed",
        changedPaths: [],
        env: { HZ_VERIFY_ARTIFACT_AUTO_EMIT: "1" },
      });
      expect(res?.emitted).toBe(false);
      if (res && !res.emitted) expect(res.reason).toContain("succeeded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("turn auto-emit persists on succeeded empty workspace", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-vaa-turn-"));
    try {
      const res = await tryAutoEmitVerificationArtifactTurn({
        workspace: dir,
        sessionId: "sess-abc",
        goal: "fix login",
        exitTerminal: "succeeded",
        changedPaths: ["src/login.ts"],
        verifiedCommand: "bun test login.test.ts",
        env: { HZ_VERIFY_ARTIFACT_AUTO_EMIT: "1" },
      });
      expect(res?.emitted).toBe(true);
      if (res?.emitted) {
        expect(existsSync(res.path)).toBe(true);
        const loaded = JSON.parse(readFileSync(res.path, "utf8"));
        expect(loaded.schema).toBe("hz.verification.artifact.v1");
        expect(loaded.goal).toBe("fix login");
        expect(loaded.testOutput).toContain("bun test");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("receiptLinksForAutoEmit empty when no receipts file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-vaa-rc-"));
    try {
      expect(receiptLinksForAutoEmit(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session verify auto-emit fail-closed when report not ok", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-vaa-sv-"));
    try {
      const report: SessionVerifyReport = {
        workspace: dir,
        sessionId: "s1",
        sessionFound: true,
        chain: { ok: false, count: 0, brokenAt: 1 },
        compactionChains: [],
        reconcile: { workspace: dir, effectsScanned: 0, rows: [], mismatches: [] },
        evidence: { workspace: dir, effectsScanned: 0, failures: [] },
        postimageReplayEnabled: false,
        nestedReceipts: {
          ok: true,
          rootEffectIds: [],
          nodes: [],
          visited: 0,
          trusted: 0,
          refused: 0,
          maxDepth: 0,
          residual: "",
        },
        nestedEventStreams: {
          ok: true,
          rootSessionId: "s1",
          nodes: [],
          visited: 0,
          trusted: 0,
          refused: 0,
          maxDepth: 0,
          residual: "",
        },
        openUnknownCount: 0,
        ok: false,
      };
      const res = await tryAutoEmitVerificationArtifactSessionVerify(
        dir,
        report,
        { HZ_VERIFY_ARTIFACT_AUTO_EMIT: "1" },
      );
      expect(res?.emitted).toBe(false);
      if (res && !res.emitted) expect(res.reason).toContain("not ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});