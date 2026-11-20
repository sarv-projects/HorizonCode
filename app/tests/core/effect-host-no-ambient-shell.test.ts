/**
 * Ruling 652 — compound/interpreter shell refused when EffectHost is on
 * (=default/=1), not only under =require.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  EFFECT_HOST_KERNEL_NO_AMBIENT_SHELL_NOTICE,
  effectHostNoAmbientCompoundShellRefusal,
} from "../../src/core/effect-kernel-mutation-route";
import { effectHostDoctorPosture } from "../../src/core/effect-host-posture";
import { restoreEnv, setEnv, snapshotEnv, type EnvSnapshot } from "./helpers";

describe("effectHostNoAmbientCompoundShellRefusal (ruling 652)", () => {
  let snap: EnvSnapshot;

  afterEach(() => {
    restoreEnv(snap);
  });

  test("refuses compound under =default and =1", () => {
    snap = snapshotEnv();
    for (const mode of ["default", "1"] as const) {
      setEnv({ HZ_EFFECT_HOST_KERNEL: mode });
      const refusal = effectHostNoAmbientCompoundShellRefusal(
        "shell",
        { command: "echo a && echo b" },
        false,
      );
      expect(refusal).toContain(EFFECT_HOST_KERNEL_NO_AMBIENT_SHELL_NOTICE);
      expect(refusal?.toLowerCase()).toContain("compound");
    }
  });

  test("refuses interpreter / metachar under =default", () => {
    snap = snapshotEnv();
    setEnv({ HZ_EFFECT_HOST_KERNEL: "default" });
    expect(
      effectHostNoAmbientCompoundShellRefusal("shell", { command: "bash -c 'echo hi'" }, false),
    )?.toContain(EFFECT_HOST_KERNEL_NO_AMBIENT_SHELL_NOTICE);
    expect(
      effectHostNoAmbientCompoundShellRefusal("shell", { command: "echo $HOME" }, false),
    )?.toContain(EFFECT_HOST_KERNEL_NO_AMBIENT_SHELL_NOTICE);
  });

  test("inert when EffectHost off; defers to require path under =require", () => {
    snap = snapshotEnv();
    setEnv({ HZ_EFFECT_HOST_KERNEL: "0" });
    expect(
      effectHostNoAmbientCompoundShellRefusal("shell", { command: "echo a && echo b" }, false),
    ).toBeUndefined();
    setEnv({ HZ_EFFECT_HOST_KERNEL: undefined });
    expect(
      effectHostNoAmbientCompoundShellRefusal("shell", { command: "echo a && echo b" }, false),
    ).toBeUndefined();
    setEnv({ HZ_EFFECT_HOST_KERNEL: "require" });
    expect(
      effectHostNoAmbientCompoundShellRefusal("shell", { command: "echo a && echo b" }, false),
    ).toBeUndefined();
  });

  test("allows simple argv miss only when not shape-blocked (timeout still Bun under default)", () => {
    snap = snapshotEnv();
    setEnv({ HZ_EFFECT_HOST_KERNEL: "default" });
    expect(
      effectHostNoAmbientCompoundShellRefusal("shell", { command: "echo hi", timeoutMs: 1000 }, false),
    ).toBeUndefined();
    expect(
      effectHostNoAmbientCompoundShellRefusal("shell", { command: "echo hi" }, true),
    ).toBeUndefined();
  });

  test("doctor default posture names compound refuse when EffectHost on", () => {
    const def = effectHostDoctorPosture({ HZ_EFFECT_HOST_KERNEL: "default" });
    expect(def.detail.toLowerCase()).toContain("652");
    expect(def.detail.toLowerCase()).toContain("compound");
    expect(def.detail.toLowerCase()).not.toMatch(/compound.*fall back to ambient bun shell/i);
  });
});
