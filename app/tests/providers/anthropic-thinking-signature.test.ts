/**
 * anthropic-thinking-signature.test.ts — signed extended-thinking replay.
 * Streamed `signature_delta` chunks are captured and echoed on `done`; a
 * signed ChatMsg replays as thinking/redacted_thinking blocks on the next turn.
 */
import { describe, expect, test } from "bun:test";
import { createAnthropicProvider, toAnthropicMessages } from "../../src/core/providers/anthropic";
import type { ProviderEvent } from "../../src/contracts";
import { lastDone, makeRequest, run, sseFrame, sseResponse, withServer } from "./helpers";

function thinkingTurn(): string {
  return (
    sseFrame({ type: "message_start", message: { usage: { input_tokens: 5 } } }, "message_start") +
    sseFrame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, "content_block_start") +
    sseFrame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } }, "content_block_delta") +
    sseFrame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason." } }, "content_block_delta") +
    sseFrame({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }, "content_block_delta") +
    sseFrame({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "-part" } }, "content_block_delta") +
    sseFrame({ type: "content_block_stop", index: 0 }, "content_block_stop") +
    sseFrame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }, "message_delta") +
    sseFrame({ type: "message_stop" }, "message_stop")
  );
}

describe("anthropic signed thinking", () => {
  test("captures streamed thinking + signature_delta into the done echo", async () => {
    const body = thinkingTurn();
    await withServer(
      () => sseResponse(body),
      async (server) => {
        const provider = createAnthropicProvider({ apiKey: "sk-ant-test", baseUrl: server.baseUrl });
        const result = run(provider, makeRequest());
        await result.done;
        expect(result.thrown).toBeNull();
        const events: ProviderEvent[] = result.events;
        expect(events.filter((e) => e.type === "thinking")).toEqual([
          { type: "thinking", text: "Let me " },
          { type: "thinking", text: "reason." },
        ]);
        expect(lastDone(events).thinking).toEqual({ text: "Let me reason.", signature: "sig-part" });
      },
    );
  });

  test("toAnthropicMessages replays signed thinking and redacted_thinking blocks", () => {
    const messages = toAnthropicMessages([
      {
        role: "assistant",
        content: "answer",
        thinking: "Let me reason.",
        thinkingSignature: "sig-part",
        redactedThinking: "opaque-data",
      },
    ]);
    expect(messages[0]!.content).toEqual([
      { type: "thinking", thinking: "Let me reason.", signature: "sig-part" },
      { type: "redacted_thinking", data: "opaque-data" },
      { type: "text", text: "answer" },
    ]);
  });

  test("no signature preserves the original message shape (display-only thinking)", () => {
    const messages = toAnthropicMessages([
      { role: "assistant", content: "answer", thinking: "unsigned reasoning" },
    ]);
    expect(messages[0]!.content).toEqual([{ type: "text", text: "answer" }]);
  });
});
