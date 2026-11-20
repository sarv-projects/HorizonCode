/**
 * codemode-kv-allowlist.test.ts — persistent session KV + expanded tool allowlist.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { EnforcementOutcome, SandboxSpawnKernel, ToolContext } from "../../src/contracts";
import { resetSandboxExecProbeCache } from "../../src/core/sandbox-spawn";
import {
  CodemodeSessionKv,
  codemodeKvPath,
} from "../../src/tools/codemode-kv";
import {
  codemodeAllowedToolNames,
  codemodeTool,
  resolveCodeModeSandbox,
} from "../../src/tools/codemode";

const temps: string[] = [];

function tempWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-cm-kv-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.HZ_SANDBOX_EXEC_BIN;
  delete process.env.HZ_SANDBOX_CHILD_NET;
  resetSandboxExecProbeCache();
});

describe("codemode session kv", () => {
  test("persists across CodemodeSessionKv instances for the same session", () => {
    const ws = tempWorkspace();
    const session = "sess-kv-1";
    const first = new CodemodeSessionKv(ws, session);
    first.set("alpha", { n: 1 });
    expect(existsSync(codemodeKvPath(ws, session))).toBe(true);

    const second = new CodemodeSessionKv(ws, session);
    expect(second.get("alpha")).toEqual({ n: 1 });
    second.set("beta", "text");
    expect(JSON.parse(readFileSync(codemodeKvPath(ws, session), "utf8"))).toEqual({
      alpha: { n: 1 },
      beta: "text",
    });
  });

  test("different session ids do not share storage", () => {
    const ws = tempWorkspace();
    new CodemodeSessionKv(ws, "a").set("k", 1);
    new CodemodeSessionKv(ws, "b").set("k", 2);
    expect(new CodemodeSessionKv(ws, "a").get("k")).toBe(1);
    expect(new CodemodeSessionKv(ws, "b").get("k")).toBe(2);
  });
});

describe("codemode allowed tools", () => {
  test("includes base seven plus read-only extras; blocks agent/preview/code_mode", () => {
    const names = codemodeAllowedToolNames();
    for (const tool of [
      "read",
      "write",
      "edit",
      "grep",
      "glob",
      "shell",
      "todo",
      "repo_map",
      "ast_search",
      "lsp",
    ]) {
      expect(names).toContain(tool);
    }
    expect(names).not.toContain("agent");
    expect(names).not.toContain("preview");
    expect(names).not.toContain("code_mode");
  });
});

describe("codemode kv across runs", () => {
  const SANDBOX_BIN_DIR = mkdtempSync(path.join(tmpdir(), "hz-cm-kv-sbx-"));
  const SANDBOX_BIN = path.join(SANDBOX_BIN_DIR, "hz-sandbox-exec");
  const SANDBOX_REPORT: EnforcementOutcome = {
    status: "report",
    mode: "workspace-write",
    completeness: "partial",
    backend: "hz-sandbox-exec",
    dimensions: [{ dimension: "process", guarantee: "enforced", backend: "seccomp", residual: "" }],
  };
  const SANDBOX_KERNEL: SandboxSpawnKernel = {
    mode: "trusted",
    sandboxReport: async () => SANDBOX_REPORT,
  };

  test("tools.kv survives two code_mode runs in one session", async () => {
    const ws = tempWorkspace();
    const sessionId = "codemode-kv-e2e";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      SANDBOX_BIN,
      '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n',
      { mode: 0o755 },
    );
    process.env.HZ_SANDBOX_EXEC_BIN = SANDBOX_BIN;
    process.env.HZ_SANDBOX_CHILD_NET = "off";

    const ctx: ToolContext = {
      cwd: ws,
      workspace: ws,
      sessionId,
      signal: new AbortController().signal,
      kernel: SANDBOX_KERNEL,
      guard: async () => ({ decision: "allow" }),
      approve: async () => true,
      receipt: async (rec) => ({
        action: rec.action,
        tool: rec.tool,
        argsDigest: rec.argsDigest,
        resultDigest: rec.resultDigest,
        id: "r1",
        seq: 1,
        ts: new Date().toISOString(),
        prevHash: null,
        hash: "h",
      }),
    };

    const writeRun = await codemodeTool.execute(
      {
        code: 'await tools.kv.set("carry", 42); return await tools.kv.get("carry");',
      },
      ctx,
    );
    expect(writeRun.ok).toBe(true);
    expect(writeRun.output).toContain("42");

    const readRun = await codemodeTool.execute(
      { code: 'return await tools.kv.get("carry");' },
      ctx,
    );
    expect(readRun.ok).toBe(true);
    expect(readRun.output).toContain("42");
    expect(new CodemodeSessionKv(ws, sessionId).get("carry")).toBe(42);
  });
});

describe("WSL code_mode sandbox honesty", () => {
  test("falls back when child_net=off canary fails on WSL-simulated host", async () => {
    const ws = tempWorkspace();
    const binDir = mkdtempSync(path.join(tmpdir(), "hz-cm-wsl-bin-"));
    const bin = path.join(binDir, "hz-sandbox-exec");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      bin,
      '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\n' +
        '[ "$HZ_SANDBOX_CHILD_NET" = "off" ] && exit 42\nexec "$@"\n',
      { mode: 0o755 },
    );
    process.env.HZ_SANDBOX_EXEC_BIN = bin;
    delete process.env.HZ_SANDBOX_CHILD_NET;
    resetSandboxExecProbeCache();

    const kernel: SandboxSpawnKernel = {
      mode: "trusted",
      sandboxReport: async () => ({
        status: "report",
        mode: "workspace-write",
        completeness: "partial",
        backend: "hz-sandbox-exec",
        dimensions: [{ dimension: "process", guarantee: "enforced", backend: "seccomp", residual: "" }],
      }),
    };

    const resolved = await resolveCodeModeSandbox(kernel, {
      fsRoot: ws,
      fsMode: "workspace-write",
      requireTrusted: true,
      wsl: true,
    });
    expect(resolved.posture.enforced).toBe(true);
    expect(resolved.networkConfined).toBe(false);
    expect(resolved.childNet).toBe("on");
    rmSync(binDir, { recursive: true, force: true });
  });
});