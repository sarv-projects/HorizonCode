/**
 * `ask_user` wired through the live loop (session-state admission + ToolContext.askUser).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AskUserRequest, Provider, ProviderEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { admissionFor, runTurn, type LoopDeps } from "../../src/core/loop";
import { workspaceStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-ask-loop-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const call = (name: string, args: unknown, id: string): ProviderEvent => ({
  type: "tool_call",
  id,
  name,
  arguments: JSON.stringify(args),
});

function scriptedProvider(turns: ProviderEvent[][]): Provider {
  let i = 0;
  return {
    name: "scripted",
    async *stream() {
      const events = turns[Math.min(i, turns.length - 1)] ?? [];
      i += 1;
      for (const e of events) yield e;
    },
  };
}

describe("ask_user loop", () => {
  test("session-state admission needs no guard action", () => {
    expect(admissionFor("ask_user", { question: "?" }, workspace)).toEqual({ kind: "session-state" });
  });

  test("injected askUser receives structured options on the live path", async () => {
    const seen: AskUserRequest[] = [];
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspaceStateDir(workspace), "kernel") });
    const store = new SessionStore(workspace);
    const provider = scriptedProvider([
      [
        call(
          "ask_user",
          {
            question: "Pick",
            options: [
              { label: "a", description: "first" },
              { label: "b", recommended: true },
            ],
          },
          "c1",
        ),
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "text", text: "thanks" }, { type: "done", stopReason: "end" }],
    ]);
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("ask").id,
      model: "scripted-1",
      provider,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => {} },
      sessionLeases: [],
      approve: async () => true,
      askUser: async (req) => {
        seen.push(req);
        return "b";
      },
    };
    try {
      await runTurn(deps, "decide");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.options?.map((o) => o.label)).toEqual(["a", "b"]);
      expect(seen[0]?.options?.[1]?.recommended).toBe(true);
      const history = store.history(deps.sessionId);
      const toolMsg = history.find((m) => m.role === "tool");
      expect(toolMsg?.content).toContain("b");
    } finally {
      await kernel.close();
      store.close();
    }
  });
});