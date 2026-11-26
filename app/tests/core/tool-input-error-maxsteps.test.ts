/**
 * tool-input-error-maxsteps.test.ts — Track A verification:
 *  1. Strict finish parse (`toolInputError`) on tool-call assembly & providers
 *     and structured self-correction tool result in `loop.ts`.
 *  2. Prompt-cache-safe `maxSteps` (`toolChoice: "none"` + intact `tools` +
 *     final-step guidance) across OpenAI, OpenAI-compatible, Anthropic, Google,
 *     and `loop.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, ProviderRequest, ToolSpec } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { MAX_STEPS_FINAL_PROMPT, runTurn, type LoopDeps } from "../../src/core/loop";
import { createAnthropicProvider } from "../../src/core/providers/anthropic";
import { createGoogleProvider } from "../../src/core/providers/google";
import { createOpenAiProvider } from "../../src/core/providers/openai";
import { createOpenAiCompatibleProvider } from "../../src/core/providers/openai-compatible";
import { strictParseToolArgsObject } from "../../src/core/providers/tool-args-object";
import { finalizeAssembledToolCall, ToolCallAssembler } from "../../src/core/providers/tool-call-assembly";
import { SessionStore } from "../../src/core/session";
import { makeRequest, run, sseFrame, sseResponse, toolCallsOf, withServer } from "../providers/helpers";

async function collect(provider: Provider, req: ProviderRequest) {
  const handle = run(provider, req);
  await handle.done;
  return handle;
}

const SAMPLE_TOOLS: ToolSpec[] = [
  {
    name: "read",
    description: "Read a file from disk",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-track-a-"));
});

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* Windows temp dir handle may linger briefly after sqlite close */
  }
});

function makeLoopDeps(
  provider: Provider,
  extra?: Partial<LoopDeps>,
): { deps: LoopDeps; kernel: KernelClient; store: SessionStore; events: Array<{ type: string; [k: string]: unknown }> } {
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
  const store = new SessionStore(workspace);
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("track-a").id,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: (ev) => events.push(ev as { type: string; [k: string]: unknown }) },
    sessionLeases: [],
    approve: async () => true,
    ...extra,
  };
  return { deps, kernel, store, events };
}

describe("Track A: Strict Finish Parse (toolInputError)", () => {
  test("valid JSON object passes cleanly with no toolInputError", () => {
    const assembler = new ToolCallAssembler();
    assembler.pushDelta({ index: 0, id: "call_ok", function: { name: "read", arguments: '{"path":' } });
    assembler.pushDelta({ index: 0, function: { arguments: '"a.txt"}' } });
    const completed = assembler.flushCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0]!.arguments).toBe('{"path":"a.txt"}');
    expect(completed[0]!.toolInputError).toBeUndefined();

    // No-arg tool call still normalizes empty args to "{}" cleanly.
    const emptyAssembler = new ToolCallAssembler();
    emptyAssembler.pushDelta({ index: 0, id: "call_empty", function: { name: "git_status", arguments: "" } });
    const emptyCompleted = emptyAssembler.flushCompleted();
    expect(emptyCompleted).toHaveLength(1);
    expect(emptyCompleted[0]!.arguments).toBe("{}");
    expect(emptyCompleted[0]!.toolInputError).toBeUndefined();
  });

  test("malformed/truncated JSON and non-object JSON attach toolInputError without silent corruption", () => {
    const cases: Array<{ label: string; raw: string; expectMsg: RegExp }> = [
      { label: "truncated object", raw: '{"path":"a.txt', expectMsg: /Invalid JSON/i },
      { label: "trailing garbage", raw: '{"path":"a.txt"} garbage', expectMsg: /Invalid JSON/i },
      { label: "array payload", raw: '["a.txt"]', expectMsg: /must be a JSON object \(got array\)/i },
      { label: "number primitive", raw: "42", expectMsg: /must be a JSON object \(got number\)/i },
      { label: "string primitive", raw: '"hello"', expectMsg: /must be a JSON object \(got string\)/i },
      { label: "null literal", raw: "null", expectMsg: /must be a JSON object \(got null\)/i },
    ];

    for (const tc of cases) {
      const assembler = new ToolCallAssembler();
      assembler.pushDelta({ index: 0, id: "call_bad", function: { name: "write", arguments: tc.raw } });
      const completed = assembler.flushCompleted();
      expect(completed).toHaveLength(1);
      const call = completed[0]!;
      expect(call.arguments).toBe(tc.raw); // never silently corrupted to "{}"
      expect(call.toolInputError).toBeDefined();
      expect(call.toolInputError!.code).toBe("tool_input_error");
      expect(call.toolInputError!.message).toMatch(tc.expectMsg);
      expect(call.toolInputError!.rawInput).toBe(tc.raw);
    }

    const direct = strictParseToolArgsObject([1, 2, 3]);
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.error.code).toBe("tool_input_error");
      expect(direct.error.message).toContain("array");
    }

    const finalized = finalizeAssembledToolCall({ id: "c1", name: "read", arguments: "{bad" });
    expect(finalized.toolInputError?.code).toBe("tool_input_error");
    expect(finalized.arguments).toBe("{bad");
  });

  test("OpenAI, Anthropic (content_block_stop), and Google emit toolInputError on malformed tool args", async () => {
    // OpenAI SSE with truncated JSON tool call
    const openAiBody =
      sseFrame({
        id: "cmpl_1",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "call_oai", type: "function", function: { name: "write", arguments: '{"path":"x.ts' } }],
            },
            finish_reason: null,
          },
        ],
      }) +
      sseFrame({ id: "cmpl_1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
      sseFrame("[DONE]");

    await withServer(() => sseResponse(openAiBody), async (server) => {
      const provider = createOpenAiProvider({ apiKey: "sk-test", baseUrl: server.baseUrl });
      const res = await collect(provider, makeRequest({ tools: SAMPLE_TOOLS }));
      const calls = toolCallsOf(res.events);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.toolInputError?.code).toBe("tool_input_error");
      expect(calls[0]!.toolInputError?.rawInput).toBe('{"path":"x.ts');
    });

    // Anthropic SSE with content_block_stop carrying malformed JSON
    const anthropicBody =
      sseFrame({ type: "message_start", message: { id: "m1", usage: { input_tokens: 5 } } }, "message_start") +
      sseFrame(
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "write", input: {} } },
        "content_block_start",
      ) +
      sseFrame(
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
        "content_block_delta",
      ) +
      sseFrame({ type: "content_block_stop", index: 0 }, "content_block_stop") +
      sseFrame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } }, "message_delta");

    await withServer(() => sseResponse(anthropicBody), async (server) => {
      const provider = createAnthropicProvider({ apiKey: "sk-ant-test", baseUrl: server.baseUrl });
      const res = await collect(provider, makeRequest({ tools: SAMPLE_TOOLS }));
      const calls = toolCallsOf(res.events);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.toolInputError?.code).toBe("tool_input_error");
      expect(calls[0]!.toolInputError?.rawInput).toBe('{"path":');
    });

    // Google SSE with non-object functionCall.args
    const googleBody = sseFrame({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name: "write", args: '["not-an-object"]' } }],
          },
          finishReason: "STOP",
        },
      ],
    });

    const googleProvider = createGoogleProvider({
      apiKey: "goog-test",
      fetch: async () => sseResponse(googleBody),
    });
    const gRes = await collect(googleProvider, makeRequest({ tools: SAMPLE_TOOLS }));
    const gCalls = toolCallsOf(gRes.events);
    expect(gCalls).toHaveLength(1);
    expect(gCalls[0]!.toolInputError?.code).toBe("tool_input_error");
    expect(gCalls[0]!.toolInputError?.message).toContain("array");
  });

  test("loop.ts does NOT execute tool or crash on toolInputError and feeds self-correction error back to model", async () => {
    const targetFile = path.join(workspace, "should-not-write-first.txt");
    const fixedFile = path.join(workspace, "fixed.txt");
    const seenRequests: ProviderRequest[] = [];
    let step = 0;

    const provider: Provider = {
      name: "scripted",
      async *stream(req) {
        seenRequests.push(req);
        step += 1;
        if (step === 1) {
          yield {
            type: "tool_call",
            id: "call_bad_1",
            name: "write",
            arguments: '{"path":"should-not-write-first.txt","content":"oops',
            toolInputError: {
              code: "tool_input_error",
              message: "Invalid JSON in tool arguments: Unterminated string",
              rawInput: '{"path":"should-not-write-first.txt","content":"oops',
            },
          };
          yield { type: "done", stopReason: "tool_use" };
          return;
        }
        if (step === 2) {
          yield {
            type: "tool_call",
            id: "call_good_2",
            name: "write",
            arguments: JSON.stringify({ path: "fixed.txt", content: "self-corrected" }),
          };
          yield { type: "done", stopReason: "tool_use" };
          return;
        }
        yield { type: "text", text: "Recovered and wrote fixed.txt" };
        yield { type: "done", stopReason: "end" };
      },
    };

    const { deps, kernel, store } = makeLoopDeps(provider, { budget: { maxSteps: 5 } });
    try {
      const outcome = await runTurn(deps, "write the file");
      expect(outcome.exit.terminal).toBe("succeeded");
      expect(outcome.text).toContain("Recovered and wrote fixed.txt");
      expect(existsSync(targetFile)).toBe(false);
      expect(existsSync(fixedFile)).toBe(true);
      expect(readFileSync(fixedFile, "utf8")).toBe("self-corrected");

      // Step 2 request must contain the structured tool_input_error result for call_bad_1
      const step2ToolMsgs = seenRequests[1]!.messages.filter(
        (m) => m.role === "tool" && m.toolCallId === "call_bad_1",
      );
      expect(step2ToolMsgs).toHaveLength(1);
      const errContent = String(step2ToolMsgs[0]!.content);
      expect(errContent).toContain("tool_input_error");
      expect(errContent).toContain("Unterminated string");
      expect(errContent).toContain('{"path":"should-not-write-first.txt","content":"oops');
    } finally {
      await kernel.close();
      store.close();
    }
  }, 15_000);
});

describe("Track A: Prompt-Cache-Safe maxSteps (toolChoice: 'none')", () => {
  test("OpenAI and OpenAI-compatible wire tool_choice: 'none' while keeping tools intact", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const okSse =
      sseFrame({ id: "c1", choices: [{ index: 0, delta: { content: "summary" }, finish_reason: null }] }) +
      sseFrame({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      sseFrame("[DONE]");

    await withServer(
      (req) => {
        capturedBodies.push(req.body as Record<string, unknown>);
        return sseResponse(okSse);
      },
      async (server) => {
        const openai = createOpenAiProvider({ apiKey: "sk-test", baseUrl: server.baseUrl });
        await collect(openai, makeRequest({ tools: SAMPLE_TOOLS, toolChoice: "none" }));

        const compat = createOpenAiCompatibleProvider({
          name: "groq",
          baseUrl: server.baseUrl,
          credential: { kind: "apiKey", value: "gsk-test" },
        });
        await collect(compat, makeRequest({ tools: SAMPLE_TOOLS, toolChoice: "none" }));
      },
    );

    expect(capturedBodies).toHaveLength(2);
    for (const body of capturedBodies) {
      expect(Array.isArray(body.tools)).toBe(true);
      expect((body.tools as unknown[]).length).toBe(1);
      expect(body.tool_choice).toBe("none");
    }
  });

  test("Anthropic wires tool_choice: { type: 'none' } while keeping tools intact", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const okSse =
      sseFrame({ type: "message_start", message: { id: "m1", usage: { input_tokens: 5 } } }, "message_start") +
      sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "summary" } }, "content_block_delta") +
      sseFrame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }, "message_delta");

    await withServer(
      (req) => {
        capturedBody = req.body as Record<string, unknown>;
        return sseResponse(okSse);
      },
      async (server) => {
        const anthropic = createAnthropicProvider({ apiKey: "sk-ant-test", baseUrl: server.baseUrl });
        await collect(anthropic, makeRequest({ tools: SAMPLE_TOOLS, toolChoice: "none" }));
      },
    );

    expect(capturedBody).toBeDefined();
    expect(Array.isArray(capturedBody!.tools)).toBe(true);
    expect((capturedBody!.tools as unknown[]).length).toBe(1);
    expect(capturedBody!.tool_choice).toEqual({ type: "none" });
  });

  test("Google wires toolConfig.functionCallingConfig.mode = 'NONE' while keeping tools intact", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const okSse = sseFrame({
      candidates: [{ content: { role: "model", parts: [{ text: "summary" }] }, finishReason: "STOP" }],
    });

    const google = createGoogleProvider({
      apiKey: "goog-test",
      fetch: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return sseResponse(okSse);
      },
    });
    await collect(google, makeRequest({ tools: SAMPLE_TOOLS, toolChoice: "none" }));

    expect(capturedBody).toBeDefined();
    expect(Array.isArray(capturedBody!.tools)).toBe(true);
    expect((capturedBody!.tools as unknown[]).length).toBe(1);
    expect(capturedBody!.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
  });

  test("loop.ts final step preserves tools definitions, sets toolChoice: 'none', and injects final-step guidance", async () => {
    writeFileSync(path.join(workspace, "notes.txt"), "hello world");
    const seenRequests: ProviderRequest[] = [];
    let step = 0;

    const provider: Provider = {
      name: "scripted",
      async *stream(req) {
        seenRequests.push(req);
        step += 1;
        if (step === 1) {
          yield { type: "tool_call", id: "call_1", name: "read", arguments: JSON.stringify({ path: "notes.txt" }) };
          yield { type: "done", stopReason: "tool_use" };
          return;
        }
        yield { type: "text", text: "Final summary without calling tools." };
        yield { type: "done", stopReason: "end" };
      },
    };

    const { deps, kernel, store } = makeLoopDeps(provider, { budget: { maxSteps: 2 } });
    try {
      const outcome = await runTurn(deps, "inspect notes.txt and summarize");
      expect(outcome.exit.terminal).toBe("succeeded");
      expect(outcome.text).toContain("Final summary without calling tools.");
      expect(seenRequests).toHaveLength(2);

      // Step 1: normal step (tools present, toolChoice omitted, no final-step prompt)
      const req1 = seenRequests[0]!;
      expect(req1.tools.length).toBeGreaterThan(0);
      expect(req1.toolChoice).toBeUndefined();
      expect(req1.messages.some((m) => String(m.content).includes(MAX_STEPS_FINAL_PROMPT))).toBe(false);

      // Step 2 (final step): tools preserved identically, toolChoice === "none", guidance injected at tail
      const req2 = seenRequests[1]!;
      expect(req2.tools.map((t) => t.name)).toEqual(req1.tools.map((t) => t.name));
      expect(req2.toolChoice).toBe("none");
      const lastMsg = req2.messages[req2.messages.length - 1]!;
      expect(lastMsg.role).toBe("user");
      expect(String(lastMsg.content)).toBe(MAX_STEPS_FINAL_PROMPT);

      // Transient final-step guidance must NOT pollute the durable transcript store
      const stored = store.history(deps.sessionId);
      expect(stored.some((m) => String(m.content).includes(MAX_STEPS_FINAL_PROMPT))).toBe(false);
    } finally {
      await kernel.close();
      store.close();
    }
  }, 15_000);
});
