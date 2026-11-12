/**
 * hygiene-evals.test.ts — key-free prompt/tool hygiene pack (docs/33 §5.11).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { RuntimeEvent } from "../../src/contracts";
import { createScriptedProvider, toolCallTurn } from "../../src/core/providers/scripted";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { kernelStateDir } from "../../src/core/owned-spawn";
import { SessionStore } from "../../src/core/session";

let workspace: string;
afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

function loopDeps(provider: ReturnType<typeof createScriptedProvider>): { deps: LoopDeps; seen: RuntimeEvent[] } {
  const kernel = new KernelClient({ workspace });
  const store = new SessionStore(workspace);
  const seen: RuntimeEvent[] = [];
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("hygiene").id,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: (ev) => seen.push(ev) },
    sessionLeases: [],
    approve: async () => true,
  };
  return { deps, seen };
}

function receiptTools(workspace: string): string[] {
  const file = path.join(kernelStateDir(workspace), "receipts.jsonl");
  try {
    const raw = readFileSync(file, "utf8").trim();
    if (raw === "") return [];
    return raw.split("\n").map((line) => (JSON.parse(line) as { tool: string }).tool);
  } catch {
    return [];
  }
}

describe("hygiene eval pack", () => {
  test("parallel tool calls in one assistant message both run", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hygiene-"));
    const targetA = path.join(workspace, "a.txt");
    const targetB = path.join(workspace, "b.txt");
    const provider = createScriptedProvider([
      toolCallTurn(
        { name: "write", args: { path: "a.txt", content: "A\n" } },
        { name: "write", args: { path: "b.txt", content: "B\n" } },
      ),
      { kind: "text", text: "done" },
    ]);
    const { deps, seen } = loopDeps(provider);
    await runTurn(deps, "write two files");
    expect(seen.filter((e) => e.type === "tool.card" && e.status === "ok" && e.name === "write").length).toBe(2);
    expect(Bun.file(targetA).size).toBeGreaterThan(0);
    expect(Bun.file(targetB).size).toBeGreaterThan(0);
  });

  test("prefer read over shell cat for file contents", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hygiene-"));
    writeFileSync(path.join(workspace, "src.txt"), "hello\n");
    const provider = createScriptedProvider([
      toolCallTurn({ name: "read", args: { path: "src.txt" } }),
      { kind: "text", text: "ok" },
    ]);
    const { deps, seen } = loopDeps(provider);
    await runTurn(deps, "read src.txt");
    expect(seen.some((e) => e.type === "tool.card" && e.name === "read" && e.status === "ok")).toBe(true);
    expect(seen.some((e) => e.type === "tool.card" && e.name === "shell")).toBe(false);
  });

  test("shell command without redundant cd when cwd is workspace", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hygiene-"));
    const provider = createScriptedProvider([
      toolCallTurn({ name: "shell", args: { command: "pwd", description: "show cwd" } }),
      { kind: "text", text: "ok" },
    ]);
    const { deps, seen } = loopDeps(provider);
    await runTurn(deps, "where am I");
    expect(seen.some((e) => e.type === "tool.card" && e.name === "shell" && e.status === "ok")).toBe(true);
  });

  test("every admitted shell call leaves a receipt", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hygiene-"));
    const provider = createScriptedProvider([
      toolCallTurn({ name: "shell", args: { command: "echo hz", description: "echo" } }),
      { kind: "text", text: "ok" },
    ]);
    const { deps, seen } = loopDeps(provider);
    await runTurn(deps, "echo");
    expect(seen.some((e) => e.type === "tool.card" && e.name === "shell" && e.status === "ok")).toBe(true);
    expect(receiptTools(workspace)).toContain("shell");
  });

  test("apply_patch with exact context succeeds", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hygiene-"));
    writeFileSync(path.join(workspace, "a.txt"), "alpha\nbeta\n");
    const patch =
      "*** Begin Patch\n*** Update File: a.txt\n@@\n alpha\n-beta\n+gamma\n*** End Patch\n";
    const provider = createScriptedProvider([
      toolCallTurn({ name: "read", args: { path: "a.txt" } }, { name: "apply_patch", args: { input: patch } }),
      { kind: "text", text: "patched" },
    ]);
    const { deps, seen } = loopDeps(provider);
    await runTurn(deps, "patch a.txt");
    expect(seen.some((e) => e.type === "tool.card" && e.name === "apply_patch" && e.status === "ok")).toBe(true);
    expect(readFileSync(path.join(workspace, "a.txt"), "utf8")).toContain("gamma");
  });

  test("multi-file apply_patch in one turn", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hygiene-"));
    writeFileSync(path.join(workspace, "one.txt"), "1\n");
    writeFileSync(path.join(workspace, "two.txt"), "2\n");
    const patch =
      "*** Begin Patch\n*** Update File: one.txt\n@@\n 1\n-1\n+one\n*** Update File: two.txt\n@@\n 2\n-2\n+two\n*** End Patch\n";
    const provider = createScriptedProvider([
      toolCallTurn(
        { name: "read", args: { path: "one.txt" } },
        { name: "read", args: { path: "two.txt" } },
        { name: "apply_patch", args: { input: patch } },
      ),
      { kind: "text", text: "done" },
    ]);
    const { deps, seen } = loopDeps(provider);
    await runTurn(deps, "patch both");
    expect(seen.filter((e) => e.type === "tool.card" && e.name === "apply_patch" && e.status === "ok").length).toBe(1);
    expect(readFileSync(path.join(workspace, "one.txt"), "utf8")).toContain("one");
    expect(readFileSync(path.join(workspace, "two.txt"), "utf8")).toContain("two");
  });

  test("prefer glob over shell for workspace file listing", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hygiene-"));
    writeFileSync(path.join(workspace, "only.txt"), "x\n");
    const provider = createScriptedProvider([
      toolCallTurn({ name: "glob", args: { pattern: "*.txt" } }),
      { kind: "text", text: "ok" },
    ]);
    const { deps, seen } = loopDeps(provider);
    await runTurn(deps, "list txt files");
    expect(seen.some((e) => e.type === "tool.card" && e.name === "glob" && e.status === "ok")).toBe(true);
    expect(seen.some((e) => e.type === "tool.card" && e.name === "shell")).toBe(false);
  });

  test("todo tool records checklist items", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hygiene-"));
    const provider = createScriptedProvider([
      toolCallTurn({
        name: "todo",
        args: { action: "add", text: "ship hygiene pack" },
      }),
      { kind: "text", text: "tracked" },
    ]);
    const { deps, seen } = loopDeps(provider);
    await runTurn(deps, "track work");
    expect(seen.some((e) => e.type === "tool.card" && e.name === "todo" && e.status === "ok")).toBe(true);
  });
});
