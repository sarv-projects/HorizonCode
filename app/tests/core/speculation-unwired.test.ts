/**
 * speculation-unwired.test.ts: default-off pin for speculative execution.
 * With neither `HZ_SPECULATIVE_EXECUTION=1` nor `LoopDeps.speculativeExecution`,
 * enabling the seam must change nothing observable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { GuardAction, GuardDecision, Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { runTurn } from "../../src/core/loop";
import { workspaceStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";
import { restoreEnv, snapshotEnv, type EnvSnapshot } from "./helpers";

let workspace: string;
let envSnap: EnvSnapshot;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-specoff-"));
  writeFileSync(path.join(workspace, "a.txt"), "alpha\n");
  writeFileSync(path.join(workspace, "b.txt"), "beta\n");
  envSnap = snapshotEnv();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  restoreEnv(envSnap);
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

async function run() {
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspaceStateDir(workspace), "kernel") });
  const store = new SessionStore(workspace);
  const checks: string[] = [];
  const original = kernel.checkGuard.bind(kernel);
  kernel.checkGuard = (async (action: GuardAction, ...rest: unknown[]): Promise<GuardDecision> => {
    checks.push(`${action.kind}:${path.basename(action.target)}`);
    return (original as (...a: unknown[]) => Promise<GuardDecision>)(action, ...rest);
  }) as typeof kernel.checkGuard;
  const seen: RuntimeEvent[] = [];
  const provider = script([
    [call("read", { path: "a.txt" }, "c1"), call("read", { path: "b.txt" }, "c2"), { type: "done", stopReason: "tool_use" }],
    [{ type: "text", text: "done" }, { type: "done", stopReason: "end" }],
  ]);
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("spec-off").id,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: (ev) => seen.push(ev) },
    sessionLeases: [],
    approve: async () => true,
  };
  try {
    await runTurn(deps, "read both");
    return { checks, seen };
  } finally {
    await kernel.close();
    store.close();
  }
}

describe("speculativeExecution default off", () => {
  test("each read is guarded and run exactly once", async () => {
    const off = await run();
    const reads = (r: typeof off) => r.checks.filter((c) => c.startsWith("fs.read:") && /^(fs\.read:)(a|b)\.txt$/.test(c));
    expect(reads(off).sort()).toEqual(["fs.read:a.txt", "fs.read:b.txt"]);
    const cards = (r: typeof off) => r.seen.filter((e) => e.type === "tool.card" && (e as { status?: string }).status === "running").length;
    expect(cards(off)).toBe(2);
  });
});