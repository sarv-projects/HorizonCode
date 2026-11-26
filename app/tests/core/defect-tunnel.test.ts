/**
 * defect-tunnel.test.ts — port of opencode DeclinedError tunneling (Group B).
 * A user's plain decline must NEVER be converted into model-facing tool output
 * by a blanket mapError wrapper. A decline WITH feedback stays typed.
 */
import { describe, expect, test } from "bun:test";
import {
  CorrectedError,
  UserDeclinedDefect,
  tunnelDecline,
  mapToolErrorKeepingDecline,
} from "../../src/core/guards/defect-tunnel";

describe("user-decline defect tunnel (opencode port)", () => {
  test("a plain decline is re-thrown as an uncaught defect through a blanket mapper", () => {
    const decline = new UserDeclinedDefect();
    expect(() =>
      mapToolErrorKeepingDecline(() => {
        throw decline;
      }, () => ({ type: "error" as const, message: "模型-facing output" })),
    ).toThrow(UserDeclinedDefect);
  });

  test("a corrected decline (with feedback) stays typed and maps to a tool error", () => {
    const corrected = new CorrectedError("use a narrower path");
    const result = mapToolErrorKeepingDecline(
      () => {
        throw corrected;
      },
      (err) => ({ type: "error" as const, message: (err as Error).message }),
    );
    expect(result).toEqual({ type: "error", message: "use a narrower path" });
  });

  test("ordinary errors still map normally", () => {
    const result = mapToolErrorKeepingDecline(
      () => {
        throw new Error("boom");
      },
      (err) => ({ type: "error" as const, message: (err as Error).message }),
    );
    expect(result.message).toBe("boom");
  });

  test("tunnelDecline identifies only the plain decline", () => {
    expect(() => tunnelDecline(new UserDeclinedDefect())).toThrow(UserDeclinedDefect);
    expect(tunnelDecline(new CorrectedError("x"))).toBeUndefined();
    expect(tunnelDecline(new Error("x"))).toBeUndefined();
  });
});
