import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { workspaceStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";

let workspace: string;
let store: SessionStore | undefined;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-loop-context-ladder-"));
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

function scriptedContextExceededProvider(attemptsUntilSuccess: number): Provider {
  let callCount = 0;
  return {
    name: "scripted-overflow",
    async *stream(): AsyncIterable<ProviderEvent> {
      callCount += 1;
      if (callCount < attemptsUntilSuccess) {
        yield {
          type: "error",
          message: "Context window exceeded",
          code: "CONTEXT_WINDOW_EXCEEDED",
        };
      } else {
        yield { type: "text", text: "Successfully recovered after multi-step ladder shrink!" };
        yield { type: "done" };
      }
    },
  };
}

describe("Multi-Step Emergency Context Window Shrink Ladder (Ruling 866)", () => {
  test("steps down the emergency ladder across consecutive CONTEXT_WINDOW_EXCEEDED events", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspaceStateDir(workspace), "kernel"),
    });
    store = new SessionStore(workspace);
    const session = store.createSession();

    // Populate history with 10 user messages so emergency shrink has room to step down
    for (let i = 0; i < 10; i++) {
      store.appendMessage(session.id, { role: "user", content: `Context message ${i}` });
      store.appendMessage(session.id, { role: "assistant", content: `Reply ${i}` });
    }

    const notices: string[] = [];
    const provider = scriptedContextExceededProvider(3); // Fails twice with CONTEXT_WINDOW_EXCEEDED, succeeds on 3rd

    const deps: LoopDeps = {
      workspace,
      sessionId: session.id,
      store,
      kernel,
      provider,
      model: "test-model",
      tools: [],
      callbacks: {
        onEvent(e: RuntimeEvent) {
          if (e.type === "notice") {
            notices.push(e.message);
          }
        },
      },
      signal: new AbortController().signal,
    };

    const res = await runTurn(deps, "Perform complex action");

    expect(res.aborted).toBe(false);
    expect(res.text).toContain("Successfully recovered after multi-step ladder shrink!");
    // Both attempts emitted the emergency notice
    expect(notices.filter((n) => n.includes("emergency compaction")).length).toBe(2);
  });
});
