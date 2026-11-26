/**
 * anthropic-truncated-tool.test.ts — D-7: a truncated tool block is refused.
 *
 * When the SSE stream ends while a tool_use block is still receiving
 * input_json_delta, the provider's end-of-stream flush used to emit the partial
 * JSON as a tool_call. That is the exact case H-5 exists for: final assembled
 * arguments must be validated, and a cut-off blob must become a structured
 * tool_input_error instead of a call with malformed arguments.
 */

import { describe, expect, test } from "bun:test";
import { createAnthropicProvider } from "../../src/core/providers/anthropic";
import type { ProviderEvent } from "../../src/contracts";
import { makeRequest, run, sseFrame, sseResponse, toolCallsOf, withServer } from "./helpers";

describe("anthropic truncated tool stream", () => {
  test("emits no tool_call and a tool_input_error when the stream cuts off", async () => {
    const body =
      sseFrame({ type: "message_start", message: { id: "m1", usage: { input_tokens: 3 } } }, "message_start") +
      sseFrame(
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "shell", input: {} } },
        "content_block_start",
      ) +
      sseFrame(
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls -la' } },
        "content_block_delta",
      );

    await withServer(
      () => sseResponse(body),
      async (server) => {
        const provider = createAnthropicProvider({ apiKey: "sk-ant-test", baseUrl: server.baseUrl });
        const result = run(provider, makeRequest());
        await result.done;
        const events: ProviderEvent[] = result.events;
        expect(toolCallsOf(events)).toHaveLength(0);
        const refused = events.filter(
          (e): e is Extract<ProviderEvent, { type: "error" }> => e.type === "error" && /tool_input_error/.test(e.message),
        );
        expect(refused.length).toBe(1);
      },
    );
  });
});
