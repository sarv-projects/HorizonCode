/**
 * cooperative-stop.test.ts — port of opencode COOPERATIVE_STOP grace window (Group B).
 * User stop asks cancelable tools to settle, waits up to 5s, then hard-interrupts.
 */
import { describe, expect, test } from "bun:test";
import { COOPERATIVE_STOP_MS, cooperativeStop, type ToolRun } from "../../src/core/cooperative-stop";

function run(opts: Partial<ToolRun> & { id: string }): ToolRun {
  return {
    triggerCancel: () => true,
    settle: () => Promise.resolve(),
    interrupt: () => {},
    ...opts,
  };
}

describe("cooperative stop grace window (opencode port)", () => {
  test("all cancelable tools settle cooperatively: no hard interrupt", async () => {
    let interrupts = 0;
    const runs = [
      run({ id: "a", triggerCancel: () => true, interrupt: () => { interrupts += 1; } }),
      run({ id: "b", triggerCancel: () => true, interrupt: () => { interrupts += 1; } }),
    ];
    const result = await cooperativeStop(runs, { timeoutMs: 50 });
    expect(result.cooperativelySettled).toBe(2);
    expect(result.forceInterrupted).toBe(0);
    expect(interrupts).toBe(0);
  });

  test("a tool that ignores cancel is hard-interrupted after the grace window", async () => {
    let interrupts = 0;
    const runs = [
      run({ id: "fast", triggerCancel: () => true }),
      run({
        id: "stuck",
        triggerCancel: () => true,
        settle: () => new Promise<void>(() => {}), // never settles
        interrupt: () => { interrupts += 1; },
      }),
    ];
    const result = await cooperativeStop(runs, { timeoutMs: 20 });
    expect(result.cooperativelySettled).toBe(1);
    expect(result.forceInterrupted).toBe(1);
    expect(interrupts).toBe(1);
  });

  test("a tool without a cancel handle is interrupted immediately, not waited on", async () => {
    let interrupts = 0;
    const runs = [
      run({
        id: "no-cancel",
        triggerCancel: () => false,
        settle: () => new Promise<void>(() => {}),
        interrupt: () => { interrupts += 1; },
      }),
    ];
    const result = await cooperativeStop(runs, { timeoutMs: 20 });
    expect(result.forceInterrupted).toBe(1);
    expect(interrupts).toBe(1);
  });

  test("default grace window is 5 seconds", () => {
    expect(COOPERATIVE_STOP_MS).toBe(5000);
  });
});
