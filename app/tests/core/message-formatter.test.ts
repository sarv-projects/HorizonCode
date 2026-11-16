/**
 * H-4 / ruling 494: dialect switching is driven by CONFIG DATA ONLY, using the
 * closed `formatMessageClass` class-key map. No dynamic import, no new dep, and
 * the default output is byte-identical to the existing OpenAI adapter path.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import {
  DEFAULT_FORMATTER_DIALECT,
  formatterForDialect,
  selectMessageFormatter,
  selectMessageFormatterFromConfig,
} from "../../src/core/providers/message-formatter";
import { toOpenAiMessages } from "../../src/core/providers/openai";
import { toAnthropicMessages } from "../../src/core/providers/anthropic";
import { toGoogleContents } from "../../src/core/providers/google";
import { toOllamaMessages } from "../../src/core/providers/ollama";

const SAMPLE: ChatMsg[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "hello" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "c1", name: "glob", arguments: '{"pattern":"*"}' }],
  },
  { role: "tool", content: "", toolCallId: "c1", toolName: "glob" },
];

describe("H-4 swappable format_message class", () => {
  test("default (no config) is byte-identical to the current OpenAI path", () => {
    const f = selectMessageFormatterFromConfig({});
    expect(f.dialect).toBe(DEFAULT_FORMATTER_DIALECT);
    expect(f.dialect).toBe("openai");
    expect(f.formatMessages(SAMPLE)).toEqual(toOpenAiMessages(SAMPLE));
    expect(selectMessageFormatter(undefined).formatMessages(SAMPLE)).toEqual(toOpenAiMessages(SAMPLE));
  });

  test("changing provider config alone does NOT switch the formatter dialect", () => {
    expect(selectMessageFormatterFromConfig({ provider: "anthropic", model: "claude" }).dialect).toBe("openai");
  });

  test("config data switches to each built-in dialect (short name + snake_case)", () => {
    const anthropic = selectMessageFormatterFromConfig({ formatMessageClass: "anthropic" });
    expect(anthropic.dialect).toBe("anthropic");
    expect(anthropic.formatMessages(SAMPLE)).toEqual(toAnthropicMessages(SAMPLE));
    expect(anthropic.formatMessages(SAMPLE)).not.toEqual(toOpenAiMessages(SAMPLE));

    const google = selectMessageFormatterFromConfig({ format_message_class: "google" });
    expect(google.dialect).toBe("google");
    expect(google.formatMessages(SAMPLE)).toEqual(toGoogleContents(SAMPLE));

    const ollama = selectMessageFormatterFromConfig({ formatMessageClass: "ollama" });
    expect(ollama.dialect).toBe("ollama");
    expect(ollama.formatMessages(SAMPLE)).toEqual(toOllamaMessages(SAMPLE));
  });

  test("mock / openai-compatible map to the OpenAI dialect (same wire shape)", () => {
    for (const spec of ["mock", "openai-compatible"]) {
      const f = selectMessageFormatterFromConfig({ formatMessageClass: spec });
      expect(f.dialect).toBe("openai");
      expect(f.formatMessages(SAMPLE)).toEqual(toOpenAiMessages(SAMPLE));
    }
  });

  test("unknown or malformed config fails closed to the default formatter", () => {
    expect(selectMessageFormatterFromConfig({ formatMessageClass: "remote/plugin" }).dialect).toBe("openai");
    expect(formatterForDialect("nope").dialect).toBe("openai");
    expect(formatterForDialect(undefined).dialect).toBe("openai");
  });

  test("format_observation_messages formats only tool-result messages", () => {
    const openai = selectMessageFormatterFromConfig({ formatMessageClass: "openai" });
    expect(openai.formatObservationMessages(SAMPLE)).toEqual([
      { role: "tool", tool_call_id: "c1", content: "(no output)", name: "glob" },
    ]);
    const anthropic = selectMessageFormatterFromConfig({ formatMessageClass: "anthropic" });
    expect(anthropic.formatObservationMessages(SAMPLE)).toEqual([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "(no output)" }] },
    ]);
  });
});
