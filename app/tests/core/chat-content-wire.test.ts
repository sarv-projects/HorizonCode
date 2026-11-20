/**
 * Multimodal ChatMsg — provider wire shapes stay compatible with string-only history.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import { toAnthropicMessages } from "../../src/core/providers/anthropic";
import { toOpenAiMessages } from "../../src/core/providers/openai";
import { rowToChatMsg } from "../../src/core/session";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("multimodal ChatMsg wire", () => {
  test("string-only messages are unchanged on OpenAI and Anthropic converters", () => {
    const messages: ChatMsg[] = [{ role: "user", content: "hello" }];
    expect(toOpenAiMessages(messages)).toEqual([{ role: "user", content: "hello" }]);
    expect(toAnthropicMessages(messages)).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });

  test("user message with image_url serializes into OpenAI multimodal content", () => {
    const url = "https://example.com/cat.png";
    const messages: ChatMsg[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url } },
        ],
      },
    ];
    const openAi = toOpenAiMessages(messages);
    expect(openAi).toHaveLength(1);
    expect(openAi[0]!.role).toBe("user");
    expect(openAi[0]!.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url } },
    ]);
  });

  test("user message with image_url becomes Anthropic image block", () => {
    const messages: ChatMsg[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1X1}` } },
        ],
      },
    ];
    const anthropic = toAnthropicMessages(messages);
    expect(anthropic).toHaveLength(1);
    const blocks = anthropic[0]!.content;
    expect(blocks.some((b) => b.type === "text" && b.text === "describe")).toBe(true);
    const image = blocks.find((b) => b.type === "image");
    expect(image).toBeDefined();
    expect((image as { source: { type: string; media_type: string } }).source.type).toBe("base64");
    expect((image as { source: { media_type: string } }).source.media_type).toBe("image/png");
  });

  test("tool result with image_url on OpenAI wire", () => {
    const url = `data:image/png;base64,${PNG_1X1}`;
    const messages: ChatMsg[] = [
      {
        role: "tool",
        toolCallId: "t1",
        content: [
          { type: "text", text: "frame" },
          { type: "image_url", image_url: { url } },
        ],
      },
    ];
    const openAi = toOpenAiMessages(messages);
    expect(Array.isArray(openAi[0]!.content)).toBe(true);
  });

  test("session row round-trips multipart content via meta.contentParts", () => {
    const parts = [
      { type: "text" as const, text: "see image" },
      { type: "image_url" as const, image_url: { url: "https://example.com/x.png" } },
    ];
    const restored = rowToChatMsg({
      role: "user",
      content: "see image",
      meta: JSON.stringify({ contentParts: parts }),
    });
    expect(restored.content).toEqual(parts);
  });
});