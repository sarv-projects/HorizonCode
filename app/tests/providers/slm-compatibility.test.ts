/**
 * slm-compatibility.test.ts — can a turn run through an OpenAI-compatible local SLM?
 *
 * Hermetic by default: `globalThis.fetch` is stubbed with a canned SSE stream, so
 * nothing leaves the process and no model is downloaded. The only live network
 * path is opt-in (`HZ_LIVE_SLM=1`) and reads `SLM_BASE_URL` / `SLM_MODEL` from the
 * environment (Ollama/NIM-style OpenAI-compatible hosts). No credential is
 * committed: a local SLM is a keyless host (`credential: { kind: "none" }`).
 *
 * RECOMMENDED MODEL (2026 sub-2GB coding SLM): Qwen2.5-Coder-1.5B-Instruct
 * (Apache-2.0, ~1.1GB Q4_K_M, 32K context, strong code + native tool-call support
 * via an Ollama GGUF). Run it as `ollama run qwen2.5-coder:1.5b` and serve the
 * OpenAI-compatible `/v1/chat/completions` endpoint on port 11434. Alternatives
 * with weaker tool calling: SmolLM2-1.7B-Instruct, DeepSeek-R1-Distill-Qwen-1.5B.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAiCompatibleProvider } from "../../src/core/providers/openai-compatible";
import { lastDone, makeRequest, run, textOf, toolCallsOf } from "./helpers";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
let captured: Captured | undefined;

/** Stub fetch with an OpenAI-chat SSE stream; record the request the wire sends. */
function stubSlm(frames: unknown[]): void {
  const body =
    frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  captured = undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    captured = {
      url,
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as never;
}

function localSlm(baseUrl: string) {
  return createOpenAiCompatibleProvider({ name: "local-slm", baseUrl, credential: { kind: "none" } });
}

describe("local SLM compatibility (hermetic fake fetch)", () => {
  test("a keyless local SLM completes a text turn on /v1/chat/completions", async () => {
    stubSlm([
      { choices: [{ index: 0, delta: { role: "assistant", content: "pong from local slm" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);

    const provider = localSlm("http://127.0.0.1:11434");
    expect(provider.name).toBe("local-slm");
    const result = run(
      provider,
      makeRequest({
        model: "qwen2.5-coder:1.5b",
        system: "reply briefly",
        messages: [{ role: "user", content: "ping" }],
      }),
    );
    await result.done;

    expect(result.thrown).toBeNull();
    expect(textOf(result.events)).toBe("pong from local slm");
    expect(lastDone(result.events).stopReason).toBe("end");
    expect(captured?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(captured?.body.model).toBe("qwen2.5-coder:1.5b");
    expect(captured?.body.stream).toBe(true);
    expect(captured?.headers.authorization).toBeUndefined(); // keyless local host
  });

  test("OpenAI-style tool_calls from the SLM surface as tool_call events", async () => {
    stubSlm([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_slm", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);

    const result = run(localSlm("http://127.0.0.1:11434/v1"), makeRequest({ model: "qwen2.5-coder:1.5b" }));
    await result.done;

    expect(result.thrown).toBeNull();
    const calls = toolCallsOf(result.events);
    expect(calls).toHaveLength(1);
    expect([calls[0]!.id, calls[0]!.name]).toEqual(["call_slm", "read"]);
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ path: "a.ts" });
    expect(lastDone(result.events).stopReason).toBe("tool_use");
    // A baseUrl already ending in /v1 must not double-append it.
    expect(captured?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });
});

/** Opt-in live probe: HZ_LIVE_SLM=1 SLM_BASE_URL=http://… SLM_MODEL=… bun test … */
const live = process.env.HZ_LIVE_SLM === "1" ? describe : describe.skip;

live("local SLM live (opt-in, real fetch)", () => {
  test(
    "runs one turn against SLM_BASE_URL / SLM_MODEL",
    async () => {
      const baseUrl = process.env.SLM_BASE_URL?.trim();
      const model = process.env.SLM_MODEL?.trim();
      expect(baseUrl, "SLM_BASE_URL is required for the live probe").toBeTruthy();
      expect(model, "SLM_MODEL is required for the live probe").toBeTruthy();
      // Real (restored) fetch; keyless local host, no credential in the repo.
      const result = run(
        localSlm(baseUrl!),
        makeRequest({ model: model!, messages: [{ role: "user", content: "Reply with exactly: pong" }], maxTokens: 64 }),
      );
      await result.done;
      expect(result.thrown).toBeNull();
      expect(textOf(result.events).length).toBeGreaterThan(0);
    },
    60_000,
  );
});
