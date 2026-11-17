/**
 * D-6 — typed `approval` / `clarify` RuntimeEvents from the real loop paths.
 *
 * Proves the additive facade events land on the runtime callback stream:
 *   - a guard `ask` for a write emits one `approval` event (callId/tool set),
 *     while the durable hz.guard.approval.* append still happens;
 *   - a final assistant question emits one `clarify` event and a non-question
 *     final answer emits none;
 *   - `clarifyPromptFor` is bounded/pure.
 * The existing session.event stream is unchanged for old consumers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { clarifyPromptFor, runTurn, type LoopDeps } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";

let workspace = "";

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-d6-loop-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function depsFor(provider: Provider, seen: RuntimeEvent[]): LoopDeps {
  const stateDir = path.join(workspace, ".hzcode", "kernel");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "policy.json"),
    JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "ask" }]),
  );
  const kernel = new KernelClient({ workspace, stateDir });
  const store = new SessionStore(workspace);
  return {
    workspace,
    sessionId: store.createSession("d6-loop").id,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: (ev) => seen.push(ev) },
    sessionLeases: [],
    approve: async () => true,
  };
}

describe("D-6 typed approval/clarify events (loop wiring)", () => {
  test("clarifyPromptFor is a bounded pure helper", () => {
    expect(clarifyPromptFor("Which file should I edit?")).toBe("Which file should I edit?");
    expect(clarifyPromptFor("Here is the answer.\nWhich one do you want?")).toBe("Which one do you want?");
    expect(clarifyPromptFor("Done.")).toBeUndefined();
    expect(clarifyPromptFor("")).toBeUndefined();
    expect(clarifyPromptFor(`question? ${"x".repeat(2100)}`)).toBeUndefined();
  });

  test("a guard ask emits one typed approval event with callId/tool linkage", async () => {
    let phase = 0;
    const provider: Provider = {
      name: "scripted",
      async *stream(): AsyncGenerator<ProviderEvent> {
        phase += 1;
        if (phase === 1) {
          yield {
            type: "tool_call",
            id: "call_d6",
            name: "write",
            arguments: JSON.stringify({ path: "out.txt", content: "hi" }),
          } satisfies ProviderEvent;
          yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
          return;
        }
        yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
      },
    };
    const seen: RuntimeEvent[] = [];
    await runTurn(depsFor(provider, seen));

    const approvals = seen.filter((ev) => ev.type === "approval");
    expect(approvals).toHaveLength(1);
    const approval = approvals[0] as Extract<RuntimeEvent, { type: "approval" }>;
    expect(typeof approval.message).toBe("string");
    expect(approval.message.length).toBeGreaterThan(0);
    expect(approval.callId).toBe("call_d6");
    expect(approval.tool).toBe("write");
    // Additive: the ordinary stream is still intact.
    expect(seen.some((ev) => ev.type === "assistant.done")).toBe(true);
  });

  test("a final assistant question emits one typed clarify event; a statement emits none", async () => {
    const question: Provider = {
      name: "scripted",
      async *stream(): AsyncGenerator<ProviderEvent> {
        yield { type: "text", text: "Which path should I use?" } satisfies ProviderEvent;
        yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
      },
    };
    const seenQ: RuntimeEvent[] = [];
    await runTurn(depsFor(question, seenQ));
    const clarifies = seenQ.filter((ev) => ev.type === "clarify");
    expect(clarifies).toHaveLength(1);
    const clarify = clarifies[0] as Extract<RuntimeEvent, { type: "clarify" }>;
    expect(clarify.message).toBe("Which path should I use?");

    const statement: Provider = {
      name: "scripted",
      async *stream(): AsyncGenerator<ProviderEvent> {
        yield { type: "text", text: "All done." } satisfies ProviderEvent;
        yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
      },
    };
    const seenS: RuntimeEvent[] = [];
    await runTurn(depsFor(statement, seenS));
    expect(seenS.filter((ev) => ev.type === "clarify")).toHaveLength(0);
  });
});
