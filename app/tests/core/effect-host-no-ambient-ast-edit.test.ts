import { expect, test } from "bun:test";
import { EFFECT_HOST_KERNEL_NO_AMBIENT_SHAPE_MUTATION_NOTICE, effectHostNoAmbientShapeIneligibleMutationRefusal } from "../../src/core/effect-kernel-mutation-route";

test("shape-ineligible ast_edit is refused when EffectHost is on", () => {
  for (const mode of ["default", "1"]) {
    const env = { HZ_EFFECT_HOST_KERNEL: mode };
    const refusal = effectHostNoAmbientShapeIneligibleMutationRefusal(
      "ast_edit",
      { path: "x.ts", pat: "", out: "replacement" },
      false,
      env,
    );
    expect(typeof refusal).toBe("string");
    expect(refusal).toContain(EFFECT_HOST_KERNEL_NO_AMBIENT_SHAPE_MUTATION_NOTICE);
    expect(refusal?.toLowerCase()).toContain("ast_edit args ineligible");
  }
  expect(
    effectHostNoAmbientShapeIneligibleMutationRefusal(
      "ast_edit",
      { path: "x.ts", pat: "foo", out: "bar" },
      false,
      { HZ_EFFECT_HOST_KERNEL: "default" },
    ),
  ).toBeUndefined();
  expect(
    effectHostNoAmbientShapeIneligibleMutationRefusal(
      "ast_edit",
      { path: "x.ts", pat: "", out: "bar" },
      false,
      { HZ_EFFECT_HOST_KERNEL: "0" },
    ),
  ).toBeUndefined();
});
