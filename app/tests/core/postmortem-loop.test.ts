/**
 * postmortem-loop.test.ts — the loop-level half of item 8: a run that does not
 * succeed records a post-mortem from within runTurn itself (wave 14 wiring),
 * best-effort, and a succeeded run records nothing. The module-level tests live
 * in postmortems-evals.test.ts; this file proves the wiring, which is exactly
 * what used to be missing (postmortem.ts said so in its own header).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { runTurn } from "../../src/core/loop";
import { workspaceStateDir } from "../../src/core/paths";
import { loadPostmortems, postmortemsDir } from "../../src/core/postmortem";
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

async function depsFor(provider: Provider): Promise<{ deps: LoopDeps; seen: RuntimeEvent[] }> {
  // Force the in-process LocalKernel (no Rust spawn) so under-admission checks
  // stay hermetic and under the default 5s test budget on slow hosts.
  const kernel = new KernelClient({
    workspace,
    stateDir: path.join(workspaceStateDir(workspace), "kernel"),
    pinEnv: { HZ_KERNEL_BIN: path.join(workspace, "no-such-hz-kernel") },
  });
  await kernel.start();
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
    const { deps } = await depsFor(failingProvider());
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
    const { deps } = await depsFor(doneProvider());
    const turn = await runTurn(deps);
    expect(turn.exit?.terminal).toBe("succeeded");

    const loaded = await loadPostmortems(workspaceStateDir(workspace));
    expect(loaded.postmortems).toHaveLength(0);
  });

  test("refuses post-mortem write when policy denies fs.write (ruling 562)", async () => {
    const kernelState = path.join(workspaceStateDir(workspace), "kernel");
    mkdirSync(kernelState, { recursive: true });
    writeFileSync(
      path.join(kernelState, "policy.json"),
      JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-postmortem" }]),
      "utf8",
    );
    const { deps, seen } = await depsFor(failingProvider());
    const turn = await runTurn(deps);
    expect(turn.exit?.terminal).not.toBe("succeeded");

    const pmDir = postmortemsDir(workspaceStateDir(workspace));
    if (existsSync(pmDir)) {
      expect(readdirSync(pmDir).filter((n) => n.endsWith(".json"))).toEqual([]);
    }
    const notices = seen
      .filter((ev): ev is Extract<RuntimeEvent, { type: "notice" }> => ev.type === "notice")
      .map((ev) => ev.message)
      .join("\n");
    expect(notices).toMatch(/could not record a post-mortem/i);
    expect(notices).toMatch(/denied|test-deny-postmortem/i);
  });
});
