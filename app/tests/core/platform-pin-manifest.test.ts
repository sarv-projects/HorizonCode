/**
 * platform-pin-manifest.test.ts — a per-platform pin without touching the shared one.
 *
 * `kernel/kernel.sha256` pins one digest, which on a multi-platform release can
 * only match one build. A `kernel/kernel.sha256.<platform>` file now takes
 * precedence for that platform, so Windows can pin its own binary while the
 * shared manifest keeps pinning the Linux release.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { kernelPinManifestPath, verifyKernelPin } from "../../src/core/kernel-pin";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function repoWithManifests(baseDigest: string, platformDigest: string | undefined): { root: string; binary: string; digest: string } {
  dir = mkdtempSync(path.join(tmpdir(), "hz-pin-"));
  mkdirSync(path.join(dir, "kernel"), { recursive: true });
  const binary = path.join(dir, "hz-kernel.exe");
  writeFileSync(binary, "binary bytes");
  const digest = createHash("sha256").update("binary bytes").digest("hex");
  writeFileSync(path.join(dir, "kernel", "kernel.sha256"), baseDigest + "  hz-kernel\n");
  if (platformDigest !== undefined) {
    writeFileSync(path.join(dir, "kernel", "kernel.sha256.win32"), platformDigest + "  hz-kernel.exe\n");
  }
  return { root: dir, binary, digest };
}

describe("platform-specific pin manifest", () => {
  test("the platform manifest takes precedence when it exists", () => {
    const { root, binary, digest } = repoWithManifests("a".repeat(64), undefined);
    // create it after computing the digest
    writeFileSync(path.join(root, "kernel", "kernel.sha256.win32"), digest + "  hz-kernel.exe\n");
    expect(kernelPinManifestPath(root, "win32")).toBe(path.join(root, "kernel", "kernel.sha256.win32"));
    const res = verifyKernelPin({ binary, repoRoot: root, platform: "win32", env: {} });
    expect(res.status).toBe("verified");
    expect(res.source).toBe("manifest");
  });

  test("another platform falls back to the shared manifest", () => {
    const { root, binary, digest } = repoWithManifests("b".repeat(64), "c".repeat(64));
    expect(kernelPinManifestPath(root, "linux")).toBe(path.join(root, "kernel", "kernel.sha256"));
    const res = verifyKernelPin({ binary, repoRoot: root, platform: "linux", env: {} });
    expect(res.status).toBe("mismatch");
  });
});
