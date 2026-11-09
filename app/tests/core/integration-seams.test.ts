/**
 * integration-seams.test.ts: seams between the merged feature streams.
 * Plan mode refuses the newer mutating tools, expected failures (edit misses,
 * denials) do not feed the consecutive-mistake rail, and the per-session tool
 * discovery registry can be cleared.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { runTurn } from "../../src/core/loop";
import { workspaceStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";
import { clearDiscoveredTools, discoverDeferredTools, isDiscovered } from "../../src/tools";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-seams-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function script(turns: ProviderEvent[][]): Provider {
  let i = 0;
  return {
    name: "scripted",
    async *stream() {
      const events = turns[Math.min(i, turns.length - 1)] ?? [];
      i += 1;
      for (const e of events) yield e;
    },
  };
}

const call = (name: string, args: unknown, id: string): ProviderEvent => ({
  type: "tool_call",
  id,
  name,
  arguments: JSON.stringify(args),
});
const USE: ProviderEvent = { type: "done", stopReason: "tool_use" };
const END: ProviderEvent = { type: "done", stopReason: "end" };

function depsFor(provider: Provider, planMode: boolean, approve = true) {
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspaceStateDir(workspace), "kernel") });
  const store = new SessionStore(workspace);
  const seen: RuntimeEvent[] = [];
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("seams").id,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: (ev) => seen.push(ev) },
    sessionLeases: [],
    approve: async () => approve,
    planMode,
  };
  return { deps, seen, kernel, store };
}

describe("plan mode refuses apply_patch, ast_edit and shell_session", () => {
  test("apply_patch does not touch the disk", async () => {
    const patch = "*** Begin Patch\n*** Add File: made.txt\n+hello\n*** End Patch";
    const { deps, seen, kernel, store } = depsFor(script([[call("apply_patch", { input: patch }, "c1"), USE], [END]]), true);
    try {
      await runTurn(deps, "go");
      expect(existsSync(path.join(workspace, "made.txt"))).toBe(false);
      expect(JSON.stringify(seen)).toContain("plan mode: apply_patch");
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("ast_edit leaves the file unchanged", async () => {
    const file = path.join(workspace, "a.ts");
    writeFileSync(file, "const a = 1;\n");
    const args = { path: "a.ts", pattern: "const a = 1", replacement: "const a = 2" };
    const { deps, seen, kernel, store } = depsFor(script([[call("ast_edit", args, "c1"), USE], [END]]), true);
    try {
      await runTurn(deps, "go");
      expect(await Bun.file(file).text()).toBe("const a = 1;\n");
      expect(JSON.stringify(seen)).toContain("plan mode: ast_edit");
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("shell_session start is refused", async () => {
    const marker = path.join(workspace, "ran.txt");
    const args = { mode: "start", command: `touch ${marker}` };
    const { deps, seen, kernel, store } = depsFor(script([[call("shell_session", args, "c1"), USE], [END]]), true);
    try {
      await runTurn(deps, "go");
      expect(existsSync(marker)).toBe(false);
      expect(JSON.stringify(seen)).toContain("plan mode: interactive sessions");
    } finally {
      await kernel.close();
      store.close();
    }
  });
});

describe("mistake tracker exclusions", () => {
  test("repeated edit misses do not end the run as consecutive_mistakes", async () => {
    const miss = (n: number): ProviderEvent[] => [
      call("edit", { path: `nope-${n}.txt`, old: "a", new: "b" }, `c${n}`),
      USE,
    ];
    const { deps, kernel, store } = depsFor(script([miss(1), miss(2), miss(3), miss(4), [END]]), false);
    try {
      const result = await runTurn(deps, "edit");
      expect(result.exit.detail).not.toBe("consecutive_mistakes");
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("user-declined shell calls do not end the run as consecutive_mistakes", async () => {
    const decl = (n: number): ProviderEvent[] => [
      call("shell", { command: `echo ${n}` }, `c${n}`),
      USE,
    ];
    const { deps, kernel, store } = depsFor(script([decl(1), decl(2), decl(3), decl(4), [END]]), false, false);
    try {
      const result = await runTurn(deps, "write");
      expect(result.exit.detail).not.toBe("consecutive_mistakes");
    } finally {
      await kernel.close();
      store.close();
    }
  });
});

describe("discovery registry cleanup", () => {
  test("clearDiscoveredTools drops one session only", () => {
    discoverDeferredTools("s-a", ["x"]);
    discoverDeferredTools("s-b", ["x"]);
    clearDiscoveredTools("s-a");
    expect(isDiscovered("s-a", "x")).toBe(false);
    expect(isDiscovered("s-b", "x")).toBe(true);
    clearDiscoveredTools("s-b");
  });
});
