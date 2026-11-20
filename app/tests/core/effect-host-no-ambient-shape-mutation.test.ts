/**
 * Ruling 667 — shape-ineligible write/edit/apply_patch refused when EffectHost is on
 * (=default/=1), not only under =require.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  EFFECT_HOST_KERNEL_NO_AMBIENT_SHAPE_MUTATION_NOTICE,
  effectHostNoAmbientShapeIneligibleMutationRefusal,
} from "../../src/core/effect-kernel-mutation-route";
import { effectHostDoctorPosture } from "../../src/core/effect-host-posture";
import { restoreEnv, setEnv, snapshotEnv, type EnvSnapshot } from "./helpers";

describe("effectHostNoAmbientShapeIneligibleMutationRefusal (ruling 667)", () => {
  let snap: EnvSnapshot;

  afterEach(() => {
    restoreEnv(snap);
  });

  test("refuses ineligible write/edit under =default and =1", () => {
    snap = snapshotEnv();
    for (const mode of ["default", "1"] as const) {
      setEnv({ HZ_EFFECT_HOST_KERNEL: mode });
      const writeRefusal = effectHostNoAmbientShapeIneligibleMutationRefusal(
        "write",
        { path: "x.ts" },
        false,
      );
      expect(writeRefusal).toContain(EFFECT_HOST_KERNEL_NO_AMBIENT_SHAPE_MUTATION_NOTICE);
      expect(writeRefusal?.toLowerCase()).toContain("write args ineligible");

      const editRefusal = effectHostNoAmbientShapeIneligibleMutationRefusal(
        "edit",
        { path: "x.ts", old: "a", new: "b", start_anchor: "line:1" },
        false,
      );
      expect(editRefusal).toContain(EFFECT_HOST_KERNEL_NO_AMBIENT_SHAPE_MUTATION_NOTICE);
      expect(editRefusal?.toLowerCase()).toContain("edit args ineligible");
    }
  });

  test("refuses structurally ineligible apply_patch under =default", () => {
    snap = snapshotEnv();
    setEnv({ HZ_EFFECT_HOST_KERNEL: "default" });
    const moveMulti = `*** Begin Patch
*** Update File: a.txt
*** Move to: b.txt
@@
-old1
+new1
@@
-old2
+new2
*** End Patch`;
    const refusal = effectHostNoAmbientShapeIneligibleMutationRefusal(
      "apply_patch",
      { input: moveMulti },
      false,
    );
    expect(refusal).toContain(EFFECT_HOST_KERNEL_NO_AMBIENT_SHAPE_MUTATION_NOTICE);
    expect(refusal?.toLowerCase()).toContain("kernel-eligible");
  });

  test("inert when EffectHost off, kernel routed, or eligible args pending kernel", () => {
    snap = snapshotEnv();
    setEnv({ HZ_EFFECT_HOST_KERNEL: "0" });
    expect(
      effectHostNoAmbientShapeIneligibleMutationRefusal("write", { path: "x.ts" }, false),
    ).toBeUndefined();

    setEnv({ HZ_EFFECT_HOST_KERNEL: "default" });
    expect(
      effectHostNoAmbientShapeIneligibleMutationRefusal(
        "write",
        { path: "x.ts", content: "hi" },
        true,
      ),
    ).toBeUndefined();
    expect(
      effectHostNoAmbientShapeIneligibleMutationRefusal(
        "write",
        { path: "x.ts", content: "hi" },
        false,
      ),
    ).toBeUndefined();

    setEnv({ HZ_EFFECT_HOST_KERNEL: "require" });
    expect(
      effectHostNoAmbientShapeIneligibleMutationRefusal("write", { path: "x.ts" }, false),
    ).toBeUndefined();
  });

  test("doctor default posture names shape-ineligible refuse when EffectHost on", () => {
    const def = effectHostDoctorPosture({ HZ_EFFECT_HOST_KERNEL: "default" });
    expect(def.detail.toLowerCase()).toContain("667");
    expect(def.detail.toLowerCase()).toContain("shape-ineligible");
    expect(def.detail.toLowerCase()).not.toMatch(
      /shape-ineligible.*fall back to ambient bun for some ineligible/i,
    );
  });
});