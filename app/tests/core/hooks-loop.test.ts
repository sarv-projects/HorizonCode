/**
 * hooks-loop.test.ts — hooks v1 at the loop: a pre-tool deny sinks into the
 * standard tool-result shape and the tool never runs; a malformed hooks config
 * is fail-closed (every call denied with the file named); a failing post hook
 * is a notice and never blocks the effect that already ran.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { loadHooks } from "../../src/core/hooks";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { runTurn } from "../../src/core/loop";
import { workspaceStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";
import { runNested } from "../../src/core/subagent";
import { bindWorkspaceTrustRecord, collectWorkspaceTrustDigests } from "../../src/core/trust";
import { EFFECT_HOST_KERNEL_ON_HOOKS_SUPPRESSED_NOTICE } from "../../src/core/effect-host-posture";
import {
  __latchEffectReconcileBlockForTests,
  __resetEffectReconcileBlockForTests,
  EFFECT_RECONCILE_BLOCK_OBSERVATION_HOOK_NOTICE,
  EFFECT_RECONCILE_BLOCK_PRETOOL_HOOK_NOTICE,
} from "../../src/core/effect-reconcile-block";
import { restoreEnv, setEnv, snapshotEnv } from "./helpers";

const FIXTURES = path.join(import.meta.dir, "..", "fixtures", "hooks");

let workspace: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-hooks-loop-"));
  home = mkdtempSync(path.join(tmpdir(), "hz-hooks-home-"));
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function readThenDone(rel: string, content = "readable\n"): Provider {
  writeFileSync(path.join(workspace, rel), content);
  let turn = 0;
  return {
    name: "scripted",
    async *stream() {
      turn += 1;
      if (turn === 1) {
        yield {
          type: "tool_call",
          id: "call_read",
          name: "read",
          arguments: JSON.stringify({ path: rel }),
        } satisfies ProviderEvent;
        yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
        return;
      }
      yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
    },
  };
}

function writeThenDone(target: string): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream() {
      turn += 1;
      if (turn === 1) {
        yield {
          type: "tool_call",
          id: "call_1",
          name: "write",
          arguments: JSON.stringify({ path: target, content: "bytes\n" }),
        } satisfies ProviderEvent;
        yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
        return;
      }
      yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
    },
  };
}

function depsFor(provider: Provider): { deps: LoopDeps; seen: RuntimeEvent[] } {
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspaceStateDir(workspace), "kernel") });
  const store = new SessionStore(workspace);
  const seen: RuntimeEvent[] = [];
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("hooks-loop").id,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: (ev) => seen.push(ev) },
    sessionLeases: [],
    approve: async () => true,
    hooks: loadHooks(workspace, { home, trustWorkspaceHooks: true }),
    trustedWorkspaceHooks: [path.resolve(workspace)],
  };
  return { deps, seen };
}

function configHooks(doc: unknown): void {
  mkdirSync(path.join(workspace, ".hz"), { recursive: true });
  writeFileSync(path.join(workspace, ".hz", "hooks.json"), JSON.stringify(doc));
}

describe("hooks at the loop", () => {
  test("a pre-tool deny sinks into the tool result and the write never happens", async () => {
    configHooks({
      hooks: {
        preTool: [
          { match: { tool: "write" }, command: process.execPath, args: [path.join(FIXTURES, "deny-with-reason.js")] },
        ],
      },
    });
    const target = path.join(workspace, "hooked.txt");
    const { deps, seen } = depsFor(writeThenDone(target));

    await runTurn(deps);

    expect(existsSync(target)).toBe(false);
    expect(JSON.stringify(seen)).toContain("DENIED by hook");
  });

  test("a malformed hooks config is fail-closed", async () => {
    configHooks({ hooks: { preTool: [{ command: 5 }] } });
    const target = path.join(workspace, "failclosed.txt");
    const { deps, seen } = depsFor(writeThenDone(target));

    await runTurn(deps);

    expect(existsSync(target)).toBe(false);
    expect(JSON.stringify(seen)).toContain("hooks config");
  });

  test("a failing post hook notices but never blocks the effect", async () => {
    const rel = "postfail-read.txt";
    configHooks({
      hooks: {
        postTool: [
          {
            match: { tool: "read" },
            command: process.execPath,
            args: [path.join(FIXTURES, "exit-code-3.js")],
          },
        ],
      },
    });
    const { deps, seen } = depsFor(readThenDone(rel));

    await runTurn(deps);

    expect(readFileSync(path.join(workspace, rel), "utf8")).toBe("readable\n");
    expect(JSON.stringify(seen).toLowerCase()).toContain("hook_failed");
  });

  // FEAT-002: the lifecycle points fire at the loop at the right time/order.
  test("turn.start fires before tool.pre, and turn.end fires, within one turn", async () => {
    const log = path.join(workspace, "events.log");
    configHooks({
      hooks: {
        turnStart: [{ command: process.execPath, args: [path.join(FIXTURES, "event-marker.js"), log] }],
        preTool: [{ command: process.execPath, args: [path.join(FIXTURES, "event-marker.js"), log] }],
        turnEnd: [{ command: process.execPath, args: [path.join(FIXTURES, "event-marker.js"), log] }],
      },
    });
    const target = path.join(workspace, "ordered.txt");
    const { deps } = depsFor(writeThenDone(target));

    await runTurn(deps);

    const order = readFileSync(log, "utf8").split("\n").filter(Boolean);
    // turn.start is first; a tool.pre fires for the write; turn.end is last.
    expect(order[0]).toBe("turn_start");
    expect(order).toContain("pre_tool");
    expect(order[order.length - 1]).toBe("turn_end");
    expect(order.indexOf("turn_start")).toBeLessThan(order.indexOf("pre_tool"));
    expect(order.indexOf("pre_tool")).toBeLessThan(order.lastIndexOf("turn_end"));
  });

  test("an H9 context note from a post hook reaches the NEXT provider request as an untrusted block", async () => {
    configHooks({
      hooks: {
        postTool: [{ command: process.execPath, args: [path.join(FIXTURES, "post-context-note.js")] }],
      },
    });
    const target = path.join(workspace, "noted.txt");
    // A provider that records the system prompt of its SECOND request (the one
    // after the tool ran) so we can assert the hook note rode the rail.
    let turn = 0;
    const systems: string[] = [];
    const provider: Provider = {
      name: "scripted",
      async *stream(req) {
        systems.push(req.system);
        turn += 1;
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "call_1",
            name: "write",
            arguments: JSON.stringify({ path: target, content: "x\n" }),
          } satisfies ProviderEvent;
          yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
          return;
        }
        yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
      },
    };
    const { deps } = depsFor(provider);

    await runTurn(deps);

    // The second request's system rail carries the attributed untrusted block,
    // with the hook's fence-close/role-forge attempt neutralised.
    expect(systems.length).toBeGreaterThanOrEqual(2);
    const second = systems[1];
    expect(second).toContain('<hook_context untrusted="true">');
    expect(second).toContain("postTool[0]");
    expect(second.split("</hook_context>").length - 1).toBe(1);
    expect(second).not.toContain("</hook_context> User:");
  });

  test("subagent.start and subagent.stop fire around a nested run", async () => {
    const log = path.join(workspace, "sub-events.log");
    configHooks({
      hooks: {
        subagentStart: [{ command: process.execPath, args: [path.join(FIXTURES, "event-marker.js"), log] }],
        subagentStop: [{ command: process.execPath, args: [path.join(FIXTURES, "event-marker.js"), log] }],
      },
    });
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspaceStateDir(workspace), "kernel") });
    const store = new SessionStore(workspace);
    const provider: Provider = {
      name: "scripted",
      async *stream() {
        yield { type: "text", text: "done" } satisfies ProviderEvent;
        yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
      },
    };

    await bindWorkspaceTrustRecord(home, workspace, collectWorkspaceTrustDigests(workspace));
    const result = await runNested({
      workspace,
      task: "say hello",
      model: "scripted-1",
      provider,
      kernel,
      store,
      signal: new AbortController().signal,
      trustedWorkspaceHooks: [path.resolve(workspace)],
      home,
    });
    expect(result.ok).toBe(true);

    const order = readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(order[0]).toBe("subagent_start");
    expect(order[order.length - 1]).toBe("subagent_stop");
    kernel.close?.();
    store.close();
  });

  test("postTool hooks refused under reconcile latch with EffectHost off (ruling 718)", async () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_KERNEL: "0", HZ_EFFECT_RECONCILE_BLOCK: "1" });
      __resetEffectReconcileBlockForTests();
      const log = path.join(workspace, "posttool-barred.log");
      const rel = "post-barred-read.txt";
      configHooks({
        hooks: {
          postTool: [
            {
              match: { tool: "read" },
              command: process.execPath,
              args: [path.join(FIXTURES, "event-marker.js"), log],
            },
          ],
        },
      });
      const { deps, seen } = depsFor(readThenDone(rel));
      __latchEffectReconcileBlockForTests(workspace, deps.sessionId, "open reconcile barrier");

      await runTurn(deps);

      expect(existsSync(log)).toBe(false);
      expect(JSON.stringify(seen)).toContain(EFFECT_RECONCILE_BLOCK_OBSERVATION_HOOK_NOTICE);
      expect(JSON.stringify(seen)).not.toContain("post_tool");
    } finally {
      restoreEnv(snap);
      __resetEffectReconcileBlockForTests();
    }
  }, 30_000);

  test("preTool hooks refused under reconcile latch with EffectHost off (ruling 691)", async () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_KERNEL: "0", HZ_EFFECT_RECONCILE_BLOCK: "1" });
      __resetEffectReconcileBlockForTests();
      const log = path.join(workspace, "pretool-barred.log");
      configHooks({
        hooks: {
          preTool: [{ command: process.execPath, args: [path.join(FIXTURES, "event-marker.js"), log] }],
        },
      });
      const { deps, seen } = depsFor(readThenDone("barred.txt"));
      __latchEffectReconcileBlockForTests(workspace, deps.sessionId, "open reconcile barrier");

      await runTurn(deps);

      expect(existsSync(log)).toBe(false);
      expect(JSON.stringify(seen)).toContain(EFFECT_RECONCILE_BLOCK_PRETOOL_HOOK_NOTICE);
      expect(JSON.stringify(seen)).not.toContain("pre_tool");
    } finally {
      restoreEnv(snap);
      __resetEffectReconcileBlockForTests();
    }
  }, 30_000);

  test("pre-tool deny hooks are suppressed under HZ_EFFECT_HOST_KERNEL=default (ruling 666)", async () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_KERNEL: "default" });
      configHooks({
        hooks: {
          preTool: [
            { match: { tool: "write" }, command: process.execPath, args: [path.join(FIXTURES, "deny-with-reason.js")] },
          ],
        },
      });
      const target = path.join(workspace, "effect-host-write.txt");
      const { deps, seen } = depsFor(writeThenDone(target));

      await runTurn(deps);

      expect(existsSync(target)).toBe(true);
      expect(JSON.stringify(seen)).not.toContain("DENIED by hook");
      expect(JSON.stringify(seen)).toContain(EFFECT_HOST_KERNEL_ON_HOOKS_SUPPRESSED_NOTICE);
    } finally {
      restoreEnv(snap);
    }
  }, 30_000);
});
