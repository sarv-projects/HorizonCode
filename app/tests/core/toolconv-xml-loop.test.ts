/**
 * toolconv-xml-loop.test.ts — xml toolconv wired through runTurn (docs/33 §5.14 partial).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { canonicalJson, sha256Hex, type Provider, type ReceiptInput, type RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { wrapXmlToolProvider } from "../../src/core/providers/toolconv/wrap-xml";
import { SessionStore } from "../../src/core/session";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-xml-loop-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function xmlReadProvider(): Provider {
  const block =
    `<forge_tool_call><tool_name>read</tool_name><arguments>{"path":"a.txt"}</arguments></forge_tool_call>`;
  const inner: Provider = {
    name: "scripted",
    async *stream() {
      yield { type: "text", text: block };
      yield { type: "done", stopReason: "end" };
    },
  };
  return wrapXmlToolProvider(inner);
}

function endTurnProvider(): Provider {
  return {
    name: "scripted",
    async *stream() {
      yield { type: "text", text: "done" };
      yield { type: "done", stopReason: "end" };
    },
  };
}

function twoStepProvider(first: Provider, second: Provider): Provider {
  let n = 0;
  return {
    name: "scripted",
    async *stream(req) {
      const inner = n++ === 0 ? first : second;
      for await (const event of inner.stream(req)) yield event;
    },
  };
}

describe("xml toolconv through runTurn", () => {
  test("parsed read call runs and receipt hashes admitted args", async () => {
    writeFileSync(path.join(workspace, "a.txt"), "hello\n");
    const events: RuntimeEvent[] = [];
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const receipts: ReceiptInput[] = [];
    const issue = kernel.issueReceipt.bind(kernel);
    kernel.issueReceipt = async (input: ReceiptInput) => {
      receipts.push(input);
      return issue(input);
    };
    const store = new SessionStore(workspace);
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("xml-loop").id,
      model: "scripted-1",
      provider: twoStepProvider(xmlReadProvider(), endTurnProvider()),
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: (ev) => events.push(ev) },
      sessionLeases: [],
      approve: async () => true,
    };
    try {
      const result = await runTurn(deps, "go");
      expect(result.exit.terminal).toBe("succeeded");
      const cards = events.filter((e): e is Extract<RuntimeEvent, { type: "tool.card" }> => e.type === "tool.card");
      expect(cards.some((c) => c.name === "read" && c.status === "ok")).toBe(true);
      const readReceipt = receipts.find((r) => r.action === "tool.execute" && r.tool === "read");
      expect(readReceipt?.argsDigest).toBe(sha256Hex(canonicalJson({ path: "a.txt" })));
    } finally {
      await kernel.close();
      store.close();
    }
  });
});
