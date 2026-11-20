/**
 * Speculative execution wired into the live turn path (docs/28 ruling 668).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { GuardAction, GuardDecision, Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import {
  GuardGate,
  runTurn,
  RunFaults,
  speculativeExecutionEnabled,
  TurnSpeculationLane,
  type LoopDeps,
} from "../../src/core/loop";
import { workspaceStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";
import { restoreEnv, setEnv, snapshotEnv, type EnvSnapshot } from "./helpers";

let workspace: string;
let envSnap: EnvSnapshot;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-specwire-"));
  writeFileSync(path.join(workspace, "a.txt"), "alpha\n");
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

async function runReads(envOn: boolean, flag?: boolean) {
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
    [call("read", { path: "a.txt" }, "c1"), { type: "done", stopReason: "tool_use" }],
    [{ type: "text", text: "done" }, { type: "done", stopReason: "end" }],
  ]);
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("spec-on").id,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: (ev) => seen.push(ev) },
    sessionLeases: [],
    approve: async () => true,
    ...(flag === undefined ? {} : { speculativeExecution: flag }),
  };
  if (envOn) setEnv({ HZ_SPECULATIVE_EXECUTION: "1" });
  try {
    expect(speculativeExecutionEnabled(deps)).toBe(envOn || flag === true);
    await runTurn(deps, "read one");
    return { checks, seen };
  } finally {
    await kernel.close();
    store.close();
  }
}

describe("speculativeExecution wired (HZ_SPECULATIVE_EXECUTION=1)", () => {
  test("opt-in: one guarded fs.read and one running tool card", async () => {
    const on = await runReads(true);
    const reads = on.checks.filter((c) => c === "fs.read:a.txt");
    expect(reads).toHaveLength(1);
    const cards = on.seen.filter((e) => e.type === "tool.card" && (e as { status?: string }).status === "running");
    expect(cards).toHaveLength(1);
  });

  test("LoopDeps.speculativeExecution alone enables the lane", async () => {
    const on = await runReads(false, true);
    const reads = on.checks.filter((c) => c === "fs.read:a.txt");
    expect(reads).toHaveLength(1);
  });

  test("mid-stream prep discarded when committed args diverge (wrong branch)", async () => {
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspaceStateDir(workspace), "kernel") });
    const store = new SessionStore(workspace);
    const sessionId = store.createSession("spec-mismatch").id;
    const gate = new GuardGate(workspace, kernel, [], () => async () => true, sessionId);
    const faults = new RunFaults();
    const deps: LoopDeps = {
      workspace,
      sessionId,
      model: "scripted-1",
      provider: { name: "scripted", async *stream() {} },
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => {} },
      sessionLeases: [],
      approve: async () => true,
      speculativeExecution: true,
    };
    const lane = TurnSpeculationLane.create(deps, gate, faults)!;
    lane.noteToolCall({ id: "c1", name: "read", arguments: JSON.stringify({ path: "a.txt" }) }, workspace);
    await new Promise((r) => setTimeout(r, 50));
    await lane.finalize([{ id: "c1", name: "read", arguments: JSON.stringify({ path: "b.txt" }) }], workspace);
    expect(lane.hasKept("c1")).toBe(false);
    const out = lane.consume({ id: "c1", name: "read", arguments: JSON.stringify({ path: "b.txt" }) }, workspace);
    expect(out).toBeUndefined();
    await kernel.close();
    store.close();
  });

  test("revised wire args on same call id re-guard at batch (prep not consumed)", async () => {
    writeFileSync(path.join(workspace, "b.txt"), "beta-branch\n");
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspaceStateDir(workspace), "kernel") });
    const store = new SessionStore(workspace);
    const checks: string[] = [];
    const original = kernel.checkGuard.bind(kernel);
    kernel.checkGuard = (async (action, ...rest) => {
      checks.push(`${action.kind}:${path.basename(action.target)}`);
      return (original as (...a: unknown[]) => Promise<unknown>)(action, ...rest);
    }) as typeof kernel.checkGuard;
    const provider = script([
      [
        call("read", { path: "a.txt" }, "c1"),
        call("read", { path: "b.txt" }, "c1"),
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "text", text: "done" }, { type: "done", stopReason: "end" }],
    ]);
    setEnv({ HZ_SPECULATIVE_EXECUTION: "1" });
    try {
      await runTurn(
        {
          workspace,
          sessionId: store.createSession("spec-revise").id,
          model: "scripted-1",
          provider,
          kernel,
          store,
          signal: new AbortController().signal,
          callbacks: { onEvent: () => {} },
          sessionLeases: [],
          approve: async () => true,
        },
        "read revised",
      );
      expect(checks.filter((c) => c === "fs.read:a.txt").length).toBeGreaterThanOrEqual(1);
      expect(checks.filter((c) => c === "fs.read:b.txt").length).toBeGreaterThanOrEqual(1);
    } finally {
      await kernel.close();
      store.close();
    }
  });
});