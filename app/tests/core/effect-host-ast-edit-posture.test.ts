import { expect, test } from "bun:test";
import { effectHostDoctorPosture } from "../../src/core/effect-host-posture";

test("default EffectHost doctor posture reports AST-edit shape refusal", () => {
  const posture = effectHostDoctorPosture({ HZ_EFFECT_HOST_KERNEL: "default" });
  expect(posture.detail.toLowerCase()).toContain("shape-ineligible write/edit/apply_patch/ast_edit refused");
});
