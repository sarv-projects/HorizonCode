/** Wave 0 RC-18 literal `hz.effect.lease.issued` (ruling 444). */

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
  workspace = mkdtempSync(path.join(tmpdir(), "hz-effect-lease-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("hz.effect.lease.issued", () => {
  test("session grant mint emits lease.issued with grantId (444)", async () => {
    const stateDir = path.join(workspace, ".hzcode", "kernel");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "policy.json"),
      JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "ask" }]),
    );
    const outPath = path.join(workspace, "out.txt");
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
    const sessionId = store.createSession("effect-lease").id;
    const grant = await kernel.makeGrant("fs.write", outPath, 60_000, sessionId);
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
      const issued = events.filter((e) => e.type === EventTypes.effectLeaseIssued);
      expect(issued.length).toBeGreaterThanOrEqual(1);
      const payload = issued[0]!.payload as {
        leaseId?: string;
        grantId?: string;
        oneUse?: boolean;
        source?: string;
        kind?: string;
      };
      expect(payload.grantId).toBe(grant.leaseId);
      expect(payload.oneUse).toBe(true);
      expect(payload.source).toBe("grant_bound");
      expect(payload.kind).toBe("fs.write");
      expect(typeof payload.leaseId).toBe("string");
      expect(payload.leaseId).not.toBe(grant.leaseId);
      expect(events.some((e) => e.type === EventTypes.effectDecisionMade)).toBe(true);
    } finally {
      delete process.env.HZ_ACTION_STATIONARITY;
      await kernel.close();
      store.close();
    }
  }, 15_000);

  test("policy ask without grant does not emit lease.issued", async () => {
    const stateDir = path.join(workspace, ".hzcode", "kernel");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "policy.json"),
      JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "ask" }]),
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
    const sessionId = store.createSession("effect-lease-ask").id;
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
      expect(events.some((e) => e.type === EventTypes.effectLeaseIssued)).toBe(false);
      expect(events.some((e) => e.type === EventTypes.approvalDecision)).toBe(true);
    } finally {
      delete process.env.HZ_ACTION_STATIONARITY;
      await kernel.close();
      store.close();
    }
  }, 15_000);
});
