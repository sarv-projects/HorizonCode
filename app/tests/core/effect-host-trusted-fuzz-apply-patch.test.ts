import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider } from "../../src/contracts";
import { effectHostDoctorPosture } from "../../src/core/effect-host-posture";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { wrapXmlToolProvider } from "../../src/core/providers/toolconv/wrap-xml";
import { SessionStore } from "../../src/core/session";
import { restoreEnv, rustKernelPath, setEnv, snapshotEnv } from "./helpers";

const original = "alfa betz\nalfa beta\nalfa beta\n";
const patch = `*** Begin Patch
*** Update File: note.txt
@@
-alpha beta
+alpha beta fixed
*** End Patch`;

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

test("trusted kernel does not let mixed-score apply_patch fall through to Bun", async () => {
  const env = snapshotEnv();
  const workspace = mkdtempSync(path.join(tmpdir(), "hz-trusted-fuzz-"));
  workspaces.push(workspace);
  const file = path.join(workspace, "note.txt");
  writeFileSync(file, original);
  setEnv({
    HZ_EFFECT_HOST_KERNEL: "default",
    HZ_EFFECT_HOST_EDIT_REPAIR: undefined,
    HZ_EFFECT_HOST_NO_AMBIENT_FALLBACK: undefined,
  });
  const store = new SessionStore(workspace);
  const kernel = new KernelClient({
    workspace,
    stateDir: path.join(workspace, ".hz", "state", "kernel"),
    pinEnv: { HZ_KERNEL_BIN: rustKernelPath },
  });
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("trusted-fuzz").id,
    model: "scripted-1",
    provider: {
      name: "scripted",
      async *stream(req) {
        const provider = req.messages.some((message) => message.role === "tool")
          ? { name: "scripted", async *stream() { yield { type: "text" as const, text: "done" }; yield { type: "done" as const, stopReason: "end" as const }; } }
          : toolProvider("apply_patch", { input: patch });
        for await (const event of provider.stream(req)) yield event;
      },
    },
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: () => {} },
    sessionLeases: [],
    approve: async () => true,
  };
  try {
    expect(await kernel.start()).toBe("trusted");
    await runTurn(deps, "apply the fuzzy patch");
    expect(readFileSync(file, "utf8")).toBe(original);
    for (const mode of ["default", "1"]) {
      const detail = effectHostDoctorPosture({ HZ_EFFECT_HOST_KERNEL: mode }).detail;
      expect(detail).toContain("mixed-score apply_patch does not Bun-apply (**966**)");
      expect(detail).not.toContain("fuzz still falls back to Bun");
      expect(detail).not.toContain("fuzz may still Bun-fallback");
    }
  } finally {
    await kernel.close();
    store.close();
    restoreEnv(env);
  }
}, { timeout: 30_000 });
