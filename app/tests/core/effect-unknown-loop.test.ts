/**
 * effect-unknown-loop.test.ts — `effect.unknown` facade event when reconcile is unknown (ruling 235).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { RuntimeEvent } from "../../src/contracts";
import { EffectHost } from "../../src/core/effect-host";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { wrapXmlToolProvider } from "../../src/core/providers/toolconv/wrap-xml";
import { SessionStore } from "../../src/core/session";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-unk-loop-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("effect.unknown runtime event", () => {
  test("emitted when EffectHost reconcile returns unknown", async () => {
    writeFileSync(path.join(workspace, "a.txt"), "hello\n");
    const effectHost = new EffectHost();
    const orig = effectHost.reconcileEffect.bind(effectHost);
    effectHost.reconcileEffect = (id: string) => {
      orig(id);
      return "unknown";
    };

    const block =
      `<forge_tool_call><tool_name>read</tool_name><arguments>{"path":"a.txt"}</arguments></forge_tool_call>`;
    const provider = wrapXmlToolProvider({
      name: "scripted",
      async *stream() {
        yield { type: "text", text: block };
        yield { type: "done", stopReason: "end" };
      },
    });

    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const store = new SessionStore(workspace);
    const events: RuntimeEvent[] = [];
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("unk").id,
      model: "scripted-1",
      provider,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: (ev) => events.push(ev) },
      sessionLeases: [],
      approve: async () => true,
      effectHost,
    };
    try {
      await runTurn(deps, "go");
      const unk = events.filter((e) => e.type === "effect.unknown");
      expect(unk.length).toBeGreaterThanOrEqual(1);
      expect(unk[0]?.tool).toBe("read");
    } finally {
      await kernel.close();
      store.close();
    }
  });
});
