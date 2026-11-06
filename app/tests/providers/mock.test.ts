/**
 * mock.test.ts — the offline provider, which is what `hzcode` uses by default.
 *
 * The mock is deterministic and has no endpoint, so these tests drive the
 * iterable directly: a plain message, the one glob call, the summarizing second
 * turn, and the proof that an exchange can never loop.
 */

import { describe, expect, test } from "bun:test";
import {
  createMockProvider,
  MOCK_GREETING,
  MOCK_LOOKING,
  MOCK_TOOL_CALL_ID,
} from "../../src/core/providers/mock";
import type { ChatMsg, ProviderEvent } from "../../src/contracts";
import { lastDone, makeRequest, parseJson, run, textOf, toolCallsOf } from "./helpers";

const provider = createMockProvider();

async function turn(messages: ChatMsg[], signal?: AbortSignal): Promise<ProviderEvent[]> {
  const result = run(provider, makeRequest({ messages, ...(signal ? { signal } : {}) }));
  await result.done;
  expect(result.thrown).toBeNull();
  return result.events;
}

/** The state after the tool call: assistant turn plus the tool's answer. */
function withToolResult(output: string, toolName = "glob"): ChatMsg[] {
  return [
    { role: "user", content: "list files" },
    { role: "assistant", content: MOCK_LOOKING, toolCalls: [{ id: MOCK_TOOL_CALL_ID, name: "glob", arguments: '{"pattern":"*"}' }] },
    { role: "tool", content: output, toolCallId: MOCK_TOOL_CALL_ID, toolName },
  ];
}

describe("mock provider", () => {
  test("a plain message streams the greeting and one done/end", async () => {
    const events = await turn([{ role: "user", content: "hello there" }]);

    expect(events).toEqual([{ type: "text", text: MOCK_GREETING }, { type: "done", stopReason: "end" }]);
    expect(toolCallsOf(events)).toHaveLength(0);
    // Deterministic: the same prompt produces exactly the same events.
    expect(await turn([{ role: "user", content: "hello there" }])).toEqual(events);
  });

  test("a request to list files streams one glob tool call and done/tool_use", async () => {
    const events = await turn([{ role: "user", content: "please list files in this workspace" }]);

    expect(events.map((event) => event.type)).toEqual(["text", "tool_call", "done"]);
    expect(events[0]).toEqual({ type: "text", text: MOCK_LOOKING });

    const calls = toolCallsOf(events);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ type: "tool_call", id: MOCK_TOOL_CALL_ID, name: "glob", arguments: '{"pattern":"*"}' });
    expect(parseJson(calls[0]!.arguments)).toEqual({ pattern: "*" });
    expect(lastDone(events)).toEqual({ type: "done", stopReason: "tool_use" });
  });

  test("only the file-question wordings trigger the tool call", async () => {
    for (const prompt of ["list files", "ls", "ls -la", "what is in here?"]) {
      const events = await turn([{ role: "user", content: prompt }]);
      expect(toolCallsOf(events).map((call) => call.name)).toEqual(["glob"]);
      expect(lastDone(events).stopReason).toBe("tool_use");
    }

    for (const prompt of ["hello", "list everything", "read the file", "summarize the repo"]) {
      const events = await turn([{ role: "user", content: prompt }]);
      expect(toolCallsOf(events)).toHaveLength(0);
      expect(textOf(events)).toBe(MOCK_GREETING);
      expect(lastDone(events).stopReason).toBe("end");
    }
  });

  test("the second turn after a tool result streams a short summary and done/end", async () => {
    const events = await turn(withToolResult("a.ts\nb.ts\n"));

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("text");
    const summary = textOf(events);
    expect(summary).toContain("Mock mode: the glob tool returned");
    expect(summary).toContain("(2 lines)");
    expect(summary).toContain("First line: a.ts");
    expect(toolCallsOf(events)).toHaveLength(0);
    expect(lastDone(events)).toEqual({ type: "done", stopReason: "end" });
  });

  test("the summary reports the tool name, the size and a truncated first line", async () => {
    expect(textOf(await turn(withToolResult("just one line", "read")))).toBe(
      "Mock mode: the read tool returned 13 characters. First line: just one line",
    );

    const long = "x".repeat(200);
    const truncated = textOf(await turn(withToolResult(long, "read")));
    expect(truncated).toContain("returned 200 characters");
    expect(truncated).toContain(`First line: ${"x".repeat(160)}\u2026`);

    expect(textOf(await turn(withToolResult("", "glob")))).toBe("Mock mode: the glob tool returned nothing.");

    // A tool result with no tool name still reads sensibly.
    expect(textOf(await turn([{ role: "user", content: "hello" }, { role: "tool", content: "x", toolCallId: MOCK_TOOL_CALL_ID }]))).toBe(
      "Mock mode: the tool tool returned 1 characters. First line: x",
    );
  });

  test("an exchange can never loop: exactly one tool call, then a turn that ends", async () => {
    let messages: ChatMsg[] = [{ role: "user", content: "list files" }];
    const reasons: string[] = [];
    let calls = 0;

    for (let turns = 0; turns < 10; turns += 1) {
      const events = await turn(messages);
      const emitted = toolCallsOf(events);
      calls += emitted.length;
      reasons.push(lastDone(events).stopReason);
      messages = [
        ...messages,
        {
          role: "assistant",
          content: textOf(events),
          toolCalls: emitted.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
        },
        ...emitted.map((call) => ({ role: "tool" as const, content: "a.ts\nb.ts", toolCallId: call.id, toolName: call.name })),
      ];
      if (reasons[reasons.length - 1] !== "tool_use") break;
    }

    // Two provider calls only: the single tool call, then the summary that ends the turn.
    expect(reasons).toEqual(["tool_use", "end"]);
    expect(calls).toBe(1);
  });

  test("an already-aborted signal ends immediately with done/abort", async () => {
    const controller = new AbortController();
    controller.abort();

    const events = await turn([{ role: "user", content: "list files" }], controller.signal);
    expect(events).toEqual([{ type: "done", stopReason: "abort" }]);
  });
});
