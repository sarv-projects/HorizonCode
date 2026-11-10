/**
 * runtime-residuals.test.ts: runtime-depth FEAT-005 (docs/28 ruling 66).
 *  (a) shell refuses invisible Unicode BEFORE admission (no approval prompt),
 *  (b) guardian enforce mode fails closed when the classifier throws,
 *  (c) accept-edits sensitive list covers more code-running config files,
 *  (d) the lazy nested-instruction dedup set refreshes on an eager change.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ApprovalHandler, ApprovalRequest, GuardAction, GuardDecision, Provider, ProviderEvent } from "../../src/contracts";
import { LazyInstructions, lazyInstructionsFor, loadInstructionBlocks } from "../../src/core/instructions";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { GuardGate, pathInsideWorkspace, runTurn } from "../../src/core/loop";
import { workspaceStateDir } from "../../src/core/paths";
import { modeAutoApproves } from "../../src/core/permission-mode";
import { SessionStore } from "../../src/core/session";

let workspace: string;
const savedGuardian = process.env.HORIZON_GUARDIAN;
beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-resid-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  if (savedGuardian === undefined) delete process.env.HORIZON_GUARDIAN;
  else process.env.HORIZON_GUARDIAN = savedGuardian;
});

describe("(a) shell invisible Unicode is refused before admission", () => {
  test("no guard check and no approval prompt for a command the tool would refuse", async () => {
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspaceStateDir(workspace), "kernel") });
    const store = new SessionStore(workspace);
    const checks: string[] = [];
    kernel.checkGuard = (async (action: GuardAction): Promise<GuardDecision> => {
      checks.push(action.kind);
      return { decision: "ask", reason: "test ask" } as unknown as GuardDecision;
    }) as typeof kernel.checkGuard;
    let prompts = 0;
    let turn = 0;
    const provider: Provider = {
      name: "scripted",
      async *stream() {
        turn += 1;
        const events: ProviderEvent[] =
          turn === 1
            ? [{ type: "tool_call", id: "c1", name: "shell", arguments: JSON.stringify({ command: "echo hi\u202e" }) }, { type: "done", stopReason: "tool_use" }]
            : [{ type: "text", text: "ok" }, { type: "done", stopReason: "end" }];
        for (const e of events) yield e;
      },
    };
    const seen: string[] = [];
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("resid").id,
      model: "scripted-1",
      provider,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: (ev) => seen.push(JSON.stringify(ev)) },
      sessionLeases: [],
      approve: async () => {
        prompts += 1;
        return true;
      },
    };
    try {
      await runTurn(deps, "go");
    } finally {
      await kernel.close();
      store.close();
    }
    expect(prompts).toBe(0);
    expect(checks.filter((k) => k === "shell.exec")).toHaveLength(0);
    expect(seen.join("\n")).toContain("invisible");
  });
});

describe("(b) guardian enforce fails closed when the review cannot run", () => {
  const kernel = { checkGuard: async () => ({ decision: "ask", reason: "needs approval" }) } as unknown as import("../../src/core/kernel").KernelClient;
  // A target that is not a string makes reviewAction throw invalid-input, the
  // same path as a classifier that throws.
  const broken = { kind: "shell.exec", target: 5 } as unknown as GuardAction;

  function ask(): { prompts: number[]; result: Promise<boolean> } {
    const prompts: number[] = [];
    const gate = new GuardGate("/ws", kernel, [], () => (async (_req: ApprovalRequest) => {
      prompts.push(1);
      return true;
    }) as unknown as ApprovalHandler);
    return { prompts, result: gate.approve({ title: "Run", detail: "x", kind: "shell.exec" }, broken) };
  }

  test("enforce: refused without prompting", async () => {
    process.env.HORIZON_GUARDIAN = "enforce";
    const r = ask();
    expect(await r.result).toBe(false);
    expect(r.prompts).toHaveLength(0);
  });

  test("advisory: fails open, the human is still asked", async () => {
    delete process.env.HORIZON_GUARDIAN;
    const r = ask();
    expect(await r.result).toBe(true);
    expect(r.prompts).toHaveLength(1);
  });
});

describe("(c) accept-edits sensitive list", () => {
  const fsw = (rel: string) => ({ kind: "fs.write" as const, target: path.join(workspace, rel) });
  test.each([
    ".cargo/config.toml", ".cargo/config", "crates/a/.cargo/config.toml", "rust-toolchain.toml", "rust-toolchain", ".tool-versions", "pyproject.toml",
    "svc/pyproject.toml", "tox.ini", "noxfile.py", "Rakefile", "rakefile.rb", "Gemfile", "RUST-TOOLCHAIN.TOML", ".CARGO/config.toml",
  ])("%s is never auto-answered", (rel) => {
    expect(modeAutoApproves("accept-edits", fsw(rel), workspace, pathInsideWorkspace)).toBe(false);
  });
  test("neighbours stay auto-answered (go.mod is data, not a hook)", () => {
    for (const rel of ["go.mod", "go.sum", "Cargo.toml", "Gemfile.lock", "src/main.rs", "docs/pyproject.toml.md", "cargo/config.toml"]) {
      expect(modeAutoApproves("accept-edits", fsw(rel), workspace, pathInsideWorkspace)).toBe(true);
    }
  });
});

describe("(d) lazy dedup refreshes when an eager instruction file changes", () => {
  test("a nested file that duplicated the OLD eager text is loaded after the edit", () => {
    const root = path.join(workspace, "repo");
    mkdirSync(path.join(root, ".git"), { recursive: true });
    mkdirSync(path.join(root, "pkg"), { recursive: true });
    writeFileSync(path.join(root, "AGENTS.md"), "Use tabs.\n");
    writeFileSync(path.join(root, "pkg", "AGENTS.md"), "Use tabs.\n");
    const home = path.join(workspace, "home");
    mkdirSync(home, { recursive: true });

    const first = loadInstructionBlocks(root, { home });
    const lazy = lazyInstructionsFor(root, "s-refresh", first.blocks);
    // Identical to the eager text: dropped, as designed.
    expect(lazy.discover(path.join(root, "pkg", "a.ts"))).toHaveLength(0);

    // The eager file changes mid-session.
    writeFileSync(path.join(root, "AGENTS.md"), "Use spaces.\n");
    const second = loadInstructionBlocks(root, { home });
    const same = lazyInstructionsFor(root, "s-refresh", second.blocks);
    expect(same).toBe(lazy);
    const found = same.discover(path.join(root, "pkg", "a.ts"));
    expect(found.map((b) => b.rel)).toEqual([path.join("pkg", "AGENTS.md")]);
    // Still exactly once afterwards.
    expect(same.discover(path.join(root, "pkg", "b.ts"))).toHaveLength(0);
  });

  test("a nested file now equal to the NEW eager text is not injected twice", () => {
    const root = path.join(workspace, "repo2");
    mkdirSync(path.join(root, ".git"), { recursive: true });
    mkdirSync(path.join(root, "pkg"), { recursive: true });
    writeFileSync(path.join(root, "AGENTS.md"), "Rule A.\n");
    writeFileSync(path.join(root, "pkg", "AGENTS.md"), "Rule B.\n");
    const home = path.join(workspace, "home2");
    mkdirSync(home, { recursive: true });
    const lazy = new LazyInstructions(root, loadInstructionBlocks(root, { home }).blocks);
    writeFileSync(path.join(root, "AGENTS.md"), "Rule B.\n");
    lazy.refreshEager(loadInstructionBlocks(root, { home }).blocks);
    expect(lazy.discover(path.join(root, "pkg", "a.ts"))).toHaveLength(0);
  });
});
