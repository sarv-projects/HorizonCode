/**
 * postmortem-loop.test.ts — the loop-level half of item 8: a run that does not
 * succeed records a post-mortem from within runTurn itself (wave 14 wiring),
 * best-effort, and a succeeded run records nothing. The module-level tests live
 * in postmortems-evals.test.ts; this file proves the wiring, which is exactly
 * what used to be missing (postmortem.ts said so in its own header).
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
import { loadPostmortems } from "../../src/core/postmortem";
import { SessionStore } from "../../src/core/session";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-postmortem-loop-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function failingProvider(): Provider {
  return {
    name: "scripted",
    async *stream() {
      throw new Error("provider exploded");
    },
  };
}

function doneProvider(): Provider {
  return {
    name: "scripted",
    async *stream() {
      yield { type: "done", stopReason: "end" } as ProviderEvent;
    },
  };
}

function depsFor(provider: Provider): { deps: LoopDeps; seen: RuntimeEvent[] } {
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspaceStateDir(workspace), "kernel") });
  const store = new SessionStore(workspace);
  const seen: RuntimeEvent[] = [];
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("postmortem").id,
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

describe("post-mortem recording from the loop", () => {
  test("a failing run records one post-mortem naming the failure class", async () => {
    const { deps } = depsFor(failingProvider());
    const turn = await runTurn(deps);
    expect(turn.exit?.terminal).not.toBe("succeeded");

    const loaded = await loadPostmortems(workspaceStateDir(workspace));
    expect(loaded.postmortems).toHaveLength(1);
    const record = loaded.postmortems[0];
    expect(record.failureClass).toBe("provider_error");
    expect(record.terminal).toBe(turn.exit?.terminal as string);
    expect(record.sessionId).toBe(deps.sessionId);
  });

  test("a succeeded run records nothing", async () => {
    const { deps } = depsFor(doneProvider());
    const turn = await runTurn(deps);
    expect(turn.exit?.terminal).toBe("succeeded");

    const loaded = await loadPostmortems(workspaceStateDir(workspace));
    expect(loaded.postmortems).toHaveLength(0);
  });
});
