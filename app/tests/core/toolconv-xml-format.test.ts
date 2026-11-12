/**
 * toolconv-xml-format.test.ts — malformed XML blocks stay text (docs/33 §5.14 partial).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, type RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { wrapXmlToolProvider } from "../../src/core/providers/toolconv/wrap-xml";
import { SessionStore } from "../../src/core/session";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-xml-fmt-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function badXmlProvider(): Provider {
  const inner: Provider = {
    name: "scripted",
    async *stream() {
      yield {
        type: "text",
        text: '<forge_tool_call><tool_name>evil</tool_name><arguments>{"path":</arguments></forge_tool_call>',
      };
      yield { type: "done", stopReason: "end" };
    },
  };
  return wrapXmlToolProvider(inner);
}

function endProvider(): Provider {
  return {
    name: "scripted",
    async *stream() {
      yield { type: "text", text: "ok" };
      yield { type: "done", stopReason: "end" };
    },
  };
}

function twoStep(first: Provider, second: Provider): Provider {
  let n = 0;
  return {
    name: "scripted",
    async *stream(req) {
      const inner = n++ === 0 ? first : second;
      for await (const event of inner.stream(req)) yield event;
    },
  };
}

describe("xml format errors", () => {
  test("unclosed arguments emit notice, not tool_call", async () => {
    const events: RuntimeEvent[] = [];
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const store = new SessionStore(workspace);
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("xml-fmt").id,
      model: "scripted-1",
      provider: twoStep(badXmlProvider(), endProvider()),
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: (ev) => events.push(ev) },
      sessionLeases: [],
      approve: async () => true,
    };
    try {
      await runTurn(deps, "go");
      expect(events.some((e) => e.type === "tool.card")).toBe(false);
      expect(events.some((e) => e.type === "notice")).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });
});
