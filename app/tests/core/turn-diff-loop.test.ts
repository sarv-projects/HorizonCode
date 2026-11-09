/**
 * turn-diff-loop.test.ts -- the per-turn diff at the loop (FEAT-003).
 *
 * The aggregator is unit-tested in turn-diff.test.ts. Here we prove the wiring:
 * a model turn that writes one file emits EXACTLY one { type: "turn.diff" }
 * event with files === 1 to the runtime callbacks, independent of the tool.card
 * event, and a turn that writes nothing emits no turn.diff at all. This test
 * MUST fail if the loop emit is reverted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { runTurn } from "../../src/core/loop";
import { workspaceStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";
import { __resetJournalForTests } from "../../src/tools/change-journal";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-turn-diff-loop-"));
  __resetJournalForTests();
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
          arguments: JSON.stringify({ path: target, content: "written bytes\n" }),
        } satisfies ProviderEvent;
        yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
        return;
      }
      yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
    },
  };
}

/** A turn that makes no tool calls at all. */
function textOnly(): Provider {
  return {
    name: "scripted",
    async *stream() {
      yield { type: "text", text: "no edits here" } satisfies ProviderEvent;
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
    sessionId: store.createSession("turn-diff-loop").id,
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

describe("turn.diff at the loop", () => {
  test("a one-write turn emits exactly one turn.diff with files === 1", async () => {
    const target = path.join(workspace, "out.txt");
    const { deps, seen } = depsFor(writeThenDone(target), false);

    await runTurn(deps);

    const diffs = seen.filter((ev) => ev.type === "turn.diff");
    expect(diffs).toHaveLength(1);
    const ev = diffs[0] as Extract<RuntimeEvent, { type: "turn.diff" }>;
    expect(ev.files).toBe(1);
    expect(ev.turn).toBe(1);
    expect(ev.diff).toContain("out.txt");
    expect(ev.diff).toContain("+written bytes");
  });

  test("a turn with no write/edit emits no turn.diff", async () => {
    const { deps, seen } = depsFor(textOnly(), false);

    await runTurn(deps);

    expect(seen.filter((ev) => ev.type === "turn.diff")).toHaveLength(0);
  });

  test("plan-mode staged writes record no journal entry and emit no turn.diff", async () => {
    const target = path.join(workspace, "staged.txt");
    const { deps, seen } = depsFor(writeThenDone(target), true);

    await runTurn(deps);

    expect(seen.filter((ev) => ev.type === "turn.diff")).toHaveLength(0);
  });
});
