/**
 * speculation-unwired.test.ts: pins the FEAT-004 decision (docs/28 ruling 65).
 * `LoopDeps.speculativeExecution` stays an inert seam: a kept speculative result
 * cannot soundly REPLACE the real call today, so turning the flag on must change
 * nothing observable. If someone wires it naively, the read runs twice and these
 * counts diverge (guard checks, tool.card).
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

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-specoff-"));
  writeFileSync(path.join(workspace, "a.txt"), "alpha\n");
  writeFileSync(path.join(workspace, "b.txt"), "beta\n");
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

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

async function run(flag: boolean | undefined) {
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
    ...(flag === undefined ? {} : { speculativeExecution: flag }),
  };
  try {
    await runTurn(deps, "read both");
    return { checks, seen };
  } finally {
    await kernel.close();
    store.close();
  }
}

describe("speculativeExecution flag is inert (ruling 65)", () => {
  test("flag on: each read is guarded and run exactly once, same as flag off", async () => {
    const off = await run(undefined);
    const on = await run(true);
    const reads = (r: typeof off) => r.checks.filter((c) => c.startsWith("fs.read:") && /^(fs\.read:)(a|b)\.txt$/.test(c));
    expect(reads(off).sort()).toEqual(["fs.read:a.txt", "fs.read:b.txt"]);
    expect(reads(on).sort()).toEqual(reads(off).sort());
    expect(on.checks.length).toBe(off.checks.length);
    const cards = (r: typeof off) => r.seen.filter((e) => e.type === "tool.card" && (e as { status?: string }).status === "running").length;
    expect(cards(off)).toBe(2);
    expect(cards(on)).toBe(2);
  });
});
