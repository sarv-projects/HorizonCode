/**
 * session-kernel-reconcile-loop.test.ts — live reconcile notice at turn/batch end (ruling 235).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EventTypes, newId, nowIso } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, streamFor, type LoopDeps } from "../../src/core/loop";
import { kernelStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-sk-loop-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("session↔kernel reconcile in runTurn", () => {
  test("emits notice when session has orphan tool.call", async () => {
    const store = new SessionStore(workspace);
    const session = store.createSession("sk");
    const sid = session.id;
    const kernel = new KernelClient({ workspace, stateDir: kernelStateDir(workspace) });
    const stream = streamFor(sid);
    await kernel.appendEvent(stream, {
      id: newId(),
      ts: nowIso(),
      stream,
      type: EventTypes.toolCall,
      actor: { kind: "tool", id: "read" },
      payload: { id: "orphan", name: "read" },
    });
    const notices: string[] = [];
    const deps: LoopDeps = {
      workspace,
      sessionId: sid,
      model: "m",
      provider: {
        name: "scripted",
        async *stream() {
          yield { type: "text", text: "hi" };
          yield { type: "done", stopReason: "end" };
        },
      },
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: {
        onEvent: (ev) => {
          if (ev.type === "notice") notices.push(ev.message);
        },
      },
      sessionLeases: [],
      approve: async () => true,
    };
    try {
      const result = await runTurn(deps, "hello");
      expect(result.exit.terminal).toBe("succeeded");
      expect(notices.some((m) => m.includes("session↔kernel reconcile"))).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("stays silent when tool.call pairs with receipt", async () => {
    writeFileSync(path.join(workspace, "a.txt"), "x\n");
    const store = new SessionStore(workspace);
    const session = store.createSession("sk2");
    const sid = session.id;
    const kernel = new KernelClient({ workspace, stateDir: kernelStateDir(workspace) });
    const notices: string[] = [];
    const block =
      `<forge_tool_call><tool_name>read</tool_name><arguments>{"path":"a.txt"}</arguments></forge_tool_call>`;
    const deps: LoopDeps = {
      workspace,
      sessionId: sid,
      model: "m",
      provider: {
        name: "scripted",
        async *stream() {
          yield { type: "text", text: block };
          yield { type: "done", stopReason: "tool_use" };
        },
      },
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: {
        onEvent: (ev) => {
          if (ev.type === "notice") notices.push(ev.message);
        },
      },
      sessionLeases: [],
      approve: async () => true,
    };
    try {
      await runTurn(deps, "read");
      const second: LoopDeps = {
        ...deps,
        provider: {
          name: "scripted",
          async *stream() {
            yield { type: "text", text: "done" };
            yield { type: "done", stopReason: "end" };
          },
        },
      };
      await runTurn(second, "continue");
      expect(notices.some((m) => m.includes("session↔kernel reconcile"))).toBe(false);
    } finally {
      await kernel.close();
      store.close();
    }
  });
});
