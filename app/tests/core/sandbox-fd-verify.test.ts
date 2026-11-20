/** H-31 reduced TOCTOU — workspace fd verify + symlink swap refusal (unix). */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { writeTool } from "../../src/tools/write";
import { mockToolContext } from "../tools/helpers";
import { recheckPathInWorkspace } from "../../src/core/sandbox-fd-verify";
import { kernelStateDir } from "../../src/core/paths";

function scratch(tag: string): string {
  return mkdtempSync(path.join(tmpdir(), tag));
}

describe("sandbox fd verify (unix)", () => {
  test.skipIf(process.platform === "win32")(
    "recheckPathInWorkspace refuses a symlink swap that moves resolution outside",
    () => {
      const ws = scratch("hz-recheck-");
      const file = path.join(ws, "f.txt");
      writeFileSync(file, "x");
      const before = recheckPathInWorkspace(ws, file);
      expect(typeof before).toBe("string");
      const outside = mkdtempSync(path.join(tmpdir(), "hz-out-"));
      const secret = path.join(outside, "secret.txt");
      writeFileSync(secret, "secret");
      rmSync(file, { force: true });
      symlinkSync(secret, file);
      const after = recheckPathInWorkspace(ws, file, before as string);
      expect(typeof after).not.toBe("string");
      if (typeof after !== "string") {
        expect(after.refusal).toContain("HZ_PRECONDITION_FAILED");
      }
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    },
  );

  test.skipIf(process.platform === "win32")(
    "write refuses symlink swap to a path outside the workspace between guard and effect",
    async () => {
      const ws = scratch("hz-wswap-out-");
      kernelStateDir(ws);
      const outside = mkdtempSync(path.join(tmpdir(), "hz-wswap-outdir-"));
      const secret = path.join(outside, "secret.txt");
      writeFileSync(secret, "SECRET\n");
      const file = path.join(ws, "file.txt");
      writeFileSync(file, "ok\n");
      const ctx = mockToolContext({
        cwd: ws,
        workspace: ws,
        decision: () => {
          rmSync(file, { force: true });
          symlinkSync(secret, file);
          return { decision: "allow" };
        },
      });
      const r = await writeTool.execute({ path: "file.txt", content: "PWNED\n" }, ctx);
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain("HZ_PRECONDITION_FAILED");
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(secret, "utf8")).toBe("SECRET\n");
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    },
  );
});