/**
 * scripted.test.ts — the in-library test model (providers/scripted.ts).
 *
 * The contract is determinism and honesty: turns play in order, an aborted
 * signal consumes nothing, an exhausted script says nothing rather than
 * inventing a line, and a malformed turn fails the turn instead of looping.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMsg, ProviderEvent, ProviderRequest } from "../../src/contracts";
import { createScriptedProvider, isToolResultRequest, textTurn, toolCallTurn } from "../../src/core/providers/scripted";

function request(messages: ChatMsg[] = []): ProviderRequest {
  return {
    model: "scripted-1",
    system: "",
    messages,
    signal: new AbortController().signal,
  } as ProviderRequest;
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("createScriptedProvider", () => {
  test("plays turns in order and reports them spent", async () => {
    const provider = createScriptedProvider([textTurn("one"), textTurn("two")]);
    expect(provider.name).toBe("scripted");

    const first = await collect(provider.stream(request()));
    expect(first).toEqual([{ type: "text", text: "one" }, { type: "done", stopReason: "end" }]);
    expect(provider.consumed()).toBe(1);

    const second = await collect(provider.stream(request()));
    expect(second[0]).toEqual({ type: "text", text: "two" });
    expect(provider.consumed()).toBe(2);
  });

  test("a calls turn asks for its tools with deterministic ids and stops tool_use", async () => {
    const provider = createScriptedProvider([
      {
        kind: "calls",
        text: "looking",
        calls: [
          { name: "read", args: { path: "a.txt" } },
          { name: "glob", args: { pattern: "*.ts" }, id: "mine-1" },
        ],
      },
    ]);
    const events = await collect(provider.stream(request()));
    expect(events).toEqual([
      { type: "text", text: "looking" },
      { type: "tool_call", id: "scripted-1.1", name: "read", arguments: JSON.stringify({ path: "a.txt" }) },
      { type: "tool_call", id: "mine-1", name: "glob", arguments: JSON.stringify({ pattern: "*.ts" }) },
      { type: "done", stopReason: "tool_use" },
    ]);
  });

  test("an aborted signal consumes nothing and reports abort", async () => {
    const provider = createScriptedProvider([textTurn("never")]);
    const controller = new AbortController();
    controller.abort();
    const req = { ...request(), signal: controller.signal } as ProviderRequest;
    const events = await collect(provider.stream(req));
    expect(events).toEqual([{ type: "done", stopReason: "abort" }]);
    expect(provider.consumed()).toBe(0);

    // The turn is still there for a live request.
    const next = await collect(provider.stream(request()));
    expect(next[0]).toEqual({ type: "text", text: "never" });
  });

  test("an exhausted script says nothing and ends; it never invents a line", async () => {
    const provider = createScriptedProvider([]);
    expect(await collect(provider.stream(request()))).toEqual([{ type: "done", stopReason: "end" }]);
    expect(provider.consumed()).toBe(0);
  });

  test("an error turn reports the message and spends the turn", async () => {
    const provider = createScriptedProvider([{ kind: "error", message: "boom" }, textTurn("after")]);
    expect(await collect(provider.stream(request()))).toEqual([{ type: "error", message: "boom" }]);
    expect(provider.consumed()).toBe(1);
  });

  test("a calls turn with no calls fails the turn instead of looping", async () => {
    const provider = createScriptedProvider([{ kind: "calls", calls: [] }]);
    const events = await collect(provider.stream(request()));
    expect(events).toEqual([{ type: "error", message: 'scripted turn 1: kind "calls" carries no calls' }]);
  });

  test("records the requests it saw, in order", async () => {
    const provider = createScriptedProvider([textTurn("one"), textTurn("two")]);
    const first = request([{ role: "user", content: "hi" }]);
    await collect(provider.stream(first));
    await collect(provider.stream(request([{ role: "tool", content: "out", toolName: "glob" } as ChatMsg])));
    expect(provider.requests()).toHaveLength(2);
    expect(isToolResultRequest(provider.requests()[1]!)).toBe(true);
    expect(isToolResultRequest(provider.requests()[0]!)).toBe(false);
  });

  test("the script is copied: mutating the caller's array mid-run changes nothing", async () => {
    const turns = [textTurn("one"), textTurn("two")];
    const provider = createScriptedProvider(turns);
    turns[1] = textTurn("MUTATED");
    await collect(provider.stream(request()));
    const second = await collect(provider.stream(request()));
    expect(second[0]).toEqual({ type: "text", text: "two" });
  });

  test("toolCallTurn builds a calls turn with no leading text", () => {
    const turn = toolCallTurn({ name: "read", args: { path: "x" } });
    expect(turn).toEqual({ kind: "calls", calls: [{ name: "read", args: { path: "x" } }] });
  });
});
