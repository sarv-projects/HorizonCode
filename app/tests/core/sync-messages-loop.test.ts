/**
 * B-5 / ruling 482: ProviderHistorySync wired through runTurn after compactHistory.
 * Across dispatches, byte-stable prefix message objects are reused (omp syncMessages).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ChatMsg, Provider, ProviderEvent, ProviderRequest, RuntimeEvent } from "../../src/contracts";
import { InterjectionBuffer } from "../../src/core/interjection";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";
import { syncForkedHistory } from "../../src/core/sync-messages";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-sync-msg-loop-"));
  process.env.HZ_ACTION_STATIONARITY = "0";
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("syncMessages loop wire (B-5 / 482)", () => {
  test("second dispatch reuses first-dispatch prefix message objects", async () => {
    writeFileSync(path.join(workspace, "note.txt"), "hello\n");
    const store = new SessionStore(workspace);
    const sessionId = store.createSession("sync-loop").id;
    const seen: ChatMsg[][] = [];
    let calls = 0;
    const provider: Provider = {
      name: "scripted",
      async *stream(req: ProviderRequest) {
        calls += 1;
        seen.push([...(req.messages ?? [])]);
        if (calls === 1) {
          yield {
            type: "tool_call",
            id: "call_sync_1",
            name: "read",
            arguments: JSON.stringify({ path: "note.txt" }),
          } satisfies ProviderEvent;
          yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
          return;
        }
        yield { type: "text", text: "done" } satisfies ProviderEvent;
        yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
      },
    };
    const deps: LoopDeps = {
      workspace,
      sessionId,
      model: "scripted-1",
      provider,
      kernel: new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") }),
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: (_ev: RuntimeEvent) => {} },
      sessionLeases: [],
      approve: async () => true,
    };
    const { exit } = await runTurn(deps, "read the note");
    expect(exit.terminal).toBe("succeeded");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const first = seen[0]!;
    const second = seen[1]!;
    expect(first[0]?.role).toBe("user");
    expect(second[0]).toBe(first[0]);
    expect(second.length).toBeGreaterThan(first.length);
  });

  test("steer append keeps prior prefix objects on the next dispatch", async () => {
    writeFileSync(path.join(workspace, "note.txt"), "hello\n");
    const buffer = new InterjectionBuffer();
    const store = new SessionStore(workspace);
    const sessionId = store.createSession("sync-steer").id;
    const seen: ChatMsg[][] = [];
    let calls = 0;
    const provider: Provider = {
      name: "scripted",
      async *stream(req: ProviderRequest) {
        calls += 1;
        seen.push([...(req.messages ?? [])]);
        if (calls === 1) {
          buffer.push("steer after tool");
          yield {
            type: "tool_call",
            id: "call_steer_1",
            name: "read",
            arguments: JSON.stringify({ path: "note.txt" }),
          } satisfies ProviderEvent;
          yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
          return;
        }
        yield { type: "text", text: "steered done" } satisfies ProviderEvent;
        yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
      },
    };
    const admitted: string[] = [];
    const deps: LoopDeps = {
      workspace,
      sessionId,
      model: "scripted-1",
      provider,
      kernel: new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") }),
      store,
      signal: new AbortController().signal,
      callbacks: {
        onEvent: (ev) => {
          if (ev.type === "interjection.admitted") admitted.push(ev.text);
        },
      },
      sessionLeases: [],
      approve: async () => true,
      interjection: buffer,
      budget: { maxSteps: 20 },
    };
    const { exit } = await runTurn(deps, "start");
    expect(exit.terminal).toBe("succeeded");
    expect(admitted).toContain("steer after tool");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[1]![0]).toBe(seen[0]![0]);
    const steered = store.history(sessionId).some(
      (m) => m.role === "user" && (m.content ?? "").includes("steer after tool"),
    );
    expect(steered).toBe(true);
  });

  test("fork helper compact kind matches parent prefix (in-memory rewrite)", () => {
    const parent: ChatMsg[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    const child = syncForkedHistory(parent, 2);
    expect(child.kind).toBe("compact");
    expect(child.messages).toHaveLength(2);
    expect(child.messages[0]).toBe(parent[0]);
    expect(child.messages[1]).toBe(parent[1]);
  });
});
