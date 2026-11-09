/**
 * subagent-events.test.ts — S1 P2: a delegated run's activity reaches the
 * parent stream (bounded) as `subagent.event`, in-process and over the server.
 * Revert check: restoring the no-op child `onEvent` makes every case fail.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { RuntimeEvent, ServerNotification } from "../../src/contracts";
import { SESSION_EVENT_METHOD } from "../../src/contracts";
import { createRuntime } from "../../src/core/index";
import { createScriptedProvider, textTurn, toolCallTurn } from "../../src/core/providers/scripted";
import { createServer } from "../../src/core/server";
import { boundChildEvent, SUBAGENT_EVENT_CAP, SUBAGENT_EVENT_TEXT_CAP } from "../../src/core/subagent";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(() => cleanupTemps());

// Parent asks for the agent tool; the child globs then answers; parent finishes.
function script() {
  return createScriptedProvider([
    toolCallTurn({ name: "agent", args: { task: "list files" } }),
    toolCallTurn({ name: "glob", args: { pattern: "*" } }),
    textTurn("child report"),
    textTurn("parent done"),
  ]);
}

describe("subagent.event forwarding", () => {
  test("runtime.send surfaces the child's tool cards wrapped as subagent.event", async () => {
    const workspace = tempDir("hz-subev-");
    const runtime = await createRuntime({ workspace, mock: true });
    try {
      (runtime as unknown as { provider: unknown }).provider = script();
      runtime.setApprovalHandler(async () => true);
      const seen: RuntimeEvent[] = [];
      await runtime.send("delegate", { onEvent: (ev) => seen.push(ev) });
      const nested = seen.filter((e) => e.type === "subagent.event") as Extract<RuntimeEvent, { type: "subagent.event" }>[];
      expect(nested.length).toBeGreaterThan(0);
      expect(nested.every((n) => n.depth === 1 && n.name === "agent" && n.agentId !== "")).toBe(true);
      const inner = nested.map((n) => n.event);
      expect(inner.some((e) => e.type === "tool.card" && e.name === "glob" && e.status === "running")).toBe(true);
      expect(inner.some((e) => e.type === "tool.card" && e.name === "glob" && e.status === "ok")).toBe(true);
      // Deltas and turn boundaries of the child never leak upward.
      expect(inner.some((e) => e.type === "assistant.delta" || e.type === "turn.done")).toBe(false);
    } finally {
      await runtime.close();
    }
  }, 30000);

  test("the server relays subagent events as session.event notifications", async () => {
    const workspace = tempDir("hz-subev-srv-");
    const probe = await createRuntime({ workspace, mock: true });
    const proto = Object.getPrototypeOf(probe) as { send: (...a: unknown[]) => Promise<unknown> };
    await probe.close();
    const original = proto.send;
    proto.send = function (this: { provider: unknown; setApprovalHandler(fn: () => Promise<boolean>): void }, ...args: unknown[]) {
      this.provider = script();
      this.setApprovalHandler(async () => true);
      return original.apply(this, args);
    };
    const frames: string[] = [];
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const server = createServer({
      workspace,
      mock: true,
      output: (l) => void frames.push(l),
      input: {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (queue.length > 0) {
              yield queue.shift() as string;
              continue;
            }
            if (done) return;
            await new Promise<void>((r) => (wake = r));
          }
        },
      },
    });
    const run = server.start();
    const push = (o: unknown): void => {
      queue.push(JSON.stringify(o) + "\n");
      wake?.();
    };
    const waitFor = async (id: number): Promise<Record<string, unknown>> => {
      for (let i = 0; i < 600; i++) {
        for (const f of frames) {
          const o = JSON.parse(f) as { id?: number };
          if (o.id === id) return o as Record<string, unknown>;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("timeout " + id + " " + frames.join("").slice(0, 600));
    };
    try {
      push({ id: 1, method: "session.create" });
      const sid = ((await waitFor(1)).result as { sessionId: string }).sessionId;
      push({ id: 2, method: "session.prompt", params: { sessionId: sid, text: "delegate" } });
      await waitFor(2);
      const inner = frames
        .map((f) => JSON.parse(f) as ServerNotification)
        .filter((n) => n.method === SESSION_EVENT_METHOD)
        .map((n) => (n.params as { event: RuntimeEvent }).event)
        .filter((e) => e.type === "subagent.event");
      expect(inner.length).toBeGreaterThan(0);
    } finally {
      proto.send = original;
      done = true;
      wake?.();
      await run;
      await server.stop();
    }
  }, 60000);

  test("child events are bounded: text truncated, noise dropped", () => {
    const long = "x".repeat(5000);
    const card = boundChildEvent({ type: "tool.card", callId: "1", name: "read", args: { a: long }, status: "ok", summary: long });
    expect(card?.type).toBe("tool.card");
    if (card?.type === "tool.card") {
      expect((card.summary ?? "").length).toBeLessThanOrEqual(SUBAGENT_EVENT_TEXT_CAP);
      expect(JSON.stringify(card.args).length).toBeLessThan(SUBAGENT_EVENT_TEXT_CAP + 50);
    }
    expect(boundChildEvent({ type: "assistant.delta", text: "x" })).toBeNull();
    expect(boundChildEvent({ type: "turn.done" })).toBeNull();
    expect(SUBAGENT_EVENT_CAP).toBe(40);
  });
});
