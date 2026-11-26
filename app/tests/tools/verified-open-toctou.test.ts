import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { capturePathAncestors, openVerifiedWrite, pathAncestorDrift } from "../../src/tools/verified-open";
import type { ToolContext } from "../../src/contracts";

describe("verified-open TOCTOU protection", () => {
  it("opens legitimate workspace file and returns verified descriptor", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hz-verified-open-"));
    try {
      const filePath = path.join(tmp, "test.txt");
      const ctx: ToolContext = {
        workspace: tmp,
        cwd: tmp,
        session: "s1",
      };

      const res = await openVerifiedWrite(filePath, ctx);
      expect("handle" in res).toBe(true);
      if ("handle" in res) {
        await res.handle.write("hello world");
        await res.handle.close();
      }

      const readBack = await fs.readFile(filePath, "utf8");
      expect(readBack).toBe("hello world");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("refuses opening a path inside the kernel state directory", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hz-verified-open-"));
    try {
      const stateDir = path.join(tmp, ".hz", "state", "kernel");
      await fs.mkdir(stateDir, { recursive: true });
      const targetInState = path.join(stateDir, "policy.json");

      const ctx: ToolContext = {
        workspace: tmp,
        cwd: tmp,
        session: "s1",
      };

      const res = await openVerifiedWrite(targetInState, ctx);
      expect("refusal" in res).toBe(true);
      if ("refusal" in res) {
        expect(res.refusal).toContain("inside the kernel state directory");
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("handles non-existent parent directory gracefully", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hz-verified-open-"));
    try {
      const nonExistentDirFile = path.join(tmp, "does", "not", "exist", "file.txt");
      const ctx: ToolContext = {
        workspace: tmp,
        cwd: tmp,
        session: "s1",
      };

      // When parent directory doesn't exist yet, open fails with ENOENT as expected
      let errCaught: unknown;
      try {
        await openVerifiedWrite(nonExistentDirFile, ctx);
      } catch (err) {
        errCaught = err;
      }
      expect(errCaught).toBeDefined();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("detects an intermediate directory above the parent being replaced", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hz-verified-open-"));
    try {
      const mid = path.join(tmp, "mid");
      const leaf = path.join(mid, "leaf");
      const filePath = path.join(leaf, "f.txt");
      await fs.mkdir(leaf, { recursive: true });
      const before = await capturePathAncestors(filePath, tmp);
      await fs.rename(mid, path.join(tmp, "mid-old"));
      await fs.mkdir(leaf, { recursive: true });
      const after = await capturePathAncestors(filePath, tmp);
      expect(before.map((row) => row.path)).toContain(mid);
      expect(before.map((row) => row.path)).toContain(tmp);
      expect(pathAncestorDrift(before, after)).toBe(leaf);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("refuses a write when an intermediate directory is replaced before the bytes", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hz-verified-open-"));
    try {
      const mid = path.join(tmp, "mid");
      const leaf = path.join(mid, "leaf");
      const filePath = path.join(leaf, "f.txt");
      await fs.mkdir(leaf, { recursive: true });
      const ctx: ToolContext = { workspace: tmp, cwd: tmp, session: "s1" };
      const res = await openVerifiedWrite(filePath, ctx, {
        afterAncestorCapture: async () => {
          await fs.rename(mid, path.join(tmp, "mid-old"));
          await fs.mkdir(leaf, { recursive: true });
        },
      });
      expect("refusal" in res).toBe(true);
      if ("refusal" in res) expect(res.refusal).toContain("changed while being opened");
      const created = await fs.stat(filePath).catch(() => undefined);
      if (created) expect(created.size).toBe(0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
