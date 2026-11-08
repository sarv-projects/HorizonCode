/**
 * completion-evidence.test.ts — the cheap half of harness-engineering lecture 09
 * ("done" must be an objective determination, not the model's own claim).
 *
 * A run that changes files and runs nothing verification-shaped still exits
 * `succeeded` — it is not blocked — but the human gets a notice and the audit
 * trail gets a `run.unverified_completion` event. That is what makes a later
 * "it said it worked" auditable after the fact.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { UNVERIFIED_COMPLETION_EVENT, exitCodeFor, runTurn } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-evidence-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** A provider that plays one scripted turn per call. */
function scriptedProvider(turns: ProviderEvent[][]): Provider {
  let index = 0;
  return {
    name: "scripted",
    async *stream() {
      const events = turns[Math.min(index, turns.length - 1)] ?? [];
      index += 1;
      for (const event of events) yield event;
    },
  };
}

/** One model turn: the given tool calls, then stopReason tool_use. */
function calls(...specs: Array<{ name: string; args: Record<string, unknown> }>): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  specs.forEach((spec, i) => {
    events.push({ type: "tool_call", id: `call_${i + 1}`, name: spec.name, arguments: JSON.stringify(spec.args) });
  });
  events.push({ type: "done", stopReason: "tool_use" });
  return events;
}

const DONE: ProviderEvent[] = [{ type: "done", stopReason: "end" }];

function depsFor(provider: Provider): {
  deps: LoopDeps;
  kernel: KernelClient;
  store: SessionStore;
  seen: RuntimeEvent[];
} {
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
  const store = new SessionStore(workspace);
  const seen: RuntimeEvent[] = [];
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("evidence").id,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: (ev) => seen.push(ev) },
    sessionLeases: [],
    approve: async () => true,
  };
  return { deps, kernel, store, seen };
}

function unverifiedNotices(seen: RuntimeEvent[]): string[] {
  return seen
    .filter((ev): ev is { type: "notice"; message: string } => ev.type === "notice")
    .map((ev) => ev.message)
    .filter((message) => message.startsWith("unverified completion"));
}

async function loggedUnverified(kernel: KernelClient, sessionId: string): Promise<number> {
  const events = await kernel.readEvents(`session:${sessionId}`);
  return events.filter((event) => event.type === UNVERIFIED_COMPLETION_EVENT).length;
}

describe("completion evidence (lecture 09, cheap half)", () => {
  test("a run that writes a file and verifies nothing is reported, not silently accepted", async () => {
    const provider = scriptedProvider([calls({ name: "write", args: { path: "new.txt", content: "hi\n" } }), DONE]);
    const { deps, kernel, store, seen } = depsFor(provider);
    try {
      const result = await runTurn(deps, "write a file");
      expect(result.exit.terminal).toBe("succeeded"); // reported, not blocked

      const notices = unverifiedNotices(seen);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("changed 1 file(s)");
      expect(notices[0]).toContain("new.txt");

      expect(await loggedUnverified(kernel, deps.sessionId)).toBe(1);
      const events = await kernel.readEvents(`session:${deps.sessionId}`);
      const marked = events.find((event) => event.type === UNVERIFIED_COMPLETION_EVENT);
      expect((marked?.payload as { files: string[] }).files).toEqual(["new.txt"]);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("a verification-shaped command silences it (a failing check is still a check)", async () => {
    const provider = scriptedProvider([
      calls(
        { name: "write", args: { path: "new.txt", content: "hi\n" } },
        { name: "shell", args: { command: "make --version" } },
      ),
      DONE,
    ]);
    const { deps, kernel, store, seen } = depsFor(provider);
    try {
      const result = await runTurn(deps, "write and check");
      expect(result.exit.terminal).toBe("succeeded");
      expect(unverifiedNotices(seen)).toHaveLength(0);
      expect(await loggedUnverified(kernel, deps.sessionId)).toBe(0);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("a read-only run is not flagged: nothing changed, nothing to check", async () => {
    const provider = scriptedProvider([calls({ name: "read", args: { path: "missing.txt" } }), DONE]);
    const { deps, kernel, store, seen } = depsFor(provider);
    try {
      await runTurn(deps, "look around");
      expect(unverifiedNotices(seen)).toHaveLength(0);
      expect(await loggedUnverified(kernel, deps.sessionId)).toBe(0);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("a failed run is not flagged: the signal is about false success, not failure", async () => {
    const provider = scriptedProvider([
      calls({ name: "write", args: { path: "new.txt", content: "hi\n" } }),
      [{ type: "error", message: "provider exploded" }],
    ]);
    const { deps, kernel, store, seen } = depsFor(provider);
    try {
      const result = await runTurn(deps, "write then fail");
      expect(result.exit.terminal).toBe("failed");
      expect(unverifiedNotices(seen)).toHaveLength(0);
    } finally {
      await kernel.close();
      store.close();
    }
  });
});

describe("completion gate (blocking half)", () => {
  test("marking declared work complete with no check ends UNKNOWN (exit 3), never success", async () => {
    const provider = scriptedProvider([
      calls(
        { name: "write", args: { path: "done.txt", content: "hi\n" } },
        { name: "todo", args: { action: "add", text: "finish the change" } },
        { name: "todo", args: { action: "done", text: "t1" } },
      ),
      DONE,
    ]);
    const { deps, kernel, store, seen } = depsFor(provider);
    try {
      const result = await runTurn(deps, "finish the change");
      expect(result.exit.terminal).toBe("unknown");
      expect(result.exit.detail).toBe("unverified_completion");
      expect(exitCodeFor(result.exit)).toBe(3);

      const notices = unverifiedNotices(seen);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("recorded unknown (exit 3), not success");

      const events = await kernel.readEvents(`session:${deps.sessionId}`);
      const marked = events.find((event) => event.type === UNVERIFIED_COMPLETION_EVENT);
      const payload = marked?.payload as { files: string[]; claimed: boolean };
      expect(payload.files).toEqual(["done.txt"]);
      expect(payload.claimed).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("the same run with a check passes the gate", async () => {
    const provider = scriptedProvider([
      calls(
        { name: "write", args: { path: "done.txt", content: "hi\n" } },
        { name: "todo", args: { action: "add", text: "finish the change" } },
        { name: "todo", args: { action: "done", text: "t1" } },
        { name: "shell", args: { command: "bun test" } },
      ),
      DONE,
    ]);
    const { deps, kernel, store, seen } = depsFor(provider);
    try {
      const result = await runTurn(deps, "finish the change");
      expect(result.exit.terminal).toBe("succeeded");
      expect(unverifiedNotices(seen)).toHaveLength(0);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("a plan left open is noticed, not blocked", async () => {
    const provider = scriptedProvider([
      calls(
        { name: "write", args: { path: "wip.txt", content: "x\n" } },
        { name: "todo", args: { action: "add", text: "one" } },
        { name: "todo", args: { action: "add", text: "two" } },
        { name: "todo", args: { action: "done", text: "t1" } },
      ),
      DONE,
    ]);
    const { deps, kernel, store, seen } = depsFor(provider);
    try {
      const result = await runTurn(deps, "start the work");
      expect(result.exit.terminal).toBe("succeeded");
      const openNotices = seen
        .filter((ev): ev is { type: "notice"; message: string } => ev.type === "notice")
        .map((ev) => ev.message)
        .filter((message) => message.startsWith("this run left"));
      expect(openNotices).toHaveLength(1);
      expect(openNotices[0]).toContain("left 1 of 2");
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("a claim with no files changed stays succeeded: nothing to verify", async () => {
    const provider = scriptedProvider([
      calls({ name: "todo", args: { action: "add", text: "plan item" } }),
      DONE,
      calls({ name: "todo", args: { action: "done", text: "t1" } }),
      DONE,
    ]);
    const { deps, kernel, store } = depsFor(provider);
    try {
      expect((await runTurn(deps, "plan it")).exit.terminal).toBe("succeeded");
      expect((await runTurn(deps, "it is done")).exit.terminal).toBe("succeeded");
    } finally {
      await kernel.close();
      store.close();
    }
  });
});
