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

test("EffectHost refuses write and edit when the Rust kernel is not trusted", async () => {
  const env = snapshotEnv();
  try {
    for (const mode of ["default", "1"] as const) {
      setEnv({ HZ_EFFECT_HOST_KERNEL: mode, HZ_EFFECT_HOST_NO_AMBIENT_FALLBACK: undefined });
      const workspace = mkdtempSync(path.join(tmpdir(), "hz-untrusted-fs-"));
      workspaces.push(workspace);
      const existing = path.join(workspace, "note.txt");
      writeFileSync(existing, "alpha\n", "utf8");
      const store = new SessionStore(workspace);
      const kernel = new KernelClient({
        workspace,
        stateDir: path.join(workspace, ".hzcode", "kernel"),
        pinEnv: { HZ_KERNEL_BIN: path.join(workspace, "missing-kernel"), HZ_KERNEL_PIN: "require" },
      });
      const deps: LoopDeps = {
        workspace,
        sessionId: store.createSession("untrusted-fs").id,
        model: "scripted-1",
        provider: sequenceProvider(
          toolProvider("write", { path: "created.txt", content: "must-not-land\n" }),
          toolProvider("read", { path: "note.txt" }),
          toolProvider("edit", { path: "note.txt", old: "alpha\n", new: "beta\n" }),
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
        await runTurn(deps, "mutate without a trusted kernel");
        expect(existsSync(path.join(workspace, "created.txt"))).toBe(false);
        expect(readFileSync(existing, "utf8")).toBe("alpha\n");
      } finally {
        await kernel.close();
        store.close();
      }
    }
  } finally {
    restoreEnv(env);
  }
}, { timeout: 30_000 });
