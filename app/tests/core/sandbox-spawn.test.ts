import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { EnforcementOutcome } from "../../src/contracts";
import {
  SandboxUnavailableError,
  kernelEnforcesProcessSandbox,
  probeSandboxExec,
  resetSandboxExecProbeCache,
  resolveSandboxChildPolicy,
  sandboxFsModeFor,
  sandboxRequireWslRefusal,
  SANDBOX_AUTO_LABELS,
} from "../../src/core/sandbox-spawn";
import { hostIsWsl } from "../../src/core/sandbox-child-net";
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
      mkdirSync(stateDir, { recursive: true });
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
    writeFileSync(bin, "#!/bin/sh\nwhile [ \"$1\" != -- ]; do shift; done\nshift\nexec \"$@\"\n", { mode: 0o755 });
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

/* ------------------------- live exec canary (new) ------------------------- */

function writeHelper(dir: string, name: string, body: string): string {
  const bin = path.join(dir, name);
  writeFileSync(bin, body, { mode: 0o755 });
  return bin;
}

const WRAP_HELPER = "#!/bin/sh\nwhile [ \"$1\" != -- ]; do shift; done\nshift\nexec \"$@\"\n";

describe("probeSandboxExec (live canary)", () => {
  afterEach(() => {
    resetSandboxExecProbeCache();
  });

  test("passes on a working helper and supplies the exact policy env", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-probe-ok-"));
    try {
      const bin = writeHelper(
        dir,
        "hz-sandbox-exec",
        [
          "#!/bin/sh",
          'echo "$HZ_SANDBOX_FS_MODE|$HZ_SANDBOX_CHILD_NET|$HZ_SANDBOX_FS_ROOT|$HZ_SANDBOX_FS_RO_PATHS" >&2',
          "exit 0",
          "",
        ].join("\n"),
      );
      const policy = resolveSandboxChildPolicy({
        fsRoot: dir,
        fsMode: "read-only",
        roPaths: "/state:/hooks.json",
        childNet: "off",
        wsl: false,
      });
      const probe = await probeSandboxExec({
        policy,
        env: { ...process.env, HZ_SANDBOX_EXEC: "1" },
        binary: bin,
      });
      expect(probe.ok).toBe(true);
      expect(probe.probed).toBe(true);
      expect(probe.exitCode).toBe(0);
      expect(probe.childNet).toBe("off");
      expect(probe.stderr).toContain(`read-only|off|${path.resolve(dir)}|/state:/hooks.json`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports a typed failure, not silence, when the helper refuses", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-probe-fail-"));
    try {
      const bin = writeHelper(
        dir,
        "hz-sandbox-exec",
        "#!/bin/sh\necho 'exec /bin/true: Operation not permitted' >&2\nexit 1\n",
      );
      const policy = resolveSandboxChildPolicy({ fsRoot: dir, childNet: "off", wsl: false });
      const probe = await probeSandboxExec({ policy, env: { ...process.env }, binary: bin });
      expect(probe.ok).toBe(false);
      expect(probe.probed).toBe(true);
      expect(probe.exitCode).toBe(1);
      expect(probe.reason).toContain("Operation not permitted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing helper is probed:false, never a silent pass", async () => {
    const policy = resolveSandboxChildPolicy({ fsRoot: tmpdir(), childNet: "off", wsl: false });
    const probe = await probeSandboxExec({
      policy,
      env: { ...process.env, HZ_SANDBOX_EXEC_BIN: "/no/such/hz-sandbox-exec" },
    });
    expect(probe.ok).toBe(false);
    expect(probe.probed).toBe(false);
    expect(probe.binary).toBeNull();
    expect(probe.reason).toContain("not found");
  });

  test("is cached per environment (child net is part of the key)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-probe-cache-"));
    try {
      const bin = writeHelper(
        dir,
        "hz-sandbox-exec",
        "#!/bin/sh\n[ \"$HZ_SANDBOX_CHILD_NET\" = \"on\" ] || { echo 'child net not on' >&2; exit 1; }\nexit 0\n",
      );
      const env = { ...process.env, HZ_SANDBOX_EXEC: "1" };
      const onPolicy = resolveSandboxChildPolicy({ fsRoot: dir, childNet: "on", wsl: false });
      const offPolicy = resolveSandboxChildPolicy({ fsRoot: dir, childNet: "off", wsl: false });
      const on1 = await probeSandboxExec({ policy: onPolicy, env, binary: bin });
      const off = await probeSandboxExec({ policy: offPolicy, env, binary: bin });
      const on2 = await probeSandboxExec({ policy: onPolicy, env, binary: bin });
      expect(on1.ok).toBe(true);
      expect(off.ok).toBe(false);
      expect(off.reason).toContain("child net not on");
      expect(on2.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("kernelEnforcesProcessSandbox requires the canary, not just the report", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-probe-gate-"));
    const prev = { ...process.env };
    try {
      const okBin = writeHelper(dir, "ok", WRAP_HELPER);
      const badBin = writeHelper(dir, "bad", "#!/bin/sh\nexit 1\n");
      const kernel = mockKernel(enforcedReport);

      process.env = { ...prev, HZ_SANDBOX_EXEC_BIN: badBin, HZ_SANDBOX_EXEC: undefined };
      delete process.env.HZ_SANDBOX_EXEC;
      resetSandboxExecProbeCache();
      expect(await kernelEnforcesProcessSandbox(kernel)).toBe(false);

      process.env = { ...prev, HZ_SANDBOX_EXEC_BIN: okBin };
      delete process.env.HZ_SANDBOX_EXEC;
      delete process.env.HZ_SANDBOX_REQUIRE;
      resetSandboxExecProbeCache();
      expect(await kernelEnforcesProcessSandbox(kernel)).toBe(true);
    } finally {
      process.env = prev;
      resetSandboxExecProbeCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sandbox child policy (WSL)", () => {
  test("WSL defaults child net on; REQUIRE refuses instead of weakening silently", () => {
    const policy = resolveSandboxChildPolicy({ fsRoot: tmpdir(), env: {}, wsl: true });
    expect(policy.childNet).toBe("on");
    expect(policy.wslDefaultChildNet).toBe(true);
    expect(policy.notices.some((n) => n.includes("NOT confined"))).toBe(true);
    expect(sandboxRequireWslRefusal(policy, true)).toContain("HZ_SANDBOX_REQUIRE=1");
    expect(sandboxRequireWslRefusal(policy, false)).toBeUndefined();

    const explicitOff = resolveSandboxChildPolicy({
      fsRoot: tmpdir(),
      env: { HZ_SANDBOX_CHILD_NET: "off" },
      wsl: true,
    });
    expect(explicitOff.childNet).toBe("off");
    expect(explicitOff.wslDefaultChildNet).toBe(false);
    expect(sandboxRequireWslRefusal(explicitOff, true)).toBeUndefined();
  });
});

describe("spawnOwned canary gating", () => {
  const prev = { ...process.env };
  afterEach(() => {
    process.env = prev;
    resetSandboxExecProbeCache();
  });

  test("auto-wrap is skipped with a notice when the canary fails", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-sbx-canary-skip-"));
    const binDir = mkdtempSync(path.join(tmpdir(), "hz-sbx-canary-skip-bin-"));
    try {
      const bin = writeHelper(binDir, "hz-sandbox-exec", "#!/bin/sh\necho 'exec /bin/true: Operation not permitted' >&2\nexit 1\n");
      process.env = { ...prev, HZ_SANDBOX_EXEC_BIN: bin };
      delete process.env.HZ_SANDBOX_EXEC;
      delete process.env.HZ_SANDBOX_REQUIRE;
      const { proc, entry } = await spawnOwned(["sh", "-c", "echo unwrapped"], {
        stateDir: kernelStateDir(workspace),
        label: "shell",
        sandboxWrap: "auto",
        kernel: mockKernel(enforcedReport),
        stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        longLived: false,
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      expect(out.trim()).toBe("unwrapped");
      expect(entry.cmd.startsWith(bin)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("required wrap refuses with a typed error when the canary fails", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-sbx-canary-refuse-"));
    const binDir = mkdtempSync(path.join(tmpdir(), "hz-sbx-canary-refuse-bin-"));
    try {
      const bin = writeHelper(binDir, "hz-sandbox-exec", "#!/bin/sh\nexit 1\n");
      process.env = { ...prev, HZ_SANDBOX_EXEC_BIN: bin };
      delete process.env.HZ_SANDBOX_EXEC;
      delete process.env.HZ_SANDBOX_REQUIRE;
      let error: unknown;
      try {
        await spawnOwned(["sh", "-c", "echo should-not-run"], {
          stateDir: kernelStateDir(workspace),
          label: "code_mode",
          sandboxWrap: "required",
          kernel: mockKernel(enforcedReport),
          stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
          longLived: false,
        });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(SandboxUnavailableError);
      expect((error as Error).message).toContain("sandbox wrap required");
      expect(await readSpawnLedger(kernelStateDir(workspace))).toEqual({ entries: [], corrupt: false });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("HZ_SANDBOX_REQUIRE=1 on WSL refuses the child-net default with a typed error", async () => {
    if (!hostIsWsl()) return; // the refusal is WSL-specific
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-sbx-wsl-require-"));
    const binDir = mkdtempSync(path.join(tmpdir(), "hz-sbx-wsl-require-bin-"));
    try {
      const bin = writeHelper(binDir, "hz-sandbox-exec", WRAP_HELPER);
      process.env = { ...prev, HZ_SANDBOX_EXEC_BIN: bin, HZ_SANDBOX_REQUIRE: "1" };
      delete process.env.HZ_SANDBOX_EXEC;
      delete process.env.HZ_SANDBOX_CHILD_NET;
      resetSandboxExecProbeCache();
      let error: unknown;
      try {
        await spawnOwned(["sh", "-c", "echo should-not-run"], {
          stateDir: kernelStateDir(workspace),
          label: "shell",
          sandboxWrap: "auto",
          kernel: mockKernel(enforcedReport),
          stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
          longLived: false,
        });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(SandboxUnavailableError);
      expect((error as Error).message).toContain("HZ_SANDBOX_REQUIRE=1");
      expect(await readSpawnLedger(kernelStateDir(workspace))).toEqual({ entries: [], corrupt: false });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
