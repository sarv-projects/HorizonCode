import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { sha256Hex } from "../../src/core/canon";
import {
  assessPostimageMissingAtObserve,
  assessResultDigestEvidence,
  observeCapturedShellStreamDigest,
  shellExecResultDigestStable,
  toolResultDigest,
} from "../../src/core/effect-evidence";

describe("effect evidence (ruling 257)", () => {
  test("toolResultDigest matches string output", () => {
    expect(toolResultDigest({ ok: true, output: "hello" })).toBe(sha256Hex("hello"));
  });

  test("assessResultDigestEvidence stable when claim matches output", () => {
    const result = { ok: true, output: "x" };
    const d = toolResultDigest(result);
    expect(assessResultDigestEvidence(d, result).stable).toBe(true);
  });

  test("assessResultDigestEvidence unstable on mismatch", () => {
    const result = { ok: true, output: "x" };
    expect(assessResultDigestEvidence("f".repeat(64), result).stable).toBe(false);
  });

  test("shell stream digest double-hash stable (ruling 314)", () => {
    const obs = observeCapturedShellStreamDigest(Buffer.from("hello\n"));
    expect(obs.observationStable).toBe(true);
    expect(obs.digest).toBe(sha256Hex("hello\n"));
    expect(shellExecResultDigestStable(obs, observeCapturedShellStreamDigest(Buffer.alloc(0)))).toBe(
      true,
    );
  });

  test("missing postimage file when write ok", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-ev-"));
    try {
      const miss = assessPostimageMissingAtObserve("write", { path: "nope.txt" }, ws, true);
      expect(miss.missing).toBe(true);
      expect(miss.path).toBe(path.join(ws, "nope.txt"));
      expect(assessPostimageMissingAtObserve("read", { path: "nope.txt" }, ws, true).missing).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
