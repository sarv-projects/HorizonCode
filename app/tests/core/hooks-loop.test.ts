/**
 * hooks-loop.test.ts — hooks v1 at the loop: a pre-tool deny sinks into the
 * standard tool-result shape and the tool never runs; a malformed hooks config
 * is fail-closed (every call denied with the file named); a failing post hook
 * is a notice and never blocks the effect that already ran.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { loadHooks } from "../../src/core/hooks";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { runTurn } from "../../src/core/loop";
import { workspaceStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";

const FIXTURES = path.join(import.meta.dir, "..", "fixtures", "hooks");

let workspace: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-hooks-loop-"));
  home = mkdtempSync(path.join(tmpdir(), "hz-hooks-home-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function writeThenDone(target: string): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream() {
      turn += 1;
      if (turn === 1) {
        yield {
          type: "tool_call",
          id: "call_1",
          name: "write",
          arguments: JSON.stringify({ path: target, content: "bytes\n" }),
        } satisfies ProviderEvent;
        yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
        return;
      }
      yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
    },
  };
}

function depsFor(provider: Provider): { deps: LoopDeps; seen: RuntimeEvent[] } {
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspaceStateDir(workspace), "kernel") });
  const store = new SessionStore(workspace);
  const seen: RuntimeEvent[] = [];
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("hooks-loop").id,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: (ev) => seen.push(ev) },
    sessionLeases: [],
    approve: async () => true,
    hooks: loadHooks(workspace, { home }),
  };
  return { deps, seen };
}

function configHooks(doc: unknown): void {
  mkdirSync(path.join(workspace, ".hz"), { recursive: true });
  writeFileSync(path.join(workspace, ".hz", "hooks.json"), JSON.stringify(doc));
}

describe("hooks at the loop", () => {
  test("a pre-tool deny sinks into the tool result and the write never happens", async () => {
    configHooks({
      hooks: {
        preTool: [
          { match: { tool: "write" }, command: process.execPath, args: [path.join(FIXTURES, "deny-with-reason.js")] },
        ],
      },
    });
    const target = path.join(workspace, "hooked.txt");
    const { deps, seen } = depsFor(writeThenDone(target));

    await runTurn(deps);

    expect(existsSync(target)).toBe(false);
    expect(JSON.stringify(seen)).toContain("DENIED by hook");
  });

  test("a malformed hooks config is fail-closed", async () => {
    configHooks({ hooks: { preTool: [{ command: 5 }] } });
    const target = path.join(workspace, "failclosed.txt");
    const { deps, seen } = depsFor(writeThenDone(target));

    await runTurn(deps);

    expect(existsSync(target)).toBe(false);
    expect(JSON.stringify(seen)).toContain("hooks config");
  });

  test("a failing post hook notices but never blocks the effect", async () => {
    configHooks({
      hooks: {
        postTool: [
          { match: { tool: "write" }, command: "bash", args: [path.join(FIXTURES, "exit-code-3.sh")] },
        ],
      },
    });
    const target = path.join(workspace, "postfail.txt");
    const { deps, seen } = depsFor(writeThenDone(target));

    await runTurn(deps);

    expect(existsSync(target)).toBe(true);
    expect(JSON.stringify(seen).toLowerCase()).toContain("hook");
  });
});
