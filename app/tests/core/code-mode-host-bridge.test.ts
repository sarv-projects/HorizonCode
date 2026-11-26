/**
 * code-mode-host-bridge.test.ts — VM async host bridge (opencode HostCalls ADAPT).
 * Bytecode calls a registered async host function; the VM suspends until the
 * promise settles, then resumes with the resolved value on the stack.
 */
import { describe, expect, test } from "bun:test";
import { Op } from "../../src/core/code-mode-vm";
import { createHostBridge, HOST_CALL, type HostFunction } from "../../src/core/code-mode-host-bridge";

describe("VM async host bridge", () => {
  test("a host call suspends; resolving resumes with the value on the stack", async () => {
    const hosts: Record<string, HostFunction> = {
      fetchValue: async (n: number) => n * 10,
    };
    const bridge = createHostBridge({
      words: [
        Op.PUSH_INT, 7,
        HOST_CALL, 0,   // call host "fetchValue" (const 0) with 1 arg
        Op.PUSH_INT, 5,
        Op.ADD,            // 70 + 5
        Op.RETURN,
      ],
      consts: ["fetchValue"],
    }, { hosts });

    const pending = await bridge.start();
    expect(pending.kind).toBe("suspended");
    expect(pending.call?.name).toBe("fetchValue");
    expect(pending.call?.args).toEqual([7]);

    const result = await bridge.resolveCall(pending.call!.id, 70);
    expect(result.kind).toBe("done");
    expect(result.value).toBe(75);
  });

  test("an unknown host is a typed refusal", async () => {
    const bridge = createHostBridge({
      words: [HOST_CALL, 0, Op.RETURN],
      consts: ["missing"],
    }, { hosts: {} });
    const r = await bridge.start();
    expect(r.kind).toBe("fault");
    expect(r.error).toMatch(/host|unknown/i);
  });

  test("a rejecting host surfaces a typed fault", async () => {
    const bridge = createHostBridge({
      words: [HOST_CALL, 0, Op.RETURN],
      consts: ["boom"],
    }, { hosts: { boom: async () => { throw new Error("kaboom"); } } });
    const pending = await bridge.start();
    const r = await bridge.resolveCall(pending.call!.id, undefined, new Error("kaboom"));
    expect(r.kind).toBe("fault");
    expect(r.error).toContain("kaboom");
  });

  test("resolving an unknown call id is a typed refusal", async () => {
    const bridge = createHostBridge({ words: [Op.RETURN], consts: [] }, { hosts: {} });
    const r = await bridge.resolveCall("nope", 1);
    expect(r.kind).toBe("fault");
  });
});
