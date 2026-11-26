/**
 * subagent-delivery.test.ts — port of grok message-delivery-core identity +
 * lifecycle (Tier 1 #7). Test-first: fails on missing module.
 */
import { describe, expect, test } from "bun:test";
import {
  AgentId,
  AttemptId,
  DeliveryLifecycle,
  OpaqueAddress,
  type TerminalCause,
} from "../../src/core/subagent-delivery";

describe("subagent delivery identity (grok port)", () => {
  test("AgentId/AttemptId are host-entropy minted, restart-stable, distinct namespaces", () => {
    const a = AgentId.mint("seed-1");
    expect(AgentId.mint("seed-1").asStr()).toBe(a.asStr());
    expect(AgentId.mint("seed-2").asStr()).not.toBe(a.asStr());
    expect(a.asStr()).toMatch(/^ag1\./);
    expect(AttemptId.mint("seed-1").asStr()).toMatch(/^at1\./);
    expect(AttemptId.parse("garbage")).toBeUndefined();
    expect(AgentId.parse(a.asStr())?.asStr()).toBe(a.asStr());
  });

  test("opaque child address is distinct from the session id", () => {
    const addr = OpaqueAddress.mint("delivery-entropy");
    expect(addr.asStr()).not.toBe("session-123");
    expect(addr.asStr()).toMatch(/^dx1\./);
    expect(OpaqueAddress.parse(addr.asStr())?.asStr()).toBe(addr.asStr());
  });

  test("typed Pending -> Projecting -> Delivered with commit-before-transition", () => {
    const lc = new DeliveryLifecycle<string>();
    const id = AgentId.mint("a").asStr();
    const events: string[] = [];
    lc.admitPending(id, "hello", () => events.push("commit:" + id));
    expect(lc.phaseOf(id)).toBe("pending");
    expect(() => lc.admitPending(id, "dup")).toThrow(/duplicate/i);
    lc.beginProjection(id);
    expect(lc.phaseOf(id)).toBe("projecting");
    lc.commitAndDeliver(id);
    expect(lc.phaseOf(id)).toBe("delivered");
    expect(events).toEqual(["commit:" + id]);
  });

  test("terminal causes: completion/soft-cancel/rewind fall back; hard teardown does not", () => {
    const lc = new DeliveryLifecycle<string>();
    const a = AgentId.mint("a").asStr();
    const b = AgentId.mint("b").asStr();
    lc.admitPending(a, "a");
    lc.admitPending(b, "b");
    const result = lc.terminate("soft_cancel" as TerminalCause, a);
    expect(result.fallbacks).toContain("a");
    expect(result.completions).toEqual([]);
    const hard = lc.terminate("hard_teardown" as TerminalCause, "all");
    expect(hard.fallbacks).toEqual([]);
    expect(hard.completions).toContain("b");
  });

  test("unknown ids are refused without mutating state", () => {
    const lc = new DeliveryLifecycle<string>();
    expect(() => lc.beginProjection("missing")).toThrow(/unknown/i);
    expect(lc.len()).toBe(0);
  });
});
