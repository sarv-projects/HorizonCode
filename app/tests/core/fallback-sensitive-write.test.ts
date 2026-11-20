import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { LocalKernel, isSensitiveWriteTarget } from "../../src/core/kernel";

describe("LocalKernel sensitive-write mirror", () => {
  test("execution-bearing paths ask even when workspace writes are allowed", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "hz-sensitive-fallback-"));
    const kernel = new LocalKernel({ stateDir: path.join(root, "state"), workspace: root });
    try {
      for (const rel of [
        ".git/hooks/pre-commit",
        ".git/config",
        ".env",
        ".env.local",
        "package.json",
        "bun.lock",
        "Cargo.lock",
        ".github/workflows/ci.yml",
        "Makefile",
        "Dockerfile",
        ".bashrc",
      ]) {
        const decision = await kernel.checkGuard(
          { kind: "fs.write", target: path.join(root, rel) },
          "workspace",
        );
        expect(decision.decision).toBe("ask");
        expect(decision.reason ?? "").toContain("sensitive-write");
      }
      const normal = await kernel.checkGuard(
        { kind: "fs.write", target: path.join(root, "src/index.ts") },
        "workspace",
      );
      expect(normal.decision).toBe("allow");
      expect(isSensitiveWriteTarget(path.join(root, "src/index.ts"))).toBe(false);
    } finally {
      await kernel.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exact one-use lease clears sensitive-write; wildcard does not", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "hz-sensitive-lease-"));
    const kernel = new LocalKernel({ stateDir: path.join(root, "state"), workspace: root });
    try {
      const target = path.join(root, "package.json");
      const wild = await kernel.makeLease("fs.write", "*", 60_000);
      const stillAsk = await kernel.checkGuard({ kind: "fs.write", target }, "workspace");
      expect(stillAsk.decision).toBe("ask");
      expect(stillAsk.reason ?? "").toContain("sensitive-write");

      const exact = await kernel.makeLease("fs.write", target, 60_000);
      const allowed = await kernel.checkGuard({ kind: "fs.write", target }, "workspace");
      expect(allowed.decision).toBe("allow");
      expect(allowed.leaseId).toBe(exact.leaseId);
      expect(allowed.reason ?? "").toContain("exact");

      const again = await kernel.checkGuard({ kind: "fs.write", target }, "workspace");
      expect(again.decision).toBe("ask");
      void wild;
    } finally {
      await kernel.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
