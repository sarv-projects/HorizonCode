import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";
import { SpendLedger } from "../../src/core/spend-ledger";

const roots: string[] = [];
const oldLimit = process.env.HZ_SPEND_LIMIT_USD;
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  if (oldLimit === undefined) delete process.env.HZ_SPEND_LIMIT_USD;
  else process.env.HZ_SPEND_LIMIT_USD = oldLimit;
});

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-spend-loop-"));
  roots.push(dir);
  return dir;
}

describe("runTurn spend ceiling", () => {
  test("refuses before the provider call when the workspace ceiling is full", async () => {
    const workspace = scratch();
    // Exhaust the workspace ledger at a one-micro-USD ceiling.
    const ledger = new SpendLedger(workspace, { limitMicroUsd: 1 });
    ledger.reserve(0.000001);
    process.env.HZ_SPEND_LIMIT_USD = "0.000001";

    let called = 0;
    const provider: Provider = {
      name: "scripted",
      async *stream(): AsyncIterable<ProviderEvent> {
        called += 1;
        yield { type: "text", text: "should not run" };
        yield { type: "done", stopReason: "end" };
      },
    };
    const kernel = new KernelClient({ workspace });
    const store = new SessionStore(workspace);
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("spend").id,
      model: "scripted-1",
      provider,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => {} },
      sessionLeases: [],
      approve: async () => false,
      budget: { maxSteps: 1 },
    };
    const result = await runTurn(deps, "hello");
    expect(called).toBe(0);
    expect(result.exit.terminal).toBe("budget_exhausted");
    expect(result.exit.detail).toBe("spend");
    await kernel.close();
    store.close();
  });
});
