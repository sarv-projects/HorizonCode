/**
 * plan-loop.test.ts — plan mode's one load-bearing claim, proven at the loop:
 * while the session is in plan mode a write call is STAGED (nothing touches the
 * disk), the stage is inspectable, and /discard drops it. In normal mode the
 * same scripted call performs the real write. This is the integration the
 * plan-mode unit tests (stub runtime) deliberately do not cover.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { runTurn } from "../../src/core/loop";
import { discardStaged, stagedChanges } from "../../src/core/plan";
import { workspaceStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";
import { discoverDeferredTools } from "../../src/tools";

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

/** One arbitrary tool call, then one clean end. */
function callThenDone(name: string, args: Record<string, unknown>): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream() {
      turn += 1;
      if (turn === 1) {
        yield {
          type: "tool_call",
          id: "call_1",
          name,
          arguments: JSON.stringify(args),
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
  }, 30_000);

  test("the same call in normal mode writes" , async () => {
    const target = path.join(workspace, "written.txt");
    const { deps } = depsFor(writeThenDone(target), false);

    await runTurn(deps);

    expect(existsSync(target)).toBe(true);
    expect(stagedChanges(deps.sessionId)).toHaveLength(0);
  }, 30_000);

  test("an edit in plan mode is staged, not written", async () => {
    const target = path.join(workspace, "edit-me.txt");
    writeFileSync(target, "old line\n");

    const { deps } = depsFor(callThenDone("edit", { path: target, old: "old line", new: "new line" }), true);
    await runTurn(deps);

    expect(readFileSync(target, "utf8")).toBe("old line\n");
    const staged = stagedChanges(deps.sessionId);
    expect(staged).toHaveLength(1);
    expect(staged[0].after).toBe("new line\n");
    discardStaged(deps.sessionId);
  }, 30_000);

  test("a mutating shell command is refused by the read-only allowlist", async () => {
    const keep = path.join(workspace, "keep.txt");
    writeFileSync(keep, "must survive\n");

    const { deps, seen } = depsFor(callThenDone("shell", { command: `rm -f ${keep}` }), true);
    await runTurn(deps);

    expect(existsSync(keep)).toBe(true);
    const output = JSON.stringify(seen);
    expect(output).toContain("plan mode: shell refused");
    expect(output).toContain("not a read-only command: rm");
  }, 30_000);

  test("an investigative shell command is not refused by plan mode", async () => {
    const { deps, seen } = depsFor(callThenDone("shell", { command: "pwd" }), true);
    await runTurn(deps);

    expect(JSON.stringify(seen)).not.toContain("plan mode: shell refused");
  }, 30_000);

  test("mutating and out-of-band tools stay refused while planning", async () => {
    const refused: Array<[string, string]> = [
      ["apply_patch", "plan mode: apply_patch"],
      ["ast_edit", "plan mode: ast_edit"],
      ["shell_session", "plan mode: interactive sessions"],
      ["undo", "plan mode: undo"],
      ["agent", "plan mode: subagents"],
      ["code_mode", "plan mode: code programs"],
      ["preview", "plan mode: dev servers"],
    ];
    for (const [name, expected] of refused) {
      const { deps, seen } = depsFor(callThenDone(name, {}), true);
      // preview is a Deferred tool; discover it so the test exercises the
      // plan-mode refusal rather than the undiscovered-tool refusal.
      discoverDeferredTools(deps.sessionId, [name]);
      await runTurn(deps);
      expect(JSON.stringify(seen), `expected ${name} to be refused in plan mode`).toContain(expected);
    }
  }, 120_000);
});
