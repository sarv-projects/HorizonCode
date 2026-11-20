/**
 * When EffectHost spine is active (`default`/`require`) and
 * HZ_EFFECT_RECONCILE_BLOCK is unset, createRuntime applies `=resource`
 * (reduced R170 product default — not full kernel R170).
 */
import { describe, expect, test } from "bun:test";
import {
  applyReconcileBlockSpineDefault,
  reconcileBlockEnvUnset,
} from "../../src/core/effect-reconcile-block";
import { setEnv } from "./helpers";

describe("reconcile-block spine default (R170 reduced)", () => {
  test("unset env is detected", () => {
    expect(reconcileBlockEnvUnset({})).toBe(true);
    expect(reconcileBlockEnvUnset({ HZ_EFFECT_RECONCILE_BLOCK: "" })).toBe(true);
    expect(reconcileBlockEnvUnset({ HZ_EFFECT_RECONCILE_BLOCK: "1" })).toBe(false);
  });

  test("applies =resource when EffectHost is default/require and block unset", () => {
    const env: Record<string, string | undefined> = {
      HZ_EFFECT_HOST_KERNEL: "require",
      HZ_EFFECT_RECONCILE_BLOCK: "",
    };
    const r = applyReconcileBlockSpineDefault(env);
    expect(r.applied).toBe(true);
    expect(env.HZ_EFFECT_RECONCILE_BLOCK).toBe("resource");
    expect(r.notice).toMatch(/resource/);
  });

  test("does not override explicit off", () => {
    const env: Record<string, string | undefined> = {
      HZ_EFFECT_HOST_KERNEL: "require",
      HZ_EFFECT_RECONCILE_BLOCK: "0",
    };
    const r = applyReconcileBlockSpineDefault(env);
    expect(r.applied).toBe(false);
    expect(env.HZ_EFFECT_RECONCILE_BLOCK).toBe("0");
  });

  test("no-op when EffectHost off", () => {
    setEnv({ HZ_EFFECT_HOST_KERNEL: "", HZ_EFFECT_RECONCILE_BLOCK: "" });
    const env: Record<string, string | undefined> = {
      HZ_EFFECT_HOST_KERNEL: "",
      HZ_EFFECT_RECONCILE_BLOCK: "",
    };
    const r = applyReconcileBlockSpineDefault(env);
    expect(r.applied).toBe(false);
  });
});
