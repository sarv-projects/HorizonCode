/** MEMORY.md writes need approval even when policy allows (docs/33 §5.4). */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  isMemoryManifestWrite,
  LocalKernel,
  memoryManifestPathForStateDir,
} from "../../src/core/kernel";
import { kernelStateDir, stateRoot } from "../../src/core/paths";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

function ws(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-mem-guard-"));
  roots.push(dir);
  return dir;
}

describe("memory manifest guard", () => {
  test("isMemoryManifestWrite detects .hz/MEMORY.md", () => {
    const dir = ws();
    const stateDir = kernelStateDir(dir);
    mkdirSync(stateDir, { recursive: true });
    const manifest = memoryManifestPathForStateDir(stateDir);
    expect(manifest).toBe(path.join(stateRoot(dir), "MEMORY.md"));
    expect(
      isMemoryManifestWrite({ kind: "fs.write", target: manifest }, stateDir),
    ).toBe(true);
    expect(
      isMemoryManifestWrite({ kind: "fs.write", target: path.join(dir, "notes.txt") }, stateDir),
    ).toBe(false);
  });

  test("LocalKernel asks for MEMORY.md even when policy allows fs.write", async () => {
    const dir = ws();
    const stateDir = kernelStateDir(dir);
    mkdirSync(stateDir, { recursive: true });
    const kernel = new LocalKernel({
      stateDir,
      policy: [{ kind: "fs.write", scope: "workspace", decision: "allow" }],
    });
    const manifest = path.join(stateRoot(dir), "MEMORY.md");
    const decision = await kernel.checkGuard(
      { kind: "fs.write", target: manifest },
      "workspace",
    );
    expect(decision.decision).toBe("ask");
    expect(decision.reason ?? "").toContain("memory-manifest-protected");

    const ordinary = await kernel.checkGuard(
      { kind: "fs.write", target: path.join(dir, "ok.txt") },
      "workspace",
    );
    expect(ordinary.decision).toBe("allow");
  });
});
