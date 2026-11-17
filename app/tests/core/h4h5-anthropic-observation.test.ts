/**
 * H-4 / H-5 residuals (rulings 494/495/517): Anthropic consumes the configured
 * formatter + the observation hook, and FINAL assembled tool argument JSON is
 * validated in pure utils (never silently fed downstream). No loop branching.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMsg, ProviderEvent, ProviderFailureCode } from "../../src/contracts";
import type { HzConfig } from "../../src/core/config";
import { resolveConfigClassKey } from "../../src/core/config-class-keys";
import { createAnthropicProvider, toAnthropicMessages } from "../../src/core/providers/anthropic";
import { toGoogleContents } from "../../src/core/providers/google";
import { GOOGLE_FORMATTER, type MessageFormatter } from "../../src/core/providers/message-formatter";
import { makeProvider } from "../../src/core/providers";
import { createOpenAiProvider } from "../../src/core/providers/openai";
import {
  toolInputErrorEvent,
  validateFinalToolArguments,
} from "../../src/core/providers/tool-call-assembly";
import { formatObservationMessages, toolResultContent } from "../../src/core/providers/tool-result-content";
import {
  lastDone,
  makeRequest,
  run,
  sseFrame,
  sseResponse,
  toolCallsOf,
  withServer,
} from "../providers/helpers";

const MESSAGES: ChatMsg[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "hello" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "glob", arguments: '{"pattern":"*"}' }] },
  { role: "tool", content: "out", toolCallId: "c1", toolName: "glob" },
];

/** The historic native Anthropic rendering of MESSAGES (system is top-level, skipped here). */
const NATIVE_MESSAGES = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "c1", name: "glob", input: { pattern: "*" } }],
  },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "out" }] },
];

function dialect(name: string): HzConfig["formatMessageClass"] {
  return resolveConfigClassKey("formatMessageClass", name);
}

function baseConfig(overrides: Partial<HzConfig> = {}): HzConfig {
  return {
    provider: "mock",
    model: "m",
    sources: { provider: "default", model: "default", baseUrl: "default", apiKey: "none" },
    ...overrides,
  };
}

/** Run one Anthropic turn against a canned server and return the posted body. */
async function anthropicPostedBody(
  cfg: HzConfig,
  reply: () => Response = () => sseResponse("data: [DONE]\n\n"),
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  await withServer(
    () => reply(),
    async (server) => {
      const config: HzConfig = { ...cfg, apiKey: "test-key", baseUrl: server.baseUrl };
      const result = run(makeProvider(config), makeRequest({ messages: [...MESSAGES] }));
      await result.done;
      expect(result.thrown).toBeNull();
      expect(server.requests).toHaveLength(1);
      body = server.requests[0]!.body as Record<string, unknown>;
    },
  );
  return body!;
}

/** One Anthropic tool_use turn with the given streamed JSON fragments. */
function anthropicToolStream(id: string, name: string, partials: string[]): string {
  return (
    sseFrame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }, "content_block_start") +
    partials
      .map((partial_json) =>
        sseFrame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } }, "content_block_delta"),
      )
      .join("") +
    sseFrame({ type: "content_block_stop", index: 0 }, "content_block_stop") +
    sseFrame({ type: "message_delta", delta: { stop_reason: "tool_use" } }, "message_delta") +
    sseFrame({ type: "message_stop" }, "message_stop")
  );
}

/** A formatter that records its observation-hook calls with a distinct wire marker. */
function recordingFormatter(): {
  formatter: MessageFormatter;
  observed: ChatMsg[][];
} {
  const observed: ChatMsg[][] = [];
  const formatter: MessageFormatter = {
    dialect: "anthropic",
    formatMessages: (msgs) =>
      msgs.map((m) => ({ role: "user", content: [{ type: "text", text: `FMT:${m.content}` }] })),
    formatObservationMessages: (msgs) => {
      observed.push([...msgs]);
      return msgs.map((m) => ({
        role: "user",
        content: [{ type: "text", text: `OBS:${toolResultContent(m.content)}` }],
      }));
    },
  };
  return { formatter, observed };
}

/* ============================ H-4: Anthropic formatter ============================ */

describe("H-4 Anthropic consumes the configured formatter", () => {
  test("default (no formatter) is byte-identical to the native converter", async () => {
    // Direct converter: no second argument keeps the historic output exactly.
    expect(toAnthropicMessages([...MESSAGES])).toEqual(NATIVE_MESSAGES);
    // Provider with no configured formatter posts the same native messages.
    const body = await anthropicPostedBody(baseConfig({ provider: "anthropic" }));
    expect(body.messages).toEqual(NATIVE_MESSAGES);
  });

  test("a non-default dialect selected from config changes Anthropic rendering", async () => {
    const body = await anthropicPostedBody(
      baseConfig({ provider: "anthropic", formatMessageClass: dialect("google") }),
    );
    // The Google dialect renders contents/parts, not Anthropic blocks.
    expect(body.messages).not.toEqual(NATIVE_MESSAGES);
    const parts = (body.messages as Array<{ parts?: unknown[] }>).flatMap((m) => m.parts ?? []);
    expect(parts.length).toBeGreaterThan(0);
    // The assistant tool call is rendered as a Google functionCall part.
    expect(JSON.stringify(parts)).toContain("functionCall");
  });

  test("createAnthropicProvider consumes an explicitly supplied formatter", async () => {
    let body: Record<string, unknown> | undefined;
    await withServer(
      () => sseResponse("data: [DONE]\n\n"),
      async (server) => {
        const provider = createAnthropicProvider({
          apiKey: "k",
          baseUrl: server.baseUrl,
          messageFormatter: GOOGLE_FORMATTER,
        });
        const result = run(provider, makeRequest({ messages: [...MESSAGES] }));
        await result.done;
        expect(result.thrown).toBeNull();
        body = server.requests[0]!.body as Record<string, unknown>;
      },
    );
    // Google formatter output is not the native Anthropic shape.
    expect(body!.messages).not.toEqual(NATIVE_MESSAGES);
    // For the user message, Google's whole-conversation converter agrees with
    // the per-message rendering (no cross-message context needed there).
    expect(toGoogleContents([MESSAGES[1]!])).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
  });
});

/* ========================= H-4: observation hook applied ========================= */

describe("H-4 formatObservationMessages hook is applied when non-default", () => {
  test("the helper is undefined with no formatter and delegates when set", () => {
    const toolMsgs = MESSAGES.filter((m) => m.role === "tool");
    expect(formatObservationMessages(undefined, toolMsgs)).toBeUndefined();
    const { formatter } = recordingFormatter();
    expect(formatObservationMessages(formatter, toolMsgs)).toEqual([
      { role: "user", content: [{ type: "text", text: "OBS:out" }] },
    ]);
  });

  test("a non-default formatter's observation hook is invoked and its output used", () => {
    const { formatter, observed } = recordingFormatter();
    const wire = toAnthropicMessages([...MESSAGES], formatter) as unknown as Array<{
      content: Array<{ text: string }>;
    }>;
    // Exactly one tool-result message was routed through format_observation_messages.
    expect(observed).toHaveLength(1);
    expect(observed[0]![0]!.role).toBe("tool");
    expect(observed[0]![0]!.content).toBe("out");
    // The observation hook's distinct marker is present in the rendered wire.
    expect(JSON.stringify(wire)).toContain("OBS:out");
  });

  test("the default path never invokes an observation hook (byte-identical)", () => {
    expect(toAnthropicMessages([...MESSAGES])).toEqual(NATIVE_MESSAGES);
  });
});

/* ==================== H-5: final tool-arg validation (pure) ==================== */

describe("H-5 validateFinalToolArguments (pure util, no loop)", () => {
  test("a complete JSON object passes through byte-identically", () => {
    const call = { id: "c1", name: "read", arguments: '{"path": "a.ts", "n": 1}' };
    expect(validateFinalToolArguments(call)).toEqual({ ok: true, arguments: call.arguments });
  });

  test("syntax-only defects are repaired to valid JSON", () => {
    const call = { id: "c2", name: "read", arguments: "{'path': 'a.ts',}" };
    const result = validateFinalToolArguments(call);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.arguments)).toEqual({ path: "a.ts" });
  });

  test("a truncated side-effecting blob is refused with a readable reason", () => {
    const call = { id: "c3", name: "shell", arguments: '{"command":"rm -' };
    const result = validateFinalToolArguments(call);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.refusal.name).toBe("shell");
      expect(result.refusal.reason).toContain("cut off");
    }
  });

  test("toolInputErrorEvent is a typed error event with a structured message", () => {
    const event = toolInputErrorEvent({ id: "c3", name: "shell", reason: "cut off" });
    expect(event.type).toBe("error");
    expect(event.code).toBe("UNKNOWN" as ProviderFailureCode);
    expect(event.message).toContain("tool_input_error");
    expect(event.message).toContain("shell");
    expect(event.message).toContain("cut off");
  });
});

/* ============== H-5: Anthropic provider final tool args validated ============== */

describe("H-5 Anthropic final tool-call arguments", () => {
  test("valid args are emitted byte-identically", async () => {
    let events: ProviderEvent[] = [];
    await withServer(
      () => sseResponse(anthropicToolStream("toolu_ok", "read", ['{"path":"a.ts"}'])),
      async (server) => {
        const result = run(createAnthropicProvider({ apiKey: "k", baseUrl: server.baseUrl }), makeRequest());
        await result.done;
        expect(result.thrown).toBeNull();
        events = result.events;
      },
    );
    expect(toolCallsOf(events)).toEqual([{ type: "tool_call", id: "toolu_ok", name: "read", arguments: '{"path":"a.ts"}' }]);
    expect(lastDone(events).stopReason).toBe("tool_use");
  });

  test("malformed-but-repairable args are repaired and emitted", async () => {
    let events: ProviderEvent[] = [];
    await withServer(
      () => sseResponse(anthropicToolStream("toolu_fix", "read", ["{'path': 'a.ts',}"])),
      async (server) => {
        const result = run(createAnthropicProvider({ apiKey: "k", baseUrl: server.baseUrl }), makeRequest());
        await result.done;
        events = result.events;
      },
    );
    const calls = toolCallsOf(events);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ path: "a.ts" });
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });

  test("truncated non-repairable args are refused, not emitted as a broken tool_call", async () => {
    let events: ProviderEvent[] = [];
    await withServer(
      () => sseResponse(anthropicToolStream("toolu_bad", "shell", ['{"command":"rm -'])),
      async (server) => {
        const result = run(createAnthropicProvider({ apiKey: "k", baseUrl: server.baseUrl }), makeRequest());
        await result.done;
        expect(result.thrown).toBeNull();
        events = result.events;
      },
    );
    expect(toolCallsOf(events)).toHaveLength(0);
    const errors = events.filter((e) => e.type === "error") as Array<Extract<ProviderEvent, { type: "error" }>>;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("tool_input_error");
    expect(errors[0]!.message).toContain("cut off");
  });
});

/* ================ H-5: OpenAI assembler final args validated ================ */

describe("H-5 OpenAI final tool-call arguments (assembler)", () => {
  function chunk(choice: Record<string, unknown>): string {
    return sseFrame({ id: "chatcmpl-1", choices: [choice] });
  }

  test("a truncated side-effecting final blob is refused with a structured error", async () => {
    const body =
      chunk({
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call_bad", function: { name: "shell", arguments: '{"command":"rm -' } }] },
        finish_reason: null,
      }) +
      chunk({ index: 0, delta: {}, finish_reason: "tool_calls" }) +
      sseFrame("[DONE]");
    let events: ProviderEvent[] = [];
    await withServer(
      () => sseResponse(body),
      async (server) => {
        const result = run(createOpenAiProvider({ apiKey: "k", baseUrl: server.baseUrl }), makeRequest());
        await result.done;
        expect(result.thrown).toBeNull();
        events = result.events;
      },
    );
    expect(toolCallsOf(events)).toHaveLength(0);
    const errors = events.filter((e) => e.type === "error") as Array<Extract<ProviderEvent, { type: "error" }>>;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("tool_input_error");
    expect(errors[0]!.message).toContain("cut off");
  });

  test("valid assembled args still emit a tool_call and tool_use done", async () => {
    const body =
      chunk({
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call_ok", function: { name: "read", arguments: '{"path":"a.ts"}' } }] },
        finish_reason: null,
      }) +
      chunk({ index: 0, delta: {}, finish_reason: "tool_calls" }) +
      sseFrame("[DONE]");
    let events: ProviderEvent[] = [];
    await withServer(
      () => sseResponse(body),
      async (server) => {
        const result = run(createOpenAiProvider({ apiKey: "k", baseUrl: server.baseUrl }), makeRequest());
        await result.done;
        events = result.events;
      },
    );
    expect(toolCallsOf(events)).toEqual([
      { type: "tool_call", id: "call_ok", name: "read", arguments: '{"path":"a.ts"}' },
    ]);
    expect(lastDone(events).stopReason).toBe("tool_use");
  });
});
