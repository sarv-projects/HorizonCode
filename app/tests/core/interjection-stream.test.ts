import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { InterjectionBuffer } from "../../src/core/interjection";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";

let workspace = "";

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-interject-stream-"));
  process.env.HZ_ACTION_STATIONARITY = "0";
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("mid-stream interjection", () => {
  test("cuts provider stream and admits steer at next safe point", async () => {
    const buffer = new InterjectionBuffer();
    let providerCalls = 0;
    const provider: Provider = {
      name: "slow-mock",
      async *stream(req) {
        providerCalls += 1;
        if (providerCalls > 1) {
          yield { type: "text", text: "done" } satisfies ProviderEvent;
          yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
          return;
        }
        yield { type: "text", text: "part0 " } satisfies ProviderEvent;
        buffer.push("steer mid stream");
        for (let i = 1; i < 8; i += 1) {
          if (req.signal.aborted) break;
          yield { type: "text", text: `part${i} ` } satisfies ProviderEvent;
          await new Promise((r) => setTimeout(r, 5));
        }
        yield {
          type: "done",
          stopReason: req.signal.aborted ? "abort" : "end",
        } satisfies ProviderEvent;
      },
    };
    const admitted: string[] = [];
    const kernel = new KernelClient({ workspace, stateDir: `${workspace}/.hz/state/kernel` });
    const store = new SessionStore(workspace);
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("interject-stream").id,
      model: "mock-1",
      provider,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: {
        onEvent: (ev) => {
          if (ev.type === "interjection.admitted") admitted.push(ev.text);
        },
      },
      sessionLeases: [],
      approve: async () => true,
      interjection: buffer,
      budget: { maxSteps: 20 },
    };
    try {
      const result = await runTurn(deps, "long task");
      expect(result.exit.terminal).toBe("succeeded");
      expect(admitted).toContain("steer mid stream");
      const history = store.history(deps.sessionId);
      expect(history.some((m) => m.role === "user" && (m.content ?? "").includes("steer mid stream"))).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("drops assembled tool calls when steer cuts the stream", async () => {
    const buffer = new InterjectionBuffer();
    const notices: string[] = [];
    let providerCalls = 0;
    const provider: Provider = {
      name: "tool-then-slow",
      async *stream(req) {
        providerCalls += 1;
        if (providerCalls > 1) {
          yield { type: "text", text: "done" } satisfies ProviderEvent;
          yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
          return;
        }
        yield { type: "text", text: "preamble " } satisfies ProviderEvent;
        yield {
          type: "tool_call",
          id: "call_drop",
          name: "read",
          arguments: '{"path": "README.md"',
        } satisfies ProviderEvent;
        buffer.push("steer before dispatch");
        for (let i = 0; i < 12; i += 1) {
          if (req.signal.aborted) break;
          yield { type: "text", text: `tail${i} ` } satisfies ProviderEvent;
          await new Promise((r) => setTimeout(r, 5));
        }
        yield { type: "done", stopReason: req.signal.aborted ? "abort" : "tool_use" } satisfies ProviderEvent;
      },
    };
    const kernel = new KernelClient({ workspace, stateDir: `${workspace}/.hz/state/kernel` });
    const store = new SessionStore(workspace);
    writeFileSync(path.join(workspace, "README.md"), "hello");
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("interject-drop-tools").id,
      model: "mock-1",
      provider,
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
      interjection: buffer,
      budget: { maxSteps: 20 },
    };
    try {
      const result = await runTurn(deps, "task");
      expect(result.exit.terminal).toBe("succeeded");
      expect(notices.some((m) => m.includes("dropped") && m.includes("tool call"))).toBe(true);
      expect(notices.some((m) => m.includes("incomplete wire JSON"))).toBe(true);
      const history = store.history(deps.sessionId);
      const toolMsgs = history.filter((m) => m.role === "tool");
      expect(toolMsgs.every((m) => String(m.content ?? "").includes("not executed"))).toBe(true);
      expect(history.some((m) => m.role === "user" && (m.content ?? "").includes("steer before dispatch"))).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("refuses dispatch when provider emits tool_use with broken argument JSON", async () => {
    const notices: string[] = [];
    let calls = 0;
    const provider: Provider = {
      name: "broken-args",
      async *stream(req) {
        calls += 1;
        if (calls > 1) {
          yield { type: "text", text: "ok" } satisfies ProviderEvent;
          yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
          return;
        }
        yield {
          type: "tool_call",
          id: "call_broken",
          name: "read",
          arguments: '{"path": "README.md"',
        } satisfies ProviderEvent;
        yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
      },
    };
    const kernel = new KernelClient({ workspace, stateDir: `${workspace}/.hz/state/kernel` });
    const store = new SessionStore(workspace);
    writeFileSync(path.join(workspace, "README.md"), "hello");
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("wire-incomplete").id,
      model: "mock-1",
      provider,
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
      budget: { maxSteps: 20 },
    };
    try {
      const result = await runTurn(deps, "read file");
      expect(result.exit.terminal).toBe("succeeded");
      expect(notices.some((m) => m.includes("incomplete wire JSON"))).toBe(true);
      const tools = store.history(deps.sessionId).filter((m) => m.role === "tool");
      expect(tools.length).toBe(1);
      expect(String(tools[0]?.content ?? "")).toContain("not executed");
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("liveSteering provider claims steer mid-stream without hard cut (response.steer reduced)", async () => {
    const buffer = new InterjectionBuffer();
    const admitted: string[] = [];
    const notices: string[] = [];
    let providerCalls = 0;
    let claimed = false;
    const provider: Provider = {
      name: "live-steer-mock",
      liveSteering: true,
      async *stream(req) {
        providerCalls += 1;
        if (providerCalls > 1) {
          yield { type: "text", text: "after-steer-step" } satisfies ProviderEvent;
          yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
          return;
        }
        yield { type: "text", text: "before " } satisfies ProviderEvent;
        buffer.push("live steer please");
        // Give the loop a tick to observe the buffer; liveSteering skips hard cut.
        await new Promise((r) => setTimeout(r, 15));
        const claim = await req.liveSteering?.claim(req.signal);
        expect(claim).toBeDefined();
        expect(claim!.messages).toEqual(["live steer please"]);
        claim!.accept();
        claimed = true;
        yield { type: "text", text: "continued " } satisfies ProviderEvent;
        yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
      },
    };
    const kernel = new KernelClient({ workspace, stateDir: `${workspace}/.hz/state/kernel` });
    const store = new SessionStore(workspace);
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("live-steer").id,
      model: "mock-1",
      provider,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: {
        onEvent: (ev) => {
          if (ev.type === "interjection.admitted") admitted.push(ev.text);
          if (ev.type === "notice") notices.push(ev.message);
        },
      },
      sessionLeases: [],
      approve: async () => true,
      interjection: buffer,
      budget: { maxSteps: 20 },
    };
    try {
      const result = await runTurn(deps, "task");
      expect(result.exit.terminal).toBe("succeeded");
      expect(claimed).toBe(true);
      expect(admitted).toContain("live steer please");
      expect(notices.some((m) => m.includes("in-flight response (live)"))).toBe(true);
      expect(notices.some((m) => m.includes("dropped") && m.includes("tool call"))).toBe(false);
      const history = store.history(deps.sessionId);
      expect(history.some((m) => m.role === "user" && (m.content ?? "").includes("live steer please"))).toBe(true);
      expect(history.some((m) => m.role === "assistant" && (m.content ?? "").includes("continued"))).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });
});