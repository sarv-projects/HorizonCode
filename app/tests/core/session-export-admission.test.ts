import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { admitSessionArchiveWrite, defaultHzsExportPath, writeSessionArchiveGuarded } from "../../src/core/archive";
import { exportSessionCli } from "../../src/core/session-cli";
import { SessionStore } from "../../src/core/session";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function ws(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-sess-export-"));
  roots.push(dir);
  return dir;
}

describe("session export under-admission (rulings 569/621)", () => {
  test("refuses before write when policy denies fs.write", async () => {
    const workspace = ws();
    const store = new SessionStore(workspace);
    const session = store.createSession("export-deny");
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(workspace, "no-such-hz-kernel");
    try {
      const kernelState = path.join(workspace, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-export" }]),
        "utf8",
      );
      const target = defaultHzsExportPath(workspace, session.id);
      const refused = await admitSessionArchiveWrite(workspace, undefined, session.id);
      expect(refused).toMatch(/denied|test-deny-export|session-archive/i);
      await expect(writeSessionArchiveGuarded(workspace, session.id)).rejects.toThrow(/denied|test-deny-export|session-archive/i);
      await expect(exportSessionCli(workspace, session.id)).rejects.toThrow(/denied|test-deny-export/i);
      expect(existsSync(target)).toBe(false);
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  }, 20_000);
});
