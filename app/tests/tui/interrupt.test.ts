import { describe, expect, test } from "bun:test";
import { interruptAction, type InterruptAction, type InterruptState } from "../../src/tui/interactive";

/**
 * I-5: the interactive Ctrl-C decision is a pure function so the portable test
 * harness never has to drive readline keypress events or a real TTY.
 */
describe("interactive Ctrl-C as user input (I-5)", () => {
  const decide = (state: Partial<InterruptState>): InterruptAction =>
    interruptAction({
      busy: state.busy ?? false,
      abortRequested: state.abortRequested ?? false,
      approvalOpen: state.approvalOpen ?? false,
    });

  test("first Ctrl-C in a busy turn cancels cleanly without exiting", () => {
    expect(decide({ busy: true, abortRequested: false })).toBe("cancel");
  });

  test("second Ctrl-C in the same busy turn exits", () => {
    expect(decide({ busy: true, abortRequested: true })).toBe("exit");
  });

  test("Ctrl-C while idle exits (unchanged non-turn behaviour)", () => {
    expect(decide({ busy: false, abortRequested: false })).toBe("exit");
    // Even a stale abortRequested flag from a just-cancelled turn: once the turn
    // has settled, an idle Ctrl-C still leaves the session.
    expect(decide({ busy: false, abortRequested: true })).toBe("exit");
  });

  test("Ctrl-C with an approval open denies it and never exits or cancels", () => {
    expect(decide({ busy: false, approvalOpen: true })).toBe("deny");
    expect(decide({ busy: true, abortRequested: false, approvalOpen: true })).toBe("deny");
    expect(decide({ busy: true, abortRequested: true, approvalOpen: true })).toBe("deny");
  });

  test("the decision is total and deterministic for every state cell", () => {
    const observed = new Set<InterruptAction>();
    for (const busy of [false, true]) {
      for (const abortRequested of [false, true]) {
        for (const approvalOpen of [false, true]) {
          observed.add(decide({ busy, abortRequested, approvalOpen }));
        }
      }
    }
    expect([...observed].sort()).toEqual(["cancel", "deny", "exit"]);
  });
});
