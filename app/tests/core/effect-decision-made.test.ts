/** Wave 0 RC-18 literal `hz.effect.decision.made` (ruling 407). */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent } from "../../src/contracts";
import { EventTypes } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, streamFor, type LoopDeps } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";

let workspace = "";

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-effect-decision-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("hz.effect.decision.made", () => {
  test("policy ask emits decision.ask then decision.allow after approval", async () => {
    const stateDir = path.join(workspace, ".hzcode", "kernel");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "policy.json"),
      JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "ask" }]),
    );
    let turn = 0;
    const provider: Provider = {
      name: "scripted",
      async *stream() {
        turn += 1;
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "call_1",
            name: "write",
            arguments: JSON.stringify({ path: "out.txt", content: "hi" }),
          } satisfies ProviderEvent;
          yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
          return;
        }
        yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
      },
    };
    const kernel = new KernelClient({ workspace, stateDir });
    const store = new SessionStore(workspace);
    const sessionId = store.createSession("effect-decision").id;
    const deps: LoopDeps = {
      workspace,
      sessionId,
      model: "scripted-1",
      provider,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => undefined },
      sessionLeases: [],
      approve: async () => true,
    };
    try {
      process.env.HZ_ACTION_STATIONARITY = "0";
      await runTurn(deps, "write a file");
      const events = await kernel.readEvents(streamFor(sessionId));
      const decisions = events.filter((e) => e.type === EventTypes.effectDecisionMade);
      expect(decisions.length).toBeGreaterThanOrEqual(2);
      const kinds = decisions.map((e) => (e.payload as { decision?: string }).decision);
      expect(kinds).toContain("ask");
      expect(kinds).toContain("allow");
      expect(events.some((e) => e.type === EventTypes.approvalRequest)).toBe(true);
      expect(events.some((e) => e.type === EventTypes.approvalDecision)).toBe(true);
    } finally {
      delete process.env.HZ_ACTION_STATIONARITY;
      await kernel.close();
      store.close();
    }
  });

  test("policy deny emits decision.deny without permission.asked", async () => {
    const stateDir = path.join(workspace, ".hzcode", "kernel");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "policy.json"),
      JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "blocked" }]),
    );
    const provider: Provider = {
      name: "scripted",
      async *stream() {
        yield {
          type: "tool_call",
          id: "call_1",
          name: "write",
          arguments: JSON.stringify({ path: "out.txt", content: "hi" }),
        } satisfies ProviderEvent;
        yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
        yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
      },
    };
    const kernel = new KernelClient({ workspace, stateDir });
    const store = new SessionStore(workspace);
    const sessionId = store.createSession("effect-deny").id;
    const deps: LoopDeps = {
      workspace,
      sessionId,
      model: "scripted-1",
      provider,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => undefined },
      sessionLeases: [],
      approve: async () => true,
    };
    try {
      process.env.HZ_ACTION_STATIONARITY = "0";
      await runTurn(deps, "try write");
      const events = await kernel.readEvents(streamFor(sessionId));
      expect(events.some((e) => e.type === EventTypes.effectDecisionMade && (e.payload as { decision?: string }).decision === "deny")).toBe(
        true,
      );
      expect(events.some((e) => e.type === EventTypes.approvalRequest)).toBe(false);
    } finally {
      delete process.env.HZ_ACTION_STATIONARITY;
      await kernel.close();
      store.close();
    }
  });
});