/**
 * Multimodal product path — prompts and tool results on OpenAI/Anthropic wire (ruling **731**).
 */

import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import { stripImagesFromHistory } from "../../src/core/chat-content";
import { toAnthropicMessages } from "../../src/core/providers/anthropic";
import { toOpenAiMessages } from "../../src/core/providers/openai";
import { assessVisionPosture } from "../../src/core/vision-posture";
import { checkProviderVision } from "../../src/core/doctor";
import { loadConfig } from "../../src/core/config";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const TOOL_PARTS = [
  { type: "text" as const, text: "screenshot attached" },
  { type: "image_url" as const, image_url: { url: `data:image/png;base64,${PNG_1X1}` } },
];

describe("tool result multimodal wire", () => {
  test("OpenAI tool message carries multipart content when tool result has images", () => {
    const messages: ChatMsg[] = [
      {
        role: "tool",
        toolCallId: "c1",
        content: TOOL_PARTS,
      },
    ];
    const wire = toOpenAiMessages(messages);
    expect(wire).toHaveLength(1);
    expect(wire[0]!.role).toBe("tool");
    const content = wire[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    expect((content as unknown[]).some((p) => (p as { type?: string }).type === "image_url")).toBe(true);
  });

  test("Anthropic tool_result carries image block alongside text", () => {
    const messages: ChatMsg[] = [
      {
        role: "tool",
        toolCallId: "c1",
        content: TOOL_PARTS,
      },
    ];
    const wire = toAnthropicMessages(messages);
    const block = wire[0]!.content.find((b) => b.type === "tool_result");
    expect(block).toBeDefined();
    const body = (block as { content: unknown }).content;
    expect(Array.isArray(body)).toBe(true);
    expect((body as { type: string }[]).some((b) => b.type === "image")).toBe(true);
  });
});

describe("vision honesty", () => {
  test("text-only models strip images from provider view", () => {
    const history: ChatMsg[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "https://example.com/x.png" } },
        ],
      },
    ];
    const stripped = stripImagesFromHistory(history);
    expect(stripped[0]!.content).toBe("look");
  });

  test("doctor warns when model is treated as text-only", () => {
    const config = loadConfig({ ...process.env, HZ_MODEL: "gpt-3.5-turbo" }, "/dev/null");
    const line = checkProviderVision(
      { env: process.env, home: "/tmp", workspace: "/tmp", stdinIsTTY: false, stdoutIsTTY: false },
      { ...config, provider: "openai", model: "gpt-3.5-turbo" },
    );
    expect(line.id).toBe("provider.vision");
    expect(line.status).toBe("warn");
  });

  test("gpt-4o posture is vision-capable", () => {
    const p = assessVisionPosture("openai", "gpt-4o", {});
    expect(p.support).toBe(true);
  });
});