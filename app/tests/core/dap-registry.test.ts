/** Idle sweep for live DAP sessions (docs/33 §5.1). */

import { afterEach, describe, expect, test } from "bun:test";
import {
  dapIdleMs,
  DEFAULT_DAP_IDLE_MS,
  disposeAllLiveDapSessions,
  getFocusedDapSession,
  getLiveDapSession,
  setLiveDapSession,
  sweepIdleDapSessions,
  type LiveDapSession,
} from "../../src/core/dap/registry";
import type { DapClient } from "../../src/core/dap/client";
import type { OwnedProc } from "../../src/core/owned-spawn";

afterEach(async () => {
  await disposeAllLiveDapSessions();
});

function fakeLive(workspace: string, sessionId: string, lastUsedAt: number): LiveDapSession {
  const proc = {
    kill: () => undefined,
    stdin: { end: () => undefined },
    stdout: { getReader: () => ({ read: async () => ({ done: true }) }) },
  } as unknown as OwnedProc;
  return {
    client: {} as DapClient,
    proc,
    pump: Promise.resolve(),
    workspace,
    sessionId,
    lastUsedAt,
  };
}

describe("dapIdleMs", () => {
  test("defaults and rejects tiny overrides", () => {
    expect(dapIdleMs({})).toBe(DEFAULT_DAP_IDLE_MS);
    expect(dapIdleMs({ HZ_DAP_IDLE_MS: "1000" })).toBe(DEFAULT_DAP_IDLE_MS);
    expect(dapIdleMs({ HZ_DAP_IDLE_MS: "12000" })).toBe(12_000);
  });
});

describe("sweepIdleDapSessions", () => {
  test("closes sessions past the idle TTL and keeps fresh ones", async () => {
    const now = 1_000_000;
    const stale = fakeLive("/ws", "old", now - 60_000);
    const fresh = fakeLive("/ws", "new", now - 1_000);
    setLiveDapSession(stale);
    setLiveDapSession(fresh);
    // setLiveDapSession rewrites lastUsedAt — restore ages for the sweep.
    stale.lastUsedAt = now - 60_000;
    fresh.lastUsedAt = now - 1_000;

    const closed = await sweepIdleDapSessions(30_000, now);
    expect(closed).toBe(1);
    expect(getLiveDapSession("/ws", "old")).toBeUndefined();
    expect(getLiveDapSession("/ws", "new")).toBeDefined();
  });
});

describe("DAP focus", () => {
  test("set/get updates the focused session pointer", () => {
    const a = fakeLive("/ws", "a", Date.now());
    const b = fakeLive("/ws", "b", Date.now());
    setLiveDapSession(a);
    expect(getFocusedDapSession()?.sessionId).toBe("a");
    setLiveDapSession(b);
    expect(getFocusedDapSession()?.sessionId).toBe("b");
    getLiveDapSession("/ws", "a");
    expect(getFocusedDapSession()?.sessionId).toBe("a");
  });
});
