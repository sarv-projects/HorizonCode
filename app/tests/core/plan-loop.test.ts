/**
 * plan-loop.test.ts — plan mode's one load-bearing claim, proven at the loop:
 * while the session is in plan mode a write call is STAGED (nothing touches the
 * disk), the stage is inspectable, and /discard drops it. In normal mode the
 * same scripted call performs the real write. This is the integration the
 * plan-mode unit tests (stub runtime) deliberately do not cover.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { runTurn } from "../../src/core/loop";
import { discardStaged, stagedChanges } from "../../src/core/plan";
import { workspaceStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-plan-loop-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** One write call, then one clean end. */
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
          arguments: JSON.stringify({ path: target, content: "planned bytes\n" }),
        } satisfies ProviderEvent;
        yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
        return;
      }
      yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
    },
  };
}

function depsFor(provider: Provider, planMode: boolean): { deps: LoopDeps; seen: RuntimeEvent[] } {
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspaceStateDir(workspace), "kernel") });
  const store = new SessionStore(workspace);
  const seen: RuntimeEvent[] = [];
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("plan-loop").id,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: (ev) => seen.push(ev) },
    sessionLeases: [],
    approve: async () => true,
    planMode,
  };
  return { deps, seen };
}

describe("plan mode at the loop", () => {
  test("a write in plan mode is staged, not written", async () => {
    const target = path.join(workspace, "planned.txt");
    const { deps } = depsFor(writeThenDone(target), true);

    await runTurn(deps);

    expect(existsSync(target)).toBe(false);
    const staged = stagedChanges(deps.sessionId);
    expect(staged).toHaveLength(1);
    expect(staged[0].rel).toBe("planned.txt");
    expect(staged[0].after).toBe("planned bytes\n");
    discardStaged(deps.sessionId);
    expect(stagedChanges(deps.sessionId)).toHaveLength(0);
  });

  test("the same call in normal mode writes" , async () => {
    const target = path.join(workspace, "written.txt");
    const { deps } = depsFor(writeThenDone(target), false);

    await runTurn(deps);

    expect(existsSync(target)).toBe(true);
    expect(stagedChanges(deps.sessionId)).toHaveLength(0);
  });
});
