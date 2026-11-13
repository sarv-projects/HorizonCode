/**
 * effect-reconcile-block-loop.test.ts — loop refuses mutating tools when latched (ruling **293**).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EventTypes, newId, nowIso } from "../../src/contracts";
import {
  __latchEffectReconcileBlockForTests,
  __resetEffectReconcileBlockForTests,
} from "../../src/core/effect-reconcile-block";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, streamFor, type LoopDeps } from "../../src/core/loop";
import { wrapXmlToolProvider } from "../../src/core/providers/toolconv/wrap-xml";
import { kernelStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";
import { restoreEnv, setEnv, snapshotEnv, type EnvSnapshot } from "./helpers";

let workspace: string;
let envBackup: EnvSnapshot;

beforeEach(() => {
  envBackup = snapshotEnv();
  workspace = mkdtempSync(path.join(tmpdir(), "hz-recon-loop-"));
  __resetEffectReconcileBlockForTests();
  setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "1" });
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  restoreEnv(envBackup);
  __resetEffectReconcileBlockForTests();
});

describe("reconcile block in runTurn", () => {
  test("refuses write after latch from prior turn unpaired call", async () => {
    const store = new SessionStore(workspace);
    const session = store.createSession("rb");
    const sid = session.id;
    const kernel = new KernelClient({ workspace, stateDir: kernelStateDir(workspace) });
    const stream = streamFor(sid);
    await kernel.appendEvent(stream, {
      id: newId(),
      ts: nowIso(),
      stream,
      type: EventTypes.toolCall,
      actor: { kind: "tool", id: "write" },
      payload: { id: "orphan-pre", name: "write" },
    });
    __latchEffectReconcileBlockForTests(workspace, sid);

    const writeBlock =
      `<forge_tool_call><tool_name>write</tool_name><arguments>{"path":"blocked.txt","content":"x"}</arguments></forge_tool_call>`;
    const scripted = {
      name: "scripted",
      async *stream() {
        yield { type: "text", text: writeBlock };
        yield { type: "done", stopReason: "end" };
      },
    };
    const deps: LoopDeps = {
      workspace,
      sessionId: sid,
      model: "m",
      provider: wrapXmlToolProvider(scripted),
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => {} },
      sessionLeases: [],
      approve: async () => true,
    };
    try {
      await runTurn(deps, "go");
      const toolBodies = store
        .history(sid)
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content ?? ""));
      expect(toolBodies.some((t) => t.includes("HZ_EFFECT_RECONCILE_BLOCK"))).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });
});
