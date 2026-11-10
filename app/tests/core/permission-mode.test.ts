/**
 * permission-mode.test.ts: the named permission modes at the loop and the
 * pure policy functions. The load-bearing claims: accept-edits answers an
 * in-workspace write ASK without a human but never a shell ask or an outside
 * write; read-only refuses writes and shell even where the guard would allow;
 * no mode turns a kernel deny into an allow; bypass names are refused.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ApprovalHandler, ApprovalRequest, Provider, ProviderEvent } from "../../src/contracts";
import { createRuntime } from "../../src/core/index";
import { loadConfig } from "../../src/core/config";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { GuardGate, pathInsideWorkspace, runTurn } from "../../src/core/loop";
import { workspaceStateDir } from "../../src/core/paths";
import {
  isBypassName,
  modeAutoApproves,
  modeRefusal,
  parsePermissionMode,
  type PermissionMode,
} from "../../src/core/permission-mode";
import { SessionStore } from "../../src/core/session";

let workspace: string;
let outside: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-pmode-"));
  outside = mkdtempSync(path.join(tmpdir(), "hz-pmode-out-"));
  home = mkdtempSync(path.join(tmpdir(), "hz-pmode-home-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

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

type Rule = { kind: string; scope: string; decision: string };

/** Run one scripted call; `rules` writes a kernel policy.json (absent = shipped default). */
async function run(
  mode: PermissionMode,
  provider: Provider,
  rules?: Rule[],
): Promise<{ asked: ApprovalRequest[]; toolOutput: string }> {
  const stateDir = path.join(workspaceStateDir(workspace), "kernel");
  if (rules !== undefined) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "policy.json"), JSON.stringify(rules));
  }
  const kernel = new KernelClient({ workspace, stateDir });
  const store = new SessionStore(workspace);
  const asked: ApprovalRequest[] = [];
  let toolOutput = "";
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("pmode").id,
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
    // A human who says no to everything: any ask that reaches here is "asked".
    approve: async (req) => {
      asked.push(req);
      return false;
    },
    planMode: mode === "plan",
    permissionMode: mode === "plan" ? undefined : mode,
  };
  await runTurn(deps);
  return { asked, toolOutput };
}

const ASK_WORKSPACE_WRITES: Rule[] = [
  { kind: "fs.read", scope: "workspace", decision: "allow" },
  { kind: "fs.write", scope: "workspace", decision: "ask" },
  { kind: "fs.read", scope: "outside", decision: "ask" },
  { kind: "fs.write", scope: "outside", decision: "ask" },
  { kind: "shell.exec", scope: "*", decision: "ask" },
];

describe("accept-edits", () => {
  test("answers an in-workspace write ask without a human", async () => {
    const target = path.join(workspace, "edited.txt");
    const { asked } = await run("accept-edits", oneCall("write", { path: target, content: "x\n" }), ASK_WORKSPACE_WRITES);
    expect(existsSync(target)).toBe(true);
    expect(asked).toHaveLength(0);
  });

  test("default mode with the same policy asks the human (declined, nothing written)", async () => {
    const target = path.join(workspace, "edited.txt");
    const { asked } = await run("default", oneCall("write", { path: target, content: "x\n" }), ASK_WORKSPACE_WRITES);
    expect(existsSync(target)).toBe(false);
    expect(asked.length).toBeGreaterThan(0);
  });

  test("does NOT auto-approve shell", async () => {
    const marker = path.join(workspace, "ran.txt");
    const { asked } = await run("accept-edits", oneCall("shell", { command: `touch ${marker}` }), ASK_WORKSPACE_WRITES);
    expect(asked.some((r) => r.kind === "shell.exec")).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  test("does NOT auto-approve a write outside the workspace", async () => {
    const target = path.join(outside, "escape.txt");
    const { asked } = await run("accept-edits", oneCall("write", { path: target, content: "x\n" }), ASK_WORKSPACE_WRITES);
    expect(existsSync(target)).toBe(false);
    expect(asked.some((r) => r.kind === "fs.write")).toBe(true);
  });

  test("a kernel deny stays a deny (never turned into an allow)", async () => {
    const target = path.join(workspace, "denied.txt");
    const { asked, toolOutput } = await run("accept-edits", oneCall("write", { path: target, content: "x\n" }), [
      { kind: "fs.write", scope: "workspace", decision: "deny" },
    ]);
    expect(existsSync(target)).toBe(false);
    expect(asked).toHaveLength(0);
    expect(toolOutput).toContain("DENIED by policy");
  });

  test("a write into the kernel state dir is never approved", async () => {
    const target = path.join(workspaceStateDir(workspace), "kernel", "policy.json");
    mkdirSync(path.dirname(target), { recursive: true });
    const { toolOutput } = await run("accept-edits", oneCall("write", { path: target, content: "[]" }), ASK_WORKSPACE_WRITES);
    expect(toolOutput).toContain("DENIED");
  });
});

describe("read-only", () => {
  test("refuses a write even where the default policy allows it", async () => {
    const target = path.join(workspace, "w.txt");
    const { asked, toolOutput } = await run("read-only", oneCall("write", { path: target, content: "x\n" }));
    expect(existsSync(target)).toBe(false);
    expect(asked).toHaveLength(0);
    expect(toolOutput).toContain("read-only");
  });

  test("refuses shell without asking", async () => {
    const marker = path.join(workspace, "ran.txt");
    const { asked, toolOutput } = await run("read-only", oneCall("shell", { command: `touch ${marker}` }));
    expect(existsSync(marker)).toBe(false);
    expect(asked).toHaveLength(0);
    expect(toolOutput).toContain("read-only");
  });

  test("reads still work", async () => {
    writeFileSync(path.join(workspace, "r.txt"), "hello\n");
    const { toolOutput } = await run("read-only", oneCall("read", { path: path.join(workspace, "r.txt") }));
    expect(toolOutput).toContain('"status":"ok"');
  });
});

describe("default and plan", () => {
  test("default writes in the workspace as today", async () => {
    const target = path.join(workspace, "d.txt");
    await run("default", oneCall("write", { path: target, content: "x\n" }));
    expect(existsSync(target)).toBe(true);
  });

  test("plan stages instead of writing", async () => {
    const target = path.join(workspace, "p.txt");
    await run("plan", oneCall("write", { path: target, content: "x\n" }));
    expect(existsSync(target)).toBe(false);
  });
});

describe("policy functions", () => {
  const fsw = (target: string) => ({ kind: "fs.write" as const, target });
  test("modeRefusal is read-only only, and only for writes and shell", () => {
    expect(modeRefusal("read-only", fsw("/w/a"))).toContain("read-only");
    expect(modeRefusal("read-only", { kind: "shell.exec", target: "ls" })).toContain("read-only");
    expect(modeRefusal("read-only", { kind: "fs.read", target: "/w/a" })).toBeUndefined();
    expect(modeRefusal("accept-edits", fsw("/w/a"))).toBeUndefined();
    expect(modeRefusal("default", fsw("/w/a"))).toBeUndefined();
  });

  test("modeAutoApproves: accept-edits, fs.write, inside the workspace, not .git/.hz", () => {
    const ws = workspace;
    const inside = pathInsideWorkspace;
    expect(modeAutoApproves("accept-edits", fsw(path.join(ws, "a.ts")), ws, inside)).toBe(true);
    expect(modeAutoApproves("accept-edits", fsw(path.join(outside, "a.ts")), ws, inside)).toBe(false);
    expect(modeAutoApproves("accept-edits", fsw(path.join(ws, ".git", "config")), ws, inside)).toBe(false);
    expect(modeAutoApproves("accept-edits", fsw(path.join(ws, ".hz", "x")), ws, inside)).toBe(false);
    expect(modeAutoApproves("accept-edits", { kind: "shell.exec", target: "ls" }, ws, inside)).toBe(false);
    expect(modeAutoApproves("accept-edits", { kind: "net.fetch", target: "https://x" }, ws, inside)).toBe(false);
    expect(modeAutoApproves("default", fsw(path.join(ws, "a.ts")), ws, inside)).toBe(false);
    expect(modeAutoApproves("read-only", fsw(path.join(ws, "a.ts")), ws, inside)).toBe(false);
  });

  test("an in-workspace symlink pointing outside is not auto-approved", async () => {
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, path.join(workspace, "link"));
    expect(modeAutoApproves("accept-edits", fsw(path.join(workspace, "link", "f.txt")), workspace, pathInsideWorkspace)).toBe(false);
  });

  test("parse accepts names and spellings; bypass names are refused", () => {
    expect(parsePermissionMode("accept-edits")).toBe("accept-edits");
    expect(parsePermissionMode("acceptEdits")).toBe("accept-edits");
    expect(parsePermissionMode("READ-ONLY")).toBe("read-only");
    expect(parsePermissionMode("plan")).toBe("plan");
    expect(parsePermissionMode("yolo")).toBeUndefined();
    expect(parsePermissionMode("bypassPermissions")).toBeUndefined();
    expect(isBypassName("yolo")).toBe(true);
    expect(isBypassName("bypass")).toBe(true);
    expect(isBypassName("read-only")).toBe(false);
  });
});

describe("config default is user-file only", () => {
  test("permissionMode comes from the user config file", () => {
    const file = path.join(home, "config.json");
    writeFileSync(file, JSON.stringify({ permissionMode: "read-only" }));
    expect(loadConfig({}, file).permissionMode).toBe("read-only");
  });

  test("a bypass value in config is ignored and named", () => {
    const file = path.join(home, "config.json");
    writeFileSync(file, JSON.stringify({ permissionMode: "yolo" }));
    const cfg = loadConfig({}, file);
    expect(cfg.permissionMode).toBeUndefined();
    expect(cfg.permissionModeRejected).toContain("bypass");
  });

  test("a workspace file is never read for the mode", () => {
    writeFileSync(path.join(workspace, "config.json"), JSON.stringify({ permissionMode: "accept-edits" }));
    mkdirSync(path.join(workspace, ".hz"), { recursive: true });
    writeFileSync(path.join(workspace, ".hz", "config.json"), JSON.stringify({ permissionMode: "accept-edits" }));
    expect(loadConfig({}, path.join(home, "absent.json")).permissionMode).toBeUndefined();
  });
});

describe("runtime mode state", () => {
  test("starts from the option, /mode plan and back keep one source of truth", async () => {
    const rt = await createRuntime({ workspace, mock: true, permissionMode: "read-only" });
    try {
      expect(rt.permissionMode()).toBe("read-only");
      expect(rt.planMode()).toBe(false);
      rt.setPermissionMode("plan");
      expect(rt.permissionMode()).toBe("plan");
      expect(rt.planMode()).toBe(true);
      rt.setPermissionMode("accept-edits");
      expect(rt.permissionMode()).toBe("accept-edits");
      expect(rt.planMode()).toBe(false);
      expect(() => rt.setPermissionMode("yolo" as PermissionMode)).toThrow();
    } finally {
      await rt.close();
    }
  }, 30000);

  test("default when nothing asks for a mode", async () => {
    const rt = await createRuntime({ workspace, mock: true });
    try {
      expect(rt.permissionMode()).toBe("default");
    } finally {
      await rt.close();
    }
  }, 30000);
});

describe("review fixes", () => {
  const fsw = (target: string) => ({ kind: "fs.write" as const, target });

  test("accept-edits does not auto-answer CI, hook, manifest or shell-rc files", () => {
    const ws = workspace;
    for (const rel of [
      ".github/workflows/ci.yml", ".husky/pre-commit", ".envrc", "package.json", "packages/a/package.json", ".bashrc", ".zshrc",
      ".gitlab-ci.yml", "Makefile", ".env.local", "Dockerfile", ".circleci/config.yml",
    ]) {
      expect(modeAutoApproves("accept-edits", fsw(path.join(ws, rel)), ws, pathInsideWorkspace)).toBe(false);
    }
    expect(modeAutoApproves("accept-edits", fsw(path.join(ws, "src", "a.ts")), ws, pathInsideWorkspace)).toBe(true);
    expect(modeAutoApproves("accept-edits", fsw(path.join(ws, "docs", "package.json.md")), ws, pathInsideWorkspace)).toBe(true);
  });

  test("v3: an in-workspace symlink to a sensitive dir or file is judged by its real target", async () => {
    const { symlinkSync } = await import("node:fs");
    mkdirSync(path.join(workspace, ".git", "hooks"), { recursive: true });
    writeFileSync(path.join(workspace, "package.json"), "{}");
    symlinkSync(path.join(workspace, ".git"), path.join(workspace, "gitlink"));
    symlinkSync(path.join(workspace, "package.json"), path.join(workspace, "notes.md"));
    for (const rel of ["gitlink/hooks/pre-commit", "gitlink/config", "notes.md"]) {
      expect(modeAutoApproves("accept-edits", fsw(path.join(workspace, rel)), workspace, pathInsideWorkspace)).toBe(false);
    }
  });

  test("v3: sensitive directory names match case-insensitively (case-insensitive filesystems)", () => {
    const ws = workspace;
    for (const rel of [".GIT/hooks/pre-commit", ".Hz/x", ".GitHub/workflows/ci.yml", "sub/.HUSKY/pre-commit"]) {
      expect(modeAutoApproves("accept-edits", fsw(path.join(ws, rel)), ws, pathInsideWorkspace)).toBe(false);
    }
  });

  test("a sensitive file under accept-edits reaches the human", async () => {
    const r = await run("accept-edits", oneCall("write", { path: "package.json", content: "{}" }), ASK_WORKSPACE_WRITES);
    expect(r.asked.length).toBe(1);
    expect(existsSync(path.join(workspace, "package.json"))).toBe(false);
  });

  describe("guardian enforce runs before the accept-edits auto-answer", () => {
    const saved = process.env.HORIZON_GUARDIAN;
    afterEach(() => {
      if (saved === undefined) delete process.env.HORIZON_GUARDIAN;
      else process.env.HORIZON_GUARDIAN = saved;
    });
    const kernel = { checkGuard: async () => ({ decision: "ask", reason: "needs approval" }) } as unknown as KernelClient;
    const ask = (): Promise<boolean> => {
      const gate = new GuardGate(workspace, kernel, [], () => (async () => false) as unknown as ApprovalHandler, undefined, "accept-edits");
      const target = path.join(workspace, ".ssh", "config");
      return gate.approve({ title: "Write", detail: target, kind: "fs.write" }, fsw(target));
    };
    test("enforce refuses a guardian deny in accept-edits", async () => {
      process.env.HORIZON_GUARDIAN = "enforce";
      expect(await ask()).toBe(false);
    });
    test("advisory default still auto-answers it", async () => {
      delete process.env.HORIZON_GUARDIAN;
      expect(await ask()).toBe(true);
    });
  });

  test("read-only refuses mcp.invoke too", () => {
    expect(modeRefusal("read-only", { kind: "mcp.invoke", target: "srv:tool" })).toContain("mcp.invoke");
    expect(modeRefusal("accept-edits", { kind: "mcp.invoke", target: "srv:tool" })).toBeUndefined();
  });

  test("plan mode: the agent tool is refused, so no child can be looser than the plan", async () => {
    const r = await run("plan", oneCall("agent", { task: "write a file", profile: "code" }));
    expect(r.toolOutput).toContain("subagents are not spawned while planning");
  });
});
