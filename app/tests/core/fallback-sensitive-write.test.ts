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
});
