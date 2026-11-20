/**
 * Ruling 649 — under HZ_EFFECT_HOST_KERNEL=require, ambient tools are refused
 * before pre-tool hooks so a hook cannot side-effect a path that will never
 * kernel-route.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent } from "../../src/contracts";
import { loadHooks } from "../../src/core/hooks";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { runTurn } from "../../src/core/loop";
import { workspaceStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";
import { restoreEnv, setEnv, snapshotEnv, type EnvSnapshot } from "./helpers";

let workspace = "";
let home = "";
let envSnap: EnvSnapshot;

beforeEach(() => {
  envSnap = snapshotEnv();
  workspace = mkdtempSync(path.join(tmpdir(), "hz-req-pre-"));
  home = mkdtempSync(path.join(tmpdir(), "hz-req-pre-home-"));
  setEnv({
    HOME: home,
    HZ_EFFECT_HOST_KERNEL: "require",
    HZ_TODO_DURABLE: undefined,
  });
});

afterEach(() => {
  restoreEnv(envSnap);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("effect-host require preflight (ruling 649)", () => {
  test("ambient code_mode is refused before pre-tool hooks run", async () => {
    const marker = path.join(workspace, "hook-ran.txt");
    const hooksDir = path.join(workspace, ".hzcode");
    mkdirSync(hooksDir, { recursive: true });
    const hookScript = path.join(hooksDir, "pre-code-mode.sh");
    writeFileSync(
      hookScript,
      `#!/bin/sh\necho ran > "${marker}"\necho '{"decision":"allow"}'\n`,
      { mode: 0o755 },
    );
    chmodSync(hookScript, 0o755);
    writeFileSync(
      path.join(hooksDir, "hooks.json"),
      JSON.stringify({
        hooks: [{ event: "tool.pre", matcher: "code_mode", command: hookScript }],
      }),
    );

    let phase = 0;
    const provider: Provider = {
      name: "scripted",
      async *stream(): AsyncGenerator<ProviderEvent> {
        phase += 1;
        if (phase === 1) {
          yield {
            type: "tool_call",
            id: "call_cm",
            name: "code_mode",
            arguments: JSON.stringify({ code: "return 1;" }),
          } satisfies ProviderEvent;
          yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
          return;
        }
        yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
      },
    };

    const stateDir = path.join(workspaceStateDir(workspace), "kernel");
    mkdirSync(stateDir, { recursive: true });
    const kernel = new KernelClient({ workspace, stateDir });
    const store = new SessionStore(workspace);
    let toolOutput = "";
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("req-preflight").id,
      model: "scripted-1",
      provider,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: {
        onEvent: (ev) => {
          if (ev.type !== "tool.card") return;
          const card = ev as {
            summary?: string;
            detail?: { output?: string; error?: string };
          };
          if (typeof card.summary === "string") toolOutput += card.summary;
          if (typeof card.detail?.output === "string") toolOutput += `\n${card.detail.output}`;
          if (typeof card.detail?.error === "string") toolOutput += `\n${card.detail.error}`;
        },
      },
      sessionLeases: [],
      approve: async () => true,
      hooks: loadHooks(workspace, { home, trustWorkspaceHooks: true }),
      trustedWorkspaceHooks: [path.resolve(workspace)],
    };

    try {
      await runTurn(deps);
    } finally {
      await kernel.close().catch(() => undefined);
      store.close();
    }

    // Hook must not have run (preflight precedes tool.pre).
    expect(existsSync(marker)).toBe(false);
    expect(toolOutput).toContain("HZ_EFFECT_HOST_KERNEL=require");
  }, 30_000);
});
