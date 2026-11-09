/**
 * memory-init.test.ts -- /memory (alias /instructions) and /init.
 *
 * Both are factored like /rewind: pure handlers the command table calls. /init
 * is proven end to end at the loop: its prompt drives a scripted model whose
 * `write` of AGENTS.md goes through the guard and the approval callback.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Provider, ProviderEvent, ProviderRequest, Runtime } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";
import { discardStaged, stagedChanges } from "../../src/core/plan";
import { lazyInstructionsFor, loadInstructionBlocks } from "../../src/core/instructions";
import { initPrompt, runInitCommand, runMemoryCommand } from "../../src/tui/interactive";
import { createRenderer } from "../../src/tui/render";
import { strip } from "../../src/tui/style";
import { cleanupTemps, tempDir } from "../core/helpers";

afterEach(cleanupTemps);

function put(base: string, rel: string, content: string): void {
  const target = path.join(base, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function capture() {
  const chunks: string[] = [];
  const renderer = createRenderer({ wrap: false, out: (c: string) => void chunks.push(c) });
  return { renderer, plain: () => strip(chunks.join("")) };
}

function repo() {
  const root = tempDir("hz-memory-");
  mkdirSync(path.join(root, ".git"), { recursive: true });
  const home = tempDir("hz-memory-home-");
  return { root, home };
}

describe("/memory", () => {
  test("lists loaded files with kind and size, truncation, skips and unapplied rules; /instructions is an alias", () => {
    const { root, home } = repo();
    put(root, "AGENTS.md", "root rules");
    put(root, "GEMINI.md", `${"g".repeat(99)}\n`.repeat(400));
    put(root, ".cursor/rules/scoped.mdc", "---\nglobs: ['*.rs']\n---\nx");
    const outside = tempDir("hz-memory-out-");
    put(outside, "s.md", "secret");
    symlinkSync(path.join(outside, "s.md"), path.join(root, "CONVENTIONS.md"));

    for (const name of ["memory", "instructions"]) {
      const c = capture();
      expect(runMemoryCommand(name, root, c.renderer, { home })).toBe(true);
      const out = c.plain();
      expect(out).toContain("project instructions: 2 file(s)");
      expect(out).toContain("AGENTS.md  AGENTS.md");
      expect(out).toContain("GEMINI.md  GEMINI.md");
      expect(out).toContain("TRUNCATED at the 32 KB cap");
      expect(out).toContain("skipped:");
      expect(out).toContain("resolves outside");
      expect(out).toContain("not applied:");
      expect(out).toContain("scoped by globs");
      expect(out).toContain("load after a tool successfully reads or edits");
    }
  });

  test("says so when nothing is loaded, and ignores other commands", () => {
    const { root, home } = repo();
    const c = capture();
    expect(runMemoryCommand("memory", root, c.renderer, { home })).toBe(true);
    expect(c.plain()).toContain("no project instruction files found");
    expect(runMemoryCommand("rewind", root, c.renderer, { home })).toBe(false);
  });
});

describe("/init", () => {
  test("only /init yields a prompt; it demands read-only inspection and the guarded write path", () => {
    const { root } = repo();
    const prompt = initPrompt(root);
    expect(prompt).toContain("ONLY read-only tools");
    expect(prompt).toContain("write tool at AGENTS.md");
    expect(prompt).toContain("approved by the user");
    put(root, "AGENTS.md", "old");
    expect(initPrompt(root)).toContain("already exists");
    expect(initPrompt(root)).toContain("edit tool");
  });

  test("/init stages the draft in plan mode (restoring the posture); nothing lands until /apply", async () => {
    const { root } = repo();
    const asked: string[] = [];
    const requests: ProviderRequest[] = [];
    let step = 0;
    const provider: Provider = {
      name: "scripted",
      async *stream(req): AsyncIterable<ProviderEvent> {
        requests.push(req);
        step += 1;
        if (step === 1) {
          yield { type: "tool_call", id: "w1", name: "write", arguments: JSON.stringify({ path: "AGENTS.md", content: "# Drafted\n" }) };
          yield { type: "done", stopReason: "tool_use" };
          return;
        }
        yield { type: "text", text: "ok" };
        yield { type: "done", stopReason: "end" };
      },
    };
    const kernel = new KernelClient({ workspace: root });
    const store = new SessionStore(root);
    const sessionId = store.createSession("init").id;
    let planOn = false;
    const modes: boolean[] = [];
    const runtime = {
      sessionId,
      setPlanMode: (on: boolean) => {
        planOn = on;
        modes.push(on);
      },
      planMode: () => planOn,
      stagedChanges: () => stagedChanges(sessionId),
    } as unknown as Runtime;
    const deps = (): LoopDeps => ({
      workspace: root,
      sessionId,
      model: "scripted-1",
      provider,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => {} },
      sessionLeases: [],
      approve: async (req) => {
        asked.push(req.title);
        return true;
      },
      planMode: planOn,
      budget: { maxSteps: 4 },
    });
    const c = capture();
    try {
      const handled = await runInitCommand("init", root, runtime, c.renderer, async (prompt) => {
        await runTurn(deps(), prompt);
      });
      expect(handled).toBe(true);
      expect(await runInitCommand("rewind", root, runtime, c.renderer, async () => {})).toBe(false);
      // The user's turn carried the init prompt; plan mode was on for it and restored after.
      expect(requests[0]?.messages.some((m) => JSON.stringify(m).includes("ONLY read-only tools"))).toBe(true);
      expect(modes).toEqual([true, false]);
      // Nothing landed: the write is staged for review.
      expect(existsSync(path.join(root, "AGENTS.md"))).toBe(false);
      expect(stagedChanges(sessionId).map((s) => s.rel)).toEqual(["AGENTS.md"]);
      expect(c.plain()).toContain("/apply to write it");
      expect(asked).toEqual([]);
    } finally {
      discardStaged(sessionId);
      await kernel.close();
      store.close();
    }
  }, 60000);

  test("without plan mode the write still goes through the normal guarded write path (guard sees fs.write)", async () => {
    const { root } = repo();
    let step = 0;
    const provider: Provider = {
      name: "scripted",
      async *stream(): AsyncIterable<ProviderEvent> {
        step += 1;
        if (step === 1) {
          yield { type: "tool_call", id: "w1", name: "write", arguments: JSON.stringify({ path: "AGENTS.md", content: "# Drafted\n" }) };
          yield { type: "done", stopReason: "tool_use" };
          return;
        }
        yield { type: "done", stopReason: "end" };
      },
    };
    const kernel = new KernelClient({ workspace: root });
    const store = new SessionStore(root);
    const kinds: string[] = [];
    const original = kernel.checkGuard.bind(kernel);
    kernel.checkGuard = async (action, scope, leases, sid) => {
      kinds.push(`${action.kind}:${action.target}`);
      return original(action, scope, leases, sid);
    };
    const c = capture();
    try {
      await runInitCommand("init", root, {} as Runtime, c.renderer, async (prompt) => {
        await runTurn(
          {
            workspace: root,
            sessionId: store.createSession("init2").id,
            model: "scripted-1",
            provider,
            kernel,
            store,
            signal: new AbortController().signal,
            callbacks: { onEvent: () => {} },
            sessionLeases: [],
            approve: async () => false,
            budget: { maxSteps: 4 },
          },
          prompt,
        );
      });
      expect(c.plain()).toContain("no plan mode");
      expect(kinds.some((k) => k.startsWith("fs.write") && k.includes("AGENTS.md"))).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  }, 60000);
});

describe("/memory lazy listing", () => {
  test("lists nested instructions loaded this session", () => {
    const { root, home } = repo();
    put(root, "AGENTS.md", "root rules");
    put(root, "sub/AGENTS.md", "sub rules");
    const eager = loadInstructionBlocks(root, { home }).blocks;
    lazyInstructionsFor(root, "sess-mem", eager).discover("sub/x.ts");
    const c = capture();
    runMemoryCommand("memory", root, c.renderer, { home, sessionId: "sess-mem" });
    const out = c.plain();
    expect(out).toContain("nested instructions loaded this session: 1");
    expect(out).toContain("sub/AGENTS.md");
    const d = capture();
    runMemoryCommand("memory", root, d.renderer, { home, sessionId: "other" });
    expect(d.plain()).not.toContain("loaded this session");
  });
});
