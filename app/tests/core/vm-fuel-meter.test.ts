/**
 * vm-fuel-meter.test.ts — Group D fuel-metered VM scheduler (opencode VM ADAPT).
 * Pure deterministic fuel accounting: instruction/native costs, slice deadlines,
 * cooperative suspend. No actual bytecode interpreter here.
 */
import { describe, expect, test } from "bun:test";
import {
  INITIAL_FUEL,
  NATIVE_FUEL,
  createFuelMeter,
  tickFuel,
  nativeFuel,
  type FuelMeter,
} from "../../src/core/vm-fuel-meter";

describe("fuel-metered scheduler (opencode VM port)", () => {
  test("constants match the upstream VM", () => {
    expect(INITIAL_FUEL).toBe(10_000);
    expect(NATIVE_FUEL).toBe(50);
  });

  test("instruction ticks decrement fuel; native calls cost more", () => {
    // Inject a fixed clock: this test's contract is fuel arithmetic, not the
    // 1 ms slice deadline (which has its own test below).
    let m: FuelMeter = createFuelMeter({ now: () => 0 });
    m = tickFuel(m, 1).state;
    expect(m.fuel).toBe(INITIAL_FUEL - 1);
    m = nativeFuel(m).state;
    expect(m.fuel).toBe(INITIAL_FUEL - 1 - NATIVE_FUEL);
  });

  test("running out of fuel yields a suspend verdict with a fresh budget", () => {
    let m: FuelMeter = createFuelMeter({ initial: 2 });
    m = tickFuel(m, 1).state; // fuel 1
    const r = tickFuel(m, 1); // fuel 0 -> suspend, refuel
    expect(r.verdict).toBe("suspend");
    expect(r.state.fuel).toBe(2); // refueled to initial
    expect(r.reason).toMatch(/fuel/i);
  });

  test("a slice deadline also suspends cooperatively", () => {
    let m: FuelMeter = createFuelMeter({ initial: 1000, now: () => 0 });
    const r = tickFuel(m, 1, /* nowMs */ 100); // beyond default 1ms slice
    expect(r.verdict).toBe("suspend");
    expect(r.reason).toMatch(/slice/i);
  });

  test("fuel never goes negative and is deterministic", () => {
    const m = createFuelMeter({ initial: 1 });
    const r = tickFuel(m, 500);
    expect(r.state.fuel).toBeGreaterThanOrEqual(0);
    expect(tickFuel(m, 3).state.fuel).toBe(tickFuel(m, 3).state.fuel);
  });
});
