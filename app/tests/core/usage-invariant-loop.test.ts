/**
 * usage-invariant-loop.test.ts — V-14: a provider's impossible usage is reported.
 *
 * The pure validator existed with no product caller. The loop now checks every
 * reported Usage and emits one notice naming the suspicious fields; values are
 * reported as-is, never rewritten or guessed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-usage-inv-"));
});
afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* windows handles */
  }
});

async function runWithUsage(usage: ProviderEvent extends never ? never : Record<string, number>): Promise<RuntimeEvent[]> {
  const provider: Provider = {
    name: "scripted",
    async *stream() {
      yield { type: "text", text: "ok" };
      yield { type: "done", stopReason: "end", usage: usage as never };
    },
  };
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
  const store = new SessionStore(workspace);
  const sessionId = store.createSession("usage").id;
  const events: RuntimeEvent[] = [];
  const deps: LoopDeps = {
    workspace,
    sessionId,
    model: "m",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: (ev) => events.push(ev) },
    sessionLeases: [],
    approve: async () => true,
    budget: { maxSteps: 4 },
  };
  try {
    await runTurn(deps, "go");
  } finally {
    await kernel.close();
    store.close();
  }
  return events;
}

describe("usage invariant in the loop", () => {
  test("an impossible total is reported as a notice", async () => {
    const events = await runWithUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 99 });
    const notices = events.filter((e) => e.type === "notice").map((e) => (e as { message: string }).message);
    expect(notices.some((m) => m.includes("usage invariant"))).toBe(true);
  });

  test("a consistent usage produces no invariant notice", async () => {
    const events = await runWithUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    const notices = events.filter((e) => e.type === "notice").map((e) => (e as { message: string }).message);
    expect(notices.some((m) => m.includes("usage invariant"))).toBe(false);
  });
});
