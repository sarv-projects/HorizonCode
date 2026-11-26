import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("EffectHost refuses unrouted shape-eligible ast_edit without ambient rewrite", async () => {
  const env = snapshotEnv();
  try {
    const fixtures = [
      { file: "unique.ts", body: "foo(a);\n", pat: "foo($A)", out: "bar($A)" },
      { file: "multi.ts", body: "foo(a);\nfoo(b);\n", pat: "foo($A)", out: "bar($A)" },
    ];
    for (const mode of ["default", "1"] as const) {
      for (const fixture of fixtures) {
        setEnv({ HZ_EFFECT_HOST_KERNEL: mode, HZ_EFFECT_HOST_NO_AMBIENT_FALLBACK: undefined });
        const workspace = mkdtempSync(path.join(tmpdir(), "hz-ast-unrouted-"));
        workspaces.push(workspace);
        const target = path.join(workspace, fixture.file);
        writeFileSync(target, fixture.body, "utf8");
        const store = new SessionStore(workspace);
        const kernel = new KernelClient({
          workspace,
          stateDir: path.join(workspace, ".hzcode", "kernel"),
          pinEnv: { HZ_KERNEL_BIN: path.join(workspace, "missing-kernel"), HZ_KERNEL_PIN: "require" },
        });
        const deps: LoopDeps = {
          workspace,
          sessionId: store.createSession("ast-unrouted").id,
          model: "scripted-1",
          provider: sequenceProvider(
            toolProvider("read", { path: fixture.file }),
            toolProvider("ast_edit", { path: fixture.file, pat: fixture.pat, out: fixture.out }),
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
          await runTurn(deps, "edit structurally without ambient fallback");
          expect(readFileSync(target, "utf8")).toBe(fixture.body);
        } finally {
          await kernel.close();
          store.close();
        }
      }
    }
  } finally {
    restoreEnv(env);
  }
}, 15_000);
