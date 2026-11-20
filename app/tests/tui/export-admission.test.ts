import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ChatMsg, Runtime } from "../../src/contracts";
import { defaultHzsExportPath } from "../../src/core/archive";
import { stateRoot } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";
import { runConvoCommand } from "../../src/tui/interactive";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function ws(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-tui-export-"));
  roots.push(dir);
  return dir;
}

const history: ChatMsg[] = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
];

describe("TUI /export under-admission (ruling 572)", () => {
  test("refuses html export before write when policy denies fs.write", async () => {
    const workspace = ws();
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(workspace, "no-such-hz-kernel");
    try {
      const kernelState = path.join(workspace, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-tui-export" }]),
        "utf8",
      );
      const notices: string[] = [];
      const renderer = { notice: (m: string) => notices.push(m), line: () => {} } as never;
      const rt = {
        sessionId: "s1",
        model: "m",
        history: () => history,
        sessionTitle: () => "t",
        receiptChain: async () => ({ ok: true, count: 1 }),
      } as unknown as Runtime;
      await runConvoCommand("export", "html", rt, renderer, workspace);
      expect(notices.join("\n")).toMatch(/export refused|denied|test-deny-tui-export/i);
      expect(existsSync(path.join(stateRoot(workspace), "exports", "s1.html"))).toBe(false);
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  });

  test("refuses hzs export before write when policy denies fs.write", async () => {
    const workspace = ws();
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(workspace, "no-such-hz-kernel");
    try {
      const store = new SessionStore(workspace);
      const session = store.createSession("export-deny-hzs");
      store.close();
      const kernelState = path.join(workspace, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-tui-hzs" }]),
        "utf8",
      );
      const notices: string[] = [];
      const renderer = { notice: (m: string) => notices.push(m), line: () => {} } as never;
      const rt = {
        sessionId: session.id,
        model: "m",
        history: () => history,
      } as unknown as Runtime;
      await runConvoCommand("export", "hzs", rt, renderer, workspace);
      expect(notices.join("\n")).toMatch(/session export refused|denied|test-deny-tui-hzs/i);
      expect(existsSync(defaultHzsExportPath(workspace, session.id))).toBe(false);
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  });
});
