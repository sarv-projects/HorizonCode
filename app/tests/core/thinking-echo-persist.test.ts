/**
 * thinking-echo-persist.test.ts — capture -> persist -> replay of signed thinking.
 * A `done.thinking` echo from a provider is threaded into the assistant ChatMsg
 * by the loop, survives the SQLite transcript, and replays as signed blocks on
 * the next turn via toAnthropicMessages. With no echo, history is unchanged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ChatMsg, Provider, ProviderEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { toAnthropicMessages } from "../../src/core/providers/anthropic";
import { SessionStore } from "../../src/core/session";

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-think-echo-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function scripted(events: ProviderEvent[]): Provider {
  return {
    name: "scripted",
    async *stream() {
      for (const event of events) yield event;
    },
  };
}

function depsFor(provider: Provider): { deps: LoopDeps; kernel: KernelClient; store: SessionStore } {
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
  const store = new SessionStore(workspace);
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("thinking echo").id,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: () => undefined },
    sessionLeases: [],
    approve: async () => true,
  };
  return { deps, kernel, store };
}

function assistant(history: ChatMsg[]): ChatMsg {
  const found = history.find((m) => m.role === "assistant");
  if (!found) throw new Error("no assistant message in history");
  return found;
}

describe("thinking echo capture -> persist -> replay", () => {
  test("a done.thinking echo is stored on the assistant ChatMsg and replayed", async () => {
    const provider = scripted([
      { type: "text", text: "answer" },
      {
        type: "done",
        stopReason: "end",
        usage: { inputTokens: 5, outputTokens: 3 },
        thinking: { text: "Let me reason.", signature: "sig-part", redacted: "opaque" },
      },
    ]);
    const { deps, kernel, store } = depsFor(provider);
    try {
      await runTurn(deps, "reason about this");
      const msg = assistant(store.history(deps.sessionId));
      expect(msg.thinking).toBe("Let me reason.");
      expect(msg.thinkingSignature).toBe("sig-part");
      expect(msg.redactedThinking).toBe("opaque");

      // Next turn: the signed blocks replay verbatim.
      const wire = toAnthropicMessages(store.history(deps.sessionId));
      const assistantTurn = wire.find((m) => m.role === "assistant");
      expect(assistantTurn?.content).toEqual([
        { type: "thinking", thinking: "Let me reason.", signature: "sig-part" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "answer" },
      ]);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("no echo leaves the assistant ChatMsg and replay byte-identical", async () => {
    const provider = scripted([
      { type: "thinking", text: "display-only reasoning" },
      { type: "text", text: "answer" },
      { type: "done", stopReason: "end" },
    ]);
    const { deps, kernel, store } = depsFor(provider);
    try {
      await runTurn(deps, "plain turn");
      const msg = assistant(store.history(deps.sessionId));
      expect(msg.thinking).toBeUndefined();
      expect(msg.thinkingSignature).toBeUndefined();
      expect(msg.redactedThinking).toBeUndefined();
      const wire = toAnthropicMessages(store.history(deps.sessionId));
      const assistantTurn = wire.find((m) => m.role === "assistant");
      expect(assistantTurn?.content).toEqual([{ type: "text", text: "answer" }]);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("an unsigned echo text is not replayed (no valid signature)", async () => {
    const provider = scripted([
      { type: "text", text: "answer" },
      { type: "done", stopReason: "end", thinking: { text: "unsigned reasoning" } },
    ]);
    const { deps, kernel, store } = depsFor(provider);
    try {
      await runTurn(deps, "unsigned");
      const wire = toAnthropicMessages(store.history(deps.sessionId));
      const assistantTurn = wire.find((m) => m.role === "assistant");
      expect(assistantTurn?.content).toEqual([{ type: "text", text: "answer" }]);
    } finally {
      await kernel.close();
      store.close();
    }
  });
});
