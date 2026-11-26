/**
 * egress-park.test.ts -- advisory parked Ask hold state (plan Task 13).
 * Pure TS hold state; not connection parking, no forwarded bytes.
 */
import { describe, expect, test } from "bun:test";
import {
  EgressAskPark,
  EgressParkOverloaded,
  egressParkBackstopMs,
} from "../../src/core/egress-park";

describe("advisory egress Ask park", () => {
  test("one-shot approval cannot approve twice; the 600s backstop auto-denies", async () => {
    let now = 0;
    const park = new EgressAskPark({ now: () => now });
    const p = park.park("call-1");
    expect(park.approveOnce("call-1")).toBe(true);
    expect(park.approveOnce("call-1")).toBe(false);
    expect((await p).decided).toBe("approved");

    const q = park.park("call-2");
    expect(egressParkBackstopMs({})).toBe(600_000);
    now = 600_000;
    expect(park.sweep()).toContain("call-2");
    expect((await q).decided).toBe("denied");
  });

  test("abort denies and removes the parked request", async () => {
    const park = new EgressAskPark({ now: () => 0 });
    const controller = new AbortController();
    const waiting = park.park("call-abort", controller.signal);
    controller.abort();
    expect((await waiting).decided).toBe("denied");
    expect(park.pending()).toBe(0);
  });

  test("bounded hold budgets fail closed", async () => {
    const park = new EgressAskPark({ now: () => 0 });
    const waits = Array.from({ length: 8 }, () => park.park("same-key"));
    expect(() => park.park("same-key")).toThrow(EgressParkOverloaded);
    park.sweep(600_001);
    await Promise.all(waits);

    const distinct = Array.from({ length: 16 }, (_, i) => park.park(`d-${i}`));
    expect(() => park.park("overflow")).toThrow(EgressParkOverloaded);
    park.sweep(600_002);
    await Promise.all(distinct);
  });

  test("backstop env override is opt-in and invalid values fall back", () => {
    expect(egressParkBackstopMs({ HZ_EGRESS_HOLD_SECONDS: "5" })).toBe(5_000);
    expect(egressParkBackstopMs({ HZ_EGRESS_HOLD_SECONDS: "bad" })).toBe(600_000);
    expect(egressParkBackstopMs({ HZ_EGRESS_HOLD_SECONDS: "-1" })).toBe(600_000);
  });
});
