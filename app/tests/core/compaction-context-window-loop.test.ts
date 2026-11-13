/**
 * One emergency compaction pass on CONTEXT_WINDOW_EXCEEDED before turn fail (ruling 233).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { CONTEXT_WINDOW_COMPACTION_NOTICE } from "../../src/core/compaction-context-window";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-ctx-win-loop-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function ctxThenOkProvider(): Provider {
  let n = 0;
  return {
    name: "scripted",
    async *stream() {
      n += 1;
      if (n === 1) {
        yield {
          type: "error",
          message: "maximum context length exceeded",
          code: "CONTEXT_WINDOW_EXCEEDED",
        } satisfies ProviderEvent;
        return;
      }
      yield { type: "text", text: "recovered" } satisfies ProviderEvent;
      yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
    },
  };
}

function alwaysCtxProvider(): Provider {
  return {
    name: "scripted",
    async *stream() {
      yield {
        type: "error",
        message: "prompt too long",
        code: "CONTEXT_WINDOW_EXCEEDED",
      } satisfies ProviderEvent;
    },
  };
}

function seedHistory(store: SessionStore, sessionId: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    store.appendMessage(sessionId, { role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` });
  }
}

describe("CONTEXT_WINDOW_EXCEEDED compaction recovery", () => {
  test("retries once after emergency shrink then completes", async () => {
    const store = new SessionStore(workspace);
    const sessionId = store.createSession("ctx-recover").id;
    seedHistory(store, sessionId, 12);
    const seen: RuntimeEvent[] = [];
    const deps: LoopDeps = {
      workspace,
      sessionId,
      model: "scripted-1",
      provider: ctxThenOkProvider(),
      kernel: new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") }),
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: (ev) => seen.push(ev) },
      sessionLeases: [],
      approve: async () => true,
    };
    const { exit } = await runTurn(deps, "go");
    expect(exit.terminal).toBe("succeeded");
    expect(seen.some((e) => e.type === "notice" && e.message === CONTEXT_WINDOW_COMPACTION_NOTICE)).toBe(true);
    expect(seen.some((e) => e.type === "assistant.done" && e.text.includes("recovered"))).toBe(true);
    expect(seen.filter((e) => e.type === "error")).toHaveLength(0);
  });

  test("fails after one recovery when context window still exceeded", async () => {
    const store = new SessionStore(workspace);
    const sessionId = store.createSession("ctx-fail").id;
    seedHistory(store, sessionId, 8);
    const seen: RuntimeEvent[] = [];
    const deps: LoopDeps = {
      workspace,
      sessionId,
      model: "scripted-1",
      provider: alwaysCtxProvider(),
      kernel: new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") }),
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: (ev) => seen.push(ev) },
      sessionLeases: [],
      approve: async () => true,
    };
    const { exit } = await runTurn(deps, "go");
    expect(exit.terminal).toBe("failed");
    expect(seen.filter((e) => e.type === "notice" && e.message === CONTEXT_WINDOW_COMPACTION_NOTICE)).toHaveLength(1);
    expect(seen.filter((e) => e.type === "error").length).toBeGreaterThanOrEqual(1);
  });
});
