/**
 * Ruling 653 — never-routable ambient tools refused under =default/=1.
 */

import { describe, expect, test } from "bun:test";
import {
  EFFECT_HOST_KERNEL_NO_AMBIENT_TOOL_NOTICE,
  effectHostDoctorPosture,
  effectHostNoAmbientToolPreflight,
} from "../../src/core/effect-host-posture";
import { restoreEnv, setEnv, snapshotEnv } from "./helpers";

describe("effectHostNoAmbientToolPreflight (ruling 653)", () => {
  test("refuses preview/agent/code_mode/MCP under =default and =1", () => {
    const snap = snapshotEnv();
    try {
      for (const mode of ["default", "1"] as const) {
        setEnv({ HZ_EFFECT_HOST_KERNEL: mode });
        for (const tool of ["preview", "agent", "code_mode", "shell_session"]) {
          const refusal = effectHostNoAmbientToolPreflight(tool);
          expect(refusal).toContain(EFFECT_HOST_KERNEL_NO_AMBIENT_TOOL_NOTICE);
          expect(refusal).toContain(tool);
        }
        // Unregistered mcp__ is conservative-mutating → ruling **721**, not generic **653**.
        expect(effectHostNoAmbientToolPreflight("mcp__x__y")).toContain("OwnerLog-admitted");
        expect(effectHostNoAmbientToolPreflight("write")).toBeUndefined();
        expect(effectHostNoAmbientToolPreflight("read")).toBeUndefined();
        expect(effectHostNoAmbientToolPreflight("undo")).toBeUndefined();
      }
    } finally {
      restoreEnv(snap);
    }
  });

  test("inert when EffectHost off or require (require uses 649)", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_KERNEL: undefined });
      expect(effectHostNoAmbientToolPreflight("preview")).toBeUndefined();
      setEnv({ HZ_EFFECT_HOST_KERNEL: "require" });
      expect(effectHostNoAmbientToolPreflight("preview")).toBeUndefined();
    } finally {
      restoreEnv(snap);
    }
  });

  test("doctor default names never-routable refuse", () => {
    const def = effectHostDoctorPosture({ HZ_EFFECT_HOST_KERNEL: "default" });
    expect(def.detail).toContain("653");
    expect(def.detail.toLowerCase()).toContain("never-routable");
  });
});
