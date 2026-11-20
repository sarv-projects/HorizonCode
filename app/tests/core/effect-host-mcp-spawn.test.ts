/**
 * Ruling 702 — MCP stdio server spawn refused when EffectHost kernel spine is on.
 */

import { describe, expect, test } from "bun:test";
import {
  EFFECT_HOST_KERNEL_MCP_SPAWN_REFUSED_NOTICE,
  effectHostDoctorPosture,
  effectHostMcpAmbientSpawnRefusal,
} from "../../src/core/effect-host-posture";
import { restoreEnv, setEnv, snapshotEnv } from "./helpers";

describe("effectHostMcpAmbientSpawnRefusal (ruling 702)", () => {
  test("refuses spawn under require, default, and =1", () => {
    const snap = snapshotEnv();
    try {
      for (const mode of ["require", "default", "1"] as const) {
        setEnv({ HZ_EFFECT_HOST_KERNEL: mode });
        const refusal = effectHostMcpAmbientSpawnRefusal("my-server");
        expect(refusal).toContain(EFFECT_HOST_KERNEL_MCP_SPAWN_REFUSED_NOTICE);
        expect(refusal).toContain("my-server");
      }
    } finally {
      restoreEnv(snap);
    }
  });

  test("inert when EffectHost off", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_KERNEL: undefined });
      expect(effectHostMcpAmbientSpawnRefusal("echo")).toBeUndefined();
    } finally {
      restoreEnv(snap);
    }
  });

  test("doctor names MCP spawn refuse under default", () => {
    const posture = effectHostDoctorPosture({ HZ_EFFECT_HOST_KERNEL: "default" });
    expect(posture.detail).toContain("702");
    expect(posture.detail.toLowerCase()).toContain("mcp stdio spawn");
  });
});