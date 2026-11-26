/**
 * vm-fuel-meter.ts — Group D fuel-metered VM scheduler (opencode VM ADAPT).
 * Source: repo_take/opencode/packages/codemode/src/vm/vm.ts:149-155,344-373.
 *
 * Pure deterministic fuel accounting for a future bytecode VM: each instruction
 * costs 1 fuel, a native/built-in call costs NATIVE_FUEL (50), and when fuel
 * runs out OR a 1 ms slice deadline passes the run cooperatively suspends with
 * a fresh budget (the caller snapshots and resumes). No interpreter, no I/O,
 * no authority — this is the metering seam, not an execution engine.
 */

export const INITIAL_FUEL = 10_000;
export const NATIVE_FUEL = 50;
export const SLICE_MS = 1;

export interface FuelMeter {
  fuel: number;
  initial: number;
  sliceStartMs: number;
  now(): number;
}

export interface FuelTickResult {
  state: FuelMeter;
  verdict: "run" | "suspend";
  reason: string;
}

export function createFuelMeter(opts: { initial?: number; now?: () => number } = {}): FuelMeter {
  const initial = Math.max(1, Math.floor(opts.initial ?? INITIAL_FUEL));
  const now = opts.now ?? (() => Date.now());
  return { fuel: initial, initial, sliceStartMs: now(), now };
}

function settle(meter: FuelMeter, nowMs: number | undefined): FuelTickResult {
  const now = nowMs ?? meter.now();
  const sliceExceeded = now - meter.sliceStartMs >= SLICE_MS;
  if (meter.fuel <= 0) {
    return {
      state: { ...meter, fuel: meter.initial, sliceStartMs: now },
      verdict: "suspend",
      reason: "fuel exhausted — cooperative suspend with fresh budget",
    };
  }
  if (sliceExceeded) {
    return {
      state: { ...meter, fuel: meter.initial, sliceStartMs: now },
      verdict: "suspend",
      reason: "slice deadline — cooperative suspend",
    };
  }
  return { state: meter, verdict: "run", reason: "" };
}

/** Charge `cost` fuel for one or more instructions; may trigger a suspend. */
export function tickFuel(meter: FuelMeter, cost = 1, nowMs?: number): FuelTickResult {
  const next = { ...meter, fuel: Math.max(0, meter.fuel - Math.max(0, Math.floor(cost))) };
  return settle(next, nowMs);
}

/** Charge the higher native-call cost. */
export function nativeFuel(meter: FuelMeter, nowMs?: number): FuelTickResult {
  return tickFuel(meter, NATIVE_FUEL, nowMs);
}
