import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { EnforcementOutcome } from "../../src/contracts";
import {
  kernelEnforcesProcessSandbox,
  sandboxFsModeFor,
  SANDBOX_AUTO_LABELS,
} from "../../src/core/sandbox-spawn";
import { kernelStateDir, readSpawnLedger, sandboxHookWriteDenyRoPaths, spawnOwned } from "../../src/core/owned-spawn";
import { workspaceHooksFile } from "../../src/core/trust";
import type { KernelClient } from "../../src/core/kernel";

const enforcedReport: EnforcementOutcome = {
  status: "report",
  mode: "workspace-write",
  completeness: "partial",
  backend: "hz-sandbox-exec",
  dimensions: [
    { dimension: "process", guarantee: "enforced", backend: "seccomp", residual: "" },
    { dimension: "filesystem", guarantee: "unsupported", backend: "none", residual: "no landlock" },
  ],
};

function mockKernel(report: EnforcementOutcome, mode = "trusted"): KernelClient {
  return {
    mode,
    sandboxReport: async () => report,
  } as unknown as KernelClient;
}

describe("sandboxFsModeFor", () => {
  test("maps SandboxMode to Landlock FS mode", () => {
    expect(sandboxFsModeFor("read-only")).toBe("read-only");
    expect(sandboxFsModeFor("workspace-write")).toBe("workspace-write");
    expect(sandboxFsModeFor("danger-full-access")).toBeUndefined();
  });
});

describe("kernelEnforcesProcessSandbox", () => {
  const env = process.env;

  afterEach(() => {
    process.env = env;
  });

  test("false when HZ_SANDBOX_EXEC=0", async () => {
    process.env = { ...env, HZ_SANDBOX_EXEC: "0" };
    expect(await kernelEnforcesProcessSandbox(mockKernel(enforcedReport))).toBe(false);
  });

  test("true when HZ_SANDBOX_EXEC=1 and binary exists", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-sbx-bin-"));
    const bin = path.join(dir, "hz-sandbox-exec");
    writeFileSync(bin, "#!/bin/sh\necho wrap\n", { mode: 0o755 });
    process.env = { ...env, HZ_SANDBOX_EXEC: "1", HZ_SANDBOX_EXEC_BIN: bin };
    expect(await kernelEnforcesProcessSandbox(mockKernel(enforcedReport))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("requires trusted mode and process dimension enforced", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-sbx-bin-"));
    const bin = path.join(dir, "hz-sandbox-exec");
    writeFileSync(bin, "#!/bin/sh\necho wrap\n", { mode: 0o755 });
    process.env = { ...env, HZ_SANDBOX_EXEC_BIN: bin };
    expect(await kernelEnforcesProcessSandbox(mockKernel(enforcedReport, "untrusted"))).toBe(false);
    const noProcess: EnforcementOutcome = {
      status: "report",
      mode: "workspace-write",
      completeness: "partial",
      backend: "none",
      dimensions: [{ dimension: "process", guarantee: "unsupported", backend: "none", residual: "none" }],
    };
    expect(await kernelEnforcesProcessSandbox(mockKernel(noProcess))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("sandboxHookWriteDenyRoPaths", () => {
  test("includes kernel state and workspace hooks.json when present", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-ro-paths-"));
    try {
      const stateDir = kernelStateDir(workspace);
      mkdirSync(path.dirname(workspaceHooksFile(workspace)), { recursive: true });
      writeFileSync(workspaceHooksFile(workspace), "{}");
      const ro = sandboxHookWriteDenyRoPaths(workspace, stateDir);
      expect(ro).toContain(path.resolve(stateDir));
      expect(ro).toContain(path.resolve(workspaceHooksFile(workspace)));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("spawnOwned auto sandbox wrap", () => {
  test("passes bridge HTTP_PROXY to wrapped children when HZ_EGRESS_NETNS_PROXY_ROUTED=1 (317)", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-sbx-routed-"));
    const binDir = mkdtempSync(path.join(tmpdir(), "hz-sbx-exec-routed-"));
    const bin = path.join(binDir, "hz-sandbox-exec");
    writeFileSync(bin, "#!/bin/sh\nwhile [ \"$1\" != -- ]; do shift; done\nshift\nexec \"$@\"\n", { mode: 0o755 });
    const prev = { ...process.env };
    process.env = {
      ...prev,
      HZ_SANDBOX_EXEC: "1",
      HZ_SANDBOX_EXEC_BIN: bin,
      HZ_SANDBOX_NETNS: "1",
      HZ_EGRESS_NETNS_PROXY_ROUTED: "1",
      HZ_EGRESS_NETNS_BRIDGE_HOST: "10.199.0.1",
      HZ_EGRESS_PROXY: "http://127.0.0.1:4317",
    };
    try {
      const stateDir = kernelStateDir(workspace);
      const { proc } = await spawnOwned(["sh", "-c", 'echo -n "$HTTP_PROXY"'], {
        stateDir,
        label: "shell",
        sandboxWrap: true,
        stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        longLived: false,
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      expect(out).toBe("http://10.199.0.1:4317");
    } finally {
      process.env = prev;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("passes HZ_SANDBOX_CHILD_NET=off on wrapped children when parent env requests", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-sbx-net-"));
    const binDir = mkdtempSync(path.join(tmpdir(), "hz-sbx-exec-net-"));
    const bin = path.join(binDir, "hz-sandbox-exec");
    writeFileSync(bin, "#!/bin/sh\nwhile [ \"$1\" != -- ]; do shift; done\nshift\nexec \"$@\"\n", { mode: 0o755 });
    const prev = { ...process.env };
    process.env = { ...prev, HZ_SANDBOX_EXEC: "1", HZ_SANDBOX_EXEC_BIN: bin, HZ_SANDBOX_CHILD_NET: "off" };
    try {
      const stateDir = kernelStateDir(workspace);
      const { proc } = await spawnOwned(["sh", "-c", 'echo -n "$HZ_SANDBOX_CHILD_NET"'], {
        stateDir,
        label: "shell",
        sandboxWrap: true,
        stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        longLived: false,
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      expect(out).toBe("off");
    } finally {
      process.env = prev;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("wraps shell argv when kernel reports process enforced", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-sbx-wrap-"));
    const binDir = mkdtempSync(path.join(tmpdir(), "hz-sbx-exec-"));
    const bin = path.join(binDir, "hz-sandbox-exec");
    writeFileSync(bin, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });
    const prev = { ...process.env };
    process.env = { ...prev, HZ_SANDBOX_EXEC_BIN: bin };
    try {
      const stateDir = kernelStateDir(workspace);
      const kernel = mockKernel(enforcedReport);
      const { proc, entry } = await spawnOwned(["sh", "-c", "echo ok"], {
        stateDir,
        label: "shell",
        sandboxWrap: "auto",
        kernel,
        stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        longLived: false,
      });
      await proc.exited;
      expect(entry.cmd.startsWith(bin)).toBe(true);
      expect(SANDBOX_AUTO_LABELS.has("shell")).toBe(true);
      const ledger = await readSpawnLedger(stateDir);
      expect(ledger.entries.some((r) => r.cmd.startsWith(bin))).toBe(true);
    } finally {
      process.env = prev;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
