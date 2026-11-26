import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { wrapXmlToolProvider } from "../../src/core/providers/toolconv/wrap-xml";
import { SessionStore } from "../../src/core/session";
import { restoreEnv, setEnv, snapshotEnv } from "./helpers";

const workspaces: string[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function toolProvider(name: string, args: Record<string, unknown>): Provider {
  const inner: Provider = {
    name: "scripted",
    async *stream() {
      const call = "<forge_tool_call><tool_name>" + name + "</tool_name><arguments>" + JSON.stringify(args) + "</arguments></forge_tool_call>";
      yield { type: "text", text: call };
      yield { type: "done", stopReason: "end" };
    },
  };
  return wrapXmlToolProvider(inner);
}

function sequenceProvider(...providers: Provider[]): Provider {
  let index = 0;
  return {
    name: "scripted",
    async *stream(req) {
      const provider = providers[Math.min(index++, providers.length - 1)]!;
      for await (const event of provider.stream(req)) yield event;
    },
  };
}

test("EffectHost refuses invalid-UTF8 ast_edit projection misses without ambient rewrite", async () => {
  const env = snapshotEnv();
  try {
    for (const mode of ["default", "1"] as const) {
      console.log("DEBUG mode", mode);
      setEnv({ HZ_EFFECT_HOST_KERNEL: mode, HZ_EFFECT_HOST_NO_AMBIENT_FALLBACK: undefined });
      const workspace = mkdtempSync(path.join(tmpdir(), "hz-ast-invalid-utf8-"));
      workspaces.push(workspace);
      const target = path.join(workspace, "bad.ts");
      const original = Buffer.concat([Buffer.from([0xff]), Buffer.from("foo(a);\n", "utf8")]);
      writeFileSync(target, original);

      const store = new SessionStore(workspace);
      const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel"), pinEnv: { HZ_KERNEL_BIN: path.join(workspace, "missing-kernel"), HZ_KERNEL_PIN: "require" } });
      const deps: LoopDeps = {
        workspace,
        sessionId: store.createSession("ast-invalid-utf8").id,
        model: "scripted-1",
        provider: sequenceProvider(
          toolProvider("read", { path: "bad.ts" }),
          toolProvider("ast_edit", { path: "bad.ts", pat: "foo($A)", out: "bar($A)" }),
          { name: "scripted", async *stream() { yield { type: "text", text: "done" }; yield { type: "done", stopReason: "end" }; } },
        ),
        kernel,
        store,
        signal: new AbortController().signal,
        callbacks: { onEvent: () => {} },
        sessionLeases: [],
        approve: async () => true,
      };
      try {
        console.log("DEBUG before runTurn");
        await runTurn(deps, "edit invalid encoding safely");
        console.log("DEBUG after runTurn");
        expect(readFileSync(target)).toEqual(original);
      } finally {
        console.log("DEBUG before close");
        await kernel.close();
        store.close();
        console.log("DEBUG after close");
      }
    }
  } finally {
    restoreEnv(env);
  }
}, { timeout: 30_000 });
test("NO_AMBIENT_FALLBACK refuses an unrouted mutation under default mode", async () => {
  const env = snapshotEnv();
  setEnv({ HZ_EFFECT_HOST_KERNEL: "default", HZ_EFFECT_HOST_NO_AMBIENT_FALLBACK: "1" });
  const workspace = mkdtempSync(path.join(tmpdir(), "hz-no-ambient-fallback-"));
  workspaces.push(workspace);
  const store = new SessionStore(workspace);
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel"), pinEnv: { HZ_KERNEL_BIN: path.join(workspace, "missing-kernel"), HZ_KERNEL_PIN: "require" } });
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("no-ambient-fallback").id,
    model: "scripted-1",
    provider: sequenceProvider(
      toolProvider("write", { path: "blocked.txt", content: "must not be ambiently written\n" }),
      { name: "scripted", async *stream() { yield { type: "text", text: "done" }; yield { type: "done", stopReason: "end" }; } },
    ),
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: () => {} },
    sessionLeases: [],
    approve: async () => true,
  };
  try {
    await runTurn(deps, "do not allow ambient fallback");
    expect(existsSync(path.join(workspace, "blocked.txt"))).toBe(false);
  } finally {
    await kernel.close();
    store.close();
    restoreEnv(env);
  }
}, { timeout: 30_000 });
