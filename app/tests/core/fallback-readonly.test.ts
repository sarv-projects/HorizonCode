/**
 * fallback-readonly.test.ts — an absent/untrusted kernel is read-only by default.
 *
 * The TypeScript fallback keeps guard decisions contract-identical, but it is
 * NOT behind the kernel's OS-level boundary. Warning alone was not enough: a
 * missing or pin-rejected kernel must not silently leave the model able to
 * write files or run commands. createRuntime therefore forces `read-only`
 * unless the caller explicitly passes `allowUntrusted`/`--allow-untrusted`.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { ApprovalRequest, Provider, ProviderEvent } from "../../src/contracts";
import { createRuntime } from "../../src/core/index";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { runTurn } from "../../src/core/loop";
import { workspaceStateDir } from "../../src/core/paths";
import { modeRefusal, type PermissionMode } from "../../src/core/permission-mode";
import { SessionStore } from "../../src/core/session";
import { cleanupTemps, restoreEnv, setEnv, snapshotEnv, tempDir, type EnvSnapshot } from "./helpers";

let envBackup: EnvSnapshot;
const extra: Array<[string, string | undefined]> = [];
for (const key of ["HZ_KERNEL_PIN", "HZ_KERNEL_SHA256"]) extra.push([key, process.env[key]]);

beforeAll(() => {
  envBackup = snapshotEnv();
});
afterAll(() => {
  restoreEnv(envBackup);
  for (const [key, value] of extra) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  cleanupTemps();
});

/** A workspace whose configured kernel path does not exist: authoritative "no kernel". */
function kernellessWorkspace(): { workspace: string; home: string } {
  const workspace = tempDir("hz-fb-ro-ws-");
  const home = tempDir("hz-fb-ro-home-");
  const missing = path.join(tempDir("hz-fb-ro-nowhere-"), "hz-kernel");
  setEnv({ HZ_KERNEL_BIN: missing, HZ_KERNEL_PIN: undefined, HZ_KERNEL_SHA256: undefined, HOME: home, HZ_PROVIDER: undefined, HZ_MODEL: undefined, HZ_BASE_URL: undefined });
  return { workspace, home };
}

function oneCall(name: string, args: Record<string, unknown>): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream() {
      turn += 1;
      if (turn === 1) {
        yield { type: "tool_call", id: "call_1", name, arguments: JSON.stringify(args) } satisfies ProviderEvent;
        yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
        return;
      }
      yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
    },
  };
}

async function runTool(
  workspace: string,
  mode: PermissionMode,
  provider: Provider,
): Promise<{ asked: ApprovalRequest[]; toolOutput: string }> {
  const stateDir = path.join(workspaceStateDir(workspace), "kernel");
  const kernel = new KernelClient({ workspace, stateDir });
  const store = new SessionStore(workspace);
  const asked: ApprovalRequest[] = [];
  let toolOutput = "";
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("fallback-readonly").id,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: {
      onEvent: (ev) => {
        if (ev.type === "tool.card") toolOutput += JSON.stringify(ev);
      },
    },
    sessionLeases: [],
    approve: async (req) => {
      asked.push(req);
      return false;
    },
    permissionMode: mode,
  };
  try {
    await runTurn(deps);
  } finally {
    await kernel.close();
    store.close();
  }
  return { asked, toolOutput };
}

test("kernel absent + normal runtime is read-only and refuses write/shell", async () => {
  const { workspace } = kernellessWorkspace();
  const runtime = await createRuntime({ workspace, mock: true });
  try {
    expect(runtime.kernelMode).toBe("untrusted");
    expect(runtime.permissionMode()).toBe("read-only");

    // The posture cannot be widened mid-session.
    runtime.setPermissionMode("accept-edits");
    expect(runtime.permissionMode()).toBe("read-only");
    runtime.setPlanMode(true);
    expect(runtime.permissionMode()).toBe("read-only");

    // Every mutating/executing kind the requirement names is refused by name.
    for (const action of [
      { kind: "fs.write" as const, target: path.join(workspace, "x.txt") },
      { kind: "shell.exec" as const, target: "touch x" },
      { kind: "spawn" as const, target: "code_mode" },
      { kind: "mcp.invoke" as const, target: "srv:tool" },
    ]) {
      expect(modeRefusal(runtime.permissionMode(), action)).toContain("read-only");
    }

    const target = path.join(workspace, "written.txt");
    const write = await runTool(workspace, runtime.permissionMode(), oneCall("write", { path: target, content: "x\n" }));
    expect(existsSync(target)).toBe(false);
    expect(write.asked).toHaveLength(0);
    expect(write.toolOutput).toContain("read-only");

    const marker = path.join(workspace, "shell-ran.txt");
    const shell = await runTool(workspace, runtime.permissionMode(), oneCall("shell", { command: `touch ${marker}` }));
    expect(existsSync(marker)).toBe(false);
    expect(shell.asked).toHaveLength(0);
    expect(shell.toolOutput).toContain("read-only");

    // code_mode maps to the spawn guard kind; read-only refuses it before the
    // program can run (so this cannot execute the harmless program either).
    const code = await runTool(workspace, runtime.permissionMode(), oneCall("code_mode", { code: "return 1;" }));
    expect(code.asked).toHaveLength(0);
    expect(code.toolOutput).toContain("read-only");
  } finally {
    await runtime.close();
  }
}, 60_000);

test("an explicit accept-edits request is narrowed to read-only when the kernel is absent", async () => {
  const { workspace } = kernellessWorkspace();
  const runtime = await createRuntime({ workspace, mock: true, permissionMode: "accept-edits" });
  try {
    expect(runtime.kernelMode).toBe("untrusted");
    expect(runtime.permissionMode()).toBe("read-only");
  } finally {
    await runtime.close();
  }
}, 60_000);

test("--allow-untrusted preserves the historical write-capable fallback", async () => {
  const { workspace } = kernellessWorkspace();
  const runtime = await createRuntime({ workspace, mock: true, allowUntrusted: true });
  try {
    expect(runtime.kernelMode).toBe("untrusted");
    expect(runtime.permissionMode()).toBe("default");

    const target = path.join(workspace, "allowed.txt");
    const write = await runTool(workspace, runtime.permissionMode(), oneCall("write", { path: target, content: "ok\n" }));
    expect(existsSync(target)).toBe(true);
    expect(write.asked).toHaveLength(0);
  } finally {
    await runtime.close();
  }
}, 60_000);
