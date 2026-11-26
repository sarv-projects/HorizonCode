/**
 * env-snapshot.test.ts -- all opt-in strict flags must be captured and restored
 * by the shared test helpers, or they leak across test files in a full run.
 */
import { describe, expect, test } from "bun:test";
import { restoreEnv, setEnv, snapshotEnv } from "./helpers";

describe("shared env snapshot", () => {
  test("restores the new strict/refresh flags exactly", () => {
    const keys = [
      "HZ_EFFECT_HOST_MCP_READONLY_STRICT",
      "HZ_R172_REQUIRE_KEYED",
      "HZ_ENVIRONMENT_REFRESH_EVERY",
      "HZ_GOAL_EVALUATOR_MODEL",
      "HZ_GOAL_VERIFY_CMD",
    ] as const;
    const snap = snapshotEnv();
    const original = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      setEnv(Object.fromEntries(keys.map((k) => [k, "1"])));
      for (const key of keys) expect(process.env[key]).toBe("1");
    } finally {
      restoreEnv(snap);
    }
    for (const key of keys) expect(process.env[key]).toBe(original[key]);
  });
});
