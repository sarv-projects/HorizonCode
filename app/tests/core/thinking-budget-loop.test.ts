/**
 * thinking-budget-loop.test.ts — bounded thinking-token cap wired into loop.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { workspaceStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";
import { createThinkingBudget } from "../../src/core/thinking-budget";

let workspace: string;
let store: SessionStore | undefined;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-thinking-budget-loop-"));
});

afterEach(() => {
  if (store) {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    store = undefined;
  }
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore on Windows */
  }
});

function scriptedProvider(events: ProviderEvent[]): Provider {
  return {
    name: "scripted",
    async *stream() {
      for (const e of events) yield e;
    },
  };
}

describe("thinking-budget loop wiring", () => {
  test("thinkingBudget in LoopDeps bounds thinking events and clamps accumulation", async () => {
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspaceStateDir(workspace), "kernel") });
    store = new SessionStore(workspace);
    const session = store.createSession();

    // 10 tokens cap = 40 bytes.
    const budget = createThinkingBudget({ capTokens: 10 });
    const events: ProviderEvent[] = [
      { type: "thinking", text: "12345678901234567890" }, // 20 bytes -> 5 tokens (admitted)
      { type: "thinking", text: "12345678901234567890" }, // 20 bytes -> 5 tokens (10 total == cap)
      { type: "thinking", text: "overflow extra thinking" }, // beyond cap -> refused
      { type: "text", text: "final answer" },
      { type: "done", stopReason: "end" },
    ];

    const emittedThinking: string[] = [];
    const emittedNotices: string[] = [];
    const deps: LoopDeps = {
      sessionId: session.id,
      store,
      kernel,
      provider: scriptedProvider(events),
      model: "mock-model",
      workspace,
      signal: new AbortController().signal,
      thinkingBudget: budget,
      callbacks: {
        onEvent(ev: RuntimeEvent) {
          if (ev.type === "assistant.thinking") {
            emittedThinking.push(ev.text);
          } else if (ev.type === "notice") {
            emittedNotices.push(ev.message);
          }
        },
      },
    };

    const res = await runTurn(deps, "hello");
    expect(res.exit.terminal).toBe("succeeded");
    expect(budget.usedTokens()).toBe(10);
    expect(budget.remainingTokens()).toBe(0);

    // Only the admitted 40 bytes were accumulated; overflow was discarded
    const totalThinking = emittedThinking.join("");
    expect(totalThinking).toBe("1234567890123456789012345678901234567890");
    expect(totalThinking.includes("overflow")).toBe(false);
    expect(emittedNotices.some((n) => n.includes("thinking token budget exhausted"))).toBe(true);
  });
});
