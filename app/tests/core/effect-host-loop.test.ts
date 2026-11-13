/**
 * effect-host-loop.test.ts — effectId on receipts + reconcile (docs/28 ruling 181).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ReceiptInput } from "../../src/contracts";
import { EffectHost } from "../../src/core/effect-host";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { wrapXmlToolProvider } from "../../src/core/providers/toolconv/wrap-xml";
import { SessionStore } from "../../src/core/session";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-eff-loop-"));
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

describe("effect-host through runTurn", () => {
  test("receipt carries effectId and reconcile settles", async () => {
    writeFileSync(path.join(workspace, "a.txt"), "hello\n");
    const effectHost = new EffectHost();
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const reconcileCalls: unknown[] = [];
    const reconcile = kernel.reconcileEffect.bind(kernel);
    kernel.reconcileEffect = async (params) => {
      reconcileCalls.push(params);
      return reconcile(params);
    };
    const receipts: ReceiptInput[] = [];
    const issue = kernel.issueReceipt.bind(kernel);
    kernel.issueReceipt = async (input: ReceiptInput) => {
      receipts.push(input);
      return issue(input);
    };
    const store = new SessionStore(workspace);
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("eff-loop").id,
      model: "scripted-1",
      provider: twoStepProvider(xmlReadProvider(), endTurnProvider()),
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => {} },
      sessionLeases: [],
      approve: async () => true,
      effectHost,
    };
    try {
      const result = await runTurn(deps, "go");
      expect(result.exit.terminal).toBe("succeeded");
      const readReceipt = receipts.find((r) => r.action === "tool.execute" && r.tool === "read");
      expect(readReceipt?.effectId).toBeDefined();
      expect(effectHost.reconcileEffect(readReceipt!.effectId!)).toBe("settled");
      expect(reconcileCalls.length).toBeGreaterThanOrEqual(1);
      const last = reconcileCalls[reconcileCalls.length - 1] as {
        phases: string[];
        receiptId?: string;
        receiptSeq?: number;
      };
      expect(last.phases).toEqual(expect.arrayContaining(["allow", "execute", "observe"]));
      expect(last.receiptId).toBeDefined();
      expect(last.receiptSeq).toBeDefined();
    } finally {
      await kernel.close();
      store.close();
    }
  });
});
