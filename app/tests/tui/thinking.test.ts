import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRenderer } from "../../src/tui/render";
import { colorEnabled, setColorEnabled, strip } from "../../src/tui/style";
import { createAnthropicProvider } from "../../src/core/providers/anthropic";
import { createOpenAiCompatibleProvider } from "../../src/core/providers/openai-compatible";

let was = false;
beforeAll(() => {
  was = colorEnabled();
  setColorEnabled(false);
});
afterAll(() => setColorEnabled(was));

function run(rich: boolean, events: unknown[]): string {
  const chunks: string[] = [];
  const r = createRenderer({ wrap: false, rich, out: (c) => void chunks.push(c) });
  for (const e of events) r.handle(e as never);
  return strip(chunks.join(""));
}

describe("assistant.thinking", () => {
  test("rich: collapsed to one dim line before the answer, text kept for /think", () => {
    const chunks: string[] = [];
    const r = createRenderer({ wrap: false, rich: true, out: (c) => void chunks.push(c) });
    r.handle({ type: "assistant.thinking", text: "step one\n" });
    r.handle({ type: "assistant.thinking", text: "step two\n" });
    expect(chunks.join("")).toBe(""); // nothing printed while it streams
    r.handle({ type: "assistant.delta", text: "Answer." });
    r.handle({ type: "assistant.done", text: "Answer." });
    const out = strip(chunks.join(""));
    expect(out).toMatch(/^\u25c6 Thought for \d+ms \u00b7 2 lines \u00b7 \/think to expand\n/);
    expect(out).toContain("Answer.");
    expect(r.lastThinking?.()).toBe("step one\nstep two\n");
  });

  test("plain mode ignores the event entirely", () => {
    expect(run(false, [{ type: "assistant.thinking", text: "secret thoughts" }, { type: "assistant.delta", text: "ok" }])).toBe("ok");
  });
});

function sse(lines: unknown[]): Response {
  const body = lines.map((l) => `data: ${typeof l === "string" ? l : JSON.stringify(l)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(it: AsyncIterable<{ type: string; text?: string }>): Promise<Array<{ type: string; text?: string }>> {
  const out: Array<{ type: string; text?: string }> = [];
  for await (const e of it) out.push(e);
  return out;
}

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});
function stub(res: Response): void {
  globalThis.fetch = (async () => res) as never;
}

describe("providers stream reasoning", () => {
  const req = { model: "m", system: "", messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal } as never;

  test("openai-compatible reasoning_content becomes thinking events", async () => {
    stub(
      sse([
        { choices: [{ delta: { reasoning_content: "hmm" } }] },
        { choices: [{ delta: { content: "hi" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        "[DONE]",
      ]),
    );
    const p = createOpenAiCompatibleProvider({ name: "oc", baseUrl: "http://x/v1", credential: { kind: "apiKey", value: "k" } });
    const evs = await collect(p.stream(req));
    expect(evs.filter((e) => e.type === "thinking")).toEqual([{ type: "thinking", text: "hmm" }]);
    expect(evs.filter((e) => e.type === "text")).toEqual([{ type: "text", text: "hi" }]);
  });

  test("anthropic thinking_delta becomes thinking events", async () => {
    stub(
      sse([
        { type: "message_start", message: { usage: { input_tokens: 1 } } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pondering" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "yo" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ]),
    );
    const p = createAnthropicProvider({ apiKey: "k" });
    const evs = await collect(p.stream(req));
    expect(evs.filter((e) => e.type === "thinking")).toEqual([{ type: "thinking", text: "pondering" }]);
  });
});
