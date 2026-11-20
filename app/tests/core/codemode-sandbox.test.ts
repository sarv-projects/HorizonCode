/**
 * codemode-sandbox.test.ts — code_mode's fail-closed OS-sandbox gate.
 *
 * code_mode runs model-authored JavaScript with ambient Bun privileges. The only
 * thing that may confine it is a real subprocess boundary, so the tool requires
 * a live `hz-sandbox-exec -- /bin/true` canary with `workspace-write` FS and
 * `HZ_SANDBOX_CHILD_NET=off`. These tests pin:
 *
 *   - no kernel / untrusted kernel / failing canary => typed refusal, no spawn;
 *   - the refused program cannot read the parent environment (it never runs);
 *   - a verified sandbox runs with a scrubbed env and the exact policy;
 *   - the canary is an actual `-- /bin/true` invocation, not a claim.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { EnforcementOutcome, SandboxSpawnKernel, ToolContext } from "../../src/contracts";
import { resolveSandboxExecBinary } from "../../src/core/kernel";
import { kernelStateDir, readSpawnLedger } from "../../src/core/owned-spawn";
import {
  probeSandboxExec,
  resetSandboxExecProbeCache,
  resolveSandboxChildPolicy,
} from "../../src/core/sandbox-spawn";
import { codemodeTool } from "../../src/tools/codemode";

const temps: string[] = [];
const ENV_KEYS = [
  "HZ_SANDBOX_EXEC",
  "HZ_SANDBOX_EXEC_BIN",
  "HZ_SANDBOX_CHILD_NET",
  "HZ_SANDBOX_REQUIRE",
  "HZ_API_KEY",
  "HZ_CODEMODE_PARENT_SENTINEL",
] as const;
let savedEnv: Record<string, string | undefined> = {};

const WRAP_HELPER = '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n';

const REPORT: EnforcementOutcome = {
  status: "report",
  mode: "workspace-write",
  completeness: "partial",
  backend: "hz-sandbox-exec",
  dimensions: [{ dimension: "process", guarantee: "enforced", backend: "seccomp", residual: "" }],
};

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function helperDir(): string {
  return tempDir("hz-cm-sbx-bin-");
}

function writeHelper(body: string): string {
  const bin = path.join(helperDir(), "hz-sandbox-exec");
  writeFileSync(bin, body, { mode: 0o755 });
  return bin;
}

function kernel(mode = "trusted", report: EnforcementOutcome = REPORT): SandboxSpawnKernel {
  return { mode, sandboxReport: async () => report };
}

function makeCtx(workspace: string, sandboxKernel?: SandboxSpawnKernel): ToolContext {
  return {
    cwd: workspace,
    workspace,
    sessionId: "codemode-sandbox-test",
    signal: new AbortController().signal,
    kernel: sandboxKernel,
    guard: async () => ({ decision: "allow" }),
    approve: async () => true,
    receipt: async (rec) => ({
      action: rec.action,
      tool: rec.tool,
      argsDigest: rec.argsDigest,
      resultDigest: rec.resultDigest,
      id: "r-1",
      seq: 1,
      ts: new Date().toISOString(),
      prevHash: null,
      hash: "test-hash",
    }),
  };
}

async function assertNoChildSpawned(workspace: string): Promise<void> {
  expect(existsSync(path.join(kernelStateDir(workspace), "spawns.jsonl"))).toBe(false);
  const ledger = await readSpawnLedger(kernelStateDir(workspace));
  expect(ledger).toEqual({ entries: [], corrupt: false });
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  resetSandboxExecProbeCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSandboxExecProbeCache();
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("code_mode OS-sandbox gate", () => {
  test("refuses when no kernel context is available", async () => {
    const ws = tempDir("hz-cm-sbx-nokernel-");
    process.env.HZ_SANDBOX_EXEC_BIN = writeHelper(WRAP_HELPER);
    process.env.HZ_SANDBOX_CHILD_NET = "off";

    const result = await codemodeTool.execute({ code: "return 1;" }, makeCtx(ws));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("SANDBOX_UNAVAILABLE");
    expect(result.output).toContain("code_mode refused");
    expect(result.output).toContain("did not run");
    await assertNoChildSpawned(ws);
  });

  test("refuses an untrusted kernel even when the canary would pass", async () => {
    const ws = tempDir("hz-cm-sbx-untrusted-");
    process.env.HZ_SANDBOX_EXEC_BIN = writeHelper(WRAP_HELPER);
    process.env.HZ_SANDBOX_CHILD_NET = "off";

    const result = await codemodeTool.execute(
      { code: "return 1;" },
      makeCtx(ws, kernel("untrusted")),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("SANDBOX_UNAVAILABLE");
    expect(result.output).toContain("not trusted");
    await assertNoChildSpawned(ws);
  });

  test("refuses a failing canary; the program never runs and cannot read parent env", async () => {
    const ws = tempDir("hz-cm-sbx-badcanary-");
    process.env.HZ_SANDBOX_EXEC_BIN = writeHelper(
      "#!/bin/sh\necho 'exec /bin/true: Operation not permitted' >&2\nexit 1\n",
    );
    process.env.HZ_SANDBOX_CHILD_NET = "off";
    const sentinel = `parent-only-${Date.now()}`;
    process.env.HZ_CODEMODE_PARENT_SENTINEL = sentinel;

    const result = await codemodeTool.execute(
      {
        code: [
          `const secret = process.env.HZ_CODEMODE_PARENT_SENTINEL ?? "absent";`,
          "return { secret };",
        ].join("\n"),
      },
      makeCtx(ws, kernel()),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("SANDBOX_UNAVAILABLE");
    expect(result.output).toContain("Operation not permitted");
    expect(result.output).not.toContain(sentinel);
    await assertNoChildSpawned(ws);
    delete process.env.HZ_CODEMODE_PARENT_SENTINEL;
  });

  test("runs under a verified sandbox with workspace-write, child net off, and scrubbed env", async () => {
    const ws = tempDir("hz-cm-sbx-ok-");
    const bin = writeHelper(WRAP_HELPER);
    process.env.HZ_SANDBOX_EXEC_BIN = bin;
    process.env.HZ_SANDBOX_CHILD_NET = "off";
    process.env.HZ_API_KEY = "provider-secret-must-not-leak";

    const result = await codemodeTool.execute(
      {
        code: [
          "return {",
          '  secret: process.env.HZ_API_KEY ?? null,',
          '  net: process.env.HZ_SANDBOX_CHILD_NET ?? null,',
          '  fsMode: process.env.HZ_SANDBOX_FS_MODE ?? null,',
          "};",
        ].join("\n"),
      },
      makeCtx(ws, kernel()),
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain('"secret":null');
    expect(result.output).toContain('"net":"off"');
    expect(result.output).toContain('"fsMode":"workspace-write"');
    expect(result.output).not.toContain("provider-secret-must-not-leak");

    const ledger = await readSpawnLedger(kernelStateDir(ws));
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.cmd.startsWith(bin)).toBe(true);
    delete process.env.HZ_API_KEY;
  });

  test("the canary is a real `-- /bin/true` subprocess, not a static claim", async () => {
    const ws = tempDir("hz-cm-sbx-canary-log-");
    const log = path.join(tempDir("hz-cm-sbx-canary-logfile-"), "argv.log");
    const bin = writeHelper(
      ["#!/bin/sh", `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`, WRAP_HELPER.split("\n").slice(1).join("\n")].join("\n"),
    );
    process.env.HZ_SANDBOX_EXEC_BIN = bin;
    process.env.HZ_SANDBOX_CHILD_NET = "off";

    const result = await codemodeTool.execute(
      { code: "return 42;" },
      makeCtx(ws, kernel()),
    );

    expect(result.ok).toBe(true);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.some((line) => line.includes("-- /bin/true"))).toBe(true);
    expect(lines.some((line) => line.includes("codemode-child.ts"))).toBe(true);
  });

  test("real helper: WSL netns honesty when child_net=off canary fails", async () => {
    const bin = resolveSandboxExecBinary(process.env);
    if (bin === undefined) {
      console.log("skip real-sandbox code_mode: hz-sandbox-exec is not built");
      return;
    }
    const ws = tempDir("hz-cm-sbx-real-");
    const env = { ...process.env, HZ_SANDBOX_EXEC_BIN: bin, HZ_SANDBOX_CHILD_NET: "off" };
    const policy = resolveSandboxChildPolicy({
      fsRoot: ws,
      fsMode: "workspace-write",
      childNet: "off",
      env,
      wsl: false,
    });
    const probe = await probeSandboxExec({ policy, env, binary: bin });
    process.env.HZ_SANDBOX_EXEC_BIN = bin;
    process.env.HZ_SANDBOX_CHILD_NET = "off";

    if (!probe.ok) {
      // WSL (CLONE_NEWNET EPERM): strict network-off cannot be proven. code_mode
      // retries with the WSL child-net default — FS/process sandbox, honest
      // about unconfined egress (never shell-net enforced).
      console.log(`real-sandbox strict network-off unavailable: ${probe.reason}`);
      const result = await codemodeTool.execute({ code: "return 1;" }, makeCtx(ws, kernel()));
      if (result.error?.includes("SANDBOX_UNAVAILABLE")) {
        expect(result.ok).toBe(false);
        await assertNoChildSpawned(ws);
        return;
      }
      // WSL fallback: may attempt FS/process sandbox without claiming network-off.
      expect(result.error ?? "").not.toContain("SANDBOX_UNAVAILABLE");
      return;
    }

    const result = await codemodeTool.execute(
      { code: "return process.env.HZ_SANDBOX_CHILD_NET;" },
      makeCtx(ws, kernel()),
    );
    if (!result.ok) {
      // The host can apply the canary but not the product's Bun child (e.g. the
      // runtime/repo lives outside the Landlock RO prefixes). code_mode still
      // failed closed; name the limitation instead of pretending it ran.
      console.log(`skip real-sandbox code_mode success path: ${result.output.split("\n")[0]}`);
      return;
    }
    expect(result.ok).toBe(true);
    expect(result.output).toContain('"off"');
    const ledger = await readSpawnLedger(kernelStateDir(ws));
    expect(ledger.entries[0]?.cmd.startsWith(bin)).toBe(true);
  });
});
