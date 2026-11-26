/**
 * cross-platform-kernel-resolution.test.ts — the kernel binary resolver must know
 * the platform suffix. On Windows cargo emits `hz-kernel.exe`; looking only for
 * `hz-kernel` made the product silently untrusted (read-only) on a platform
 * where the owner fence now works.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { kernelBinaryCandidates } from "../../src/core/kernel";

const root = path.resolve("/repo");

describe("kernel binary candidates", () => {
  test("win32 prefers the .exe build, release before debug", () => {
    const list = kernelBinaryCandidates(root, "win32");
    expect(list[0]).toBe(path.join(root, "kernel", "target", "release", "hz-kernel.exe"));
    expect(list).toContain(path.join(root, "kernel", "target", "debug", "hz-kernel.exe"));
  });

  test("unix has no suffix", () => {
    const list = kernelBinaryCandidates(root, "linux");
    expect(list[0]).toBe(path.join(root, "kernel", "target", "release", "hz-kernel"));
    expect(list.some((p) => p.endsWith(".exe"))).toBe(false);
  });
});
