/**
 * Ruling 721 — mutating mcp.invoke fail-closed under EffectHost-on.
 */

import { describe, expect, test } from "bun:test";
import {
  EFFECT_HOST_KERNEL_MCP_INVOKE_MUTATING_REFUSED_NOTICE,
  EFFECT_HOST_KERNEL_REQUIRE_NOTICE,
  effectHostDoctorPosture,
  effectHostKernelRequirePreflight,
  effectHostMcpInvokeMutatingRefusal,
  effectHostNoAmbientToolPreflight,
} from "../../src/core/effect-host-posture";
import { clearMcpTools, registerMcpTools } from "../../src/core/mcp/registry";
import { restoreEnv, setEnv, snapshotEnv } from "./helpers";

describe("effectHostMcpInvokeMutatingRefusal (ruling 721)", () => {
  test("refuses mutating MCP under require, default, and =1", () => {
    const snap = snapshotEnv();
    try {
      clearMcpTools();
      registerMcpTools("echo", [{ name: "note", inputSchema: { type: "object" } }]);
      registerMcpTools("echo", [{ name: "echo", inputSchema: { type: "object" }, readOnlyHint: true }]);
      const mutating = "mcp__echo__note";
      const readOnly = "mcp__echo__echo";
      for (const mode of ["require", "default", "1"] as const) {
        setEnv({ HZ_EFFECT_HOST_KERNEL: mode });
        const refusal = effectHostMcpInvokeMutatingRefusal(mutating);
        expect(refusal).toBeDefined();
        if (mode === "require") {
          expect(refusal).toContain(EFFECT_HOST_KERNEL_REQUIRE_NOTICE);
          expect(refusal).toContain("OwnerLog-admitted");
          expect(refusal).toContain("721");
        } else {
          expect(refusal).toContain(EFFECT_HOST_KERNEL_MCP_INVOKE_MUTATING_REFUSED_NOTICE);
        }
        expect(effectHostMcpInvokeMutatingRefusal(readOnly)).toBeUndefined();
      }
    } finally {
      clearMcpTools();
      restoreEnv(snap);
    }
  });

  test("unregistered mcp__ name treated as mutating (conservative)", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_KERNEL: "default" });
      expect(effectHostMcpInvokeMutatingRefusal("mcp__gone__do")).toContain(
        EFFECT_HOST_KERNEL_MCP_INVOKE_MUTATING_REFUSED_NOTICE,
      );
    } finally {
      restoreEnv(snap);
    }
  });

  test("inert when EffectHost off", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_KERNEL: undefined });
      expect(effectHostMcpInvokeMutatingRefusal("mcp__x__y")).toBeUndefined();
    } finally {
      restoreEnv(snap);
    }
  });

  test("preflight: read-only MCP allowed under default; mutating refused", () => {
    const snap = snapshotEnv();
    try {
      clearMcpTools();
      registerMcpTools("srv", [
        { name: "ro", inputSchema: { type: "object" }, readOnlyHint: true },
        { name: "mut", inputSchema: { type: "object" } },
      ]);
      setEnv({ HZ_EFFECT_HOST_KERNEL: "default" });
      expect(effectHostNoAmbientToolPreflight("mcp__srv__ro")).toBeUndefined();
      expect(effectHostNoAmbientToolPreflight("mcp__srv__mut")).toContain(
        EFFECT_HOST_KERNEL_MCP_INVOKE_MUTATING_REFUSED_NOTICE,
      );
      setEnv({ HZ_EFFECT_HOST_KERNEL: "require" });
      expect(effectHostKernelRequirePreflight("mcp__srv__mut", {})).toContain("OwnerLog-admitted");
      expect(effectHostKernelRequirePreflight("mcp__srv__ro", {})).toContain("read-only");
    } finally {
      clearMcpTools();
      restoreEnv(snap);
    }
  });

  test("doctor names mutating mcp.invoke gap under require", () => {
    const posture = effectHostDoctorPosture({ HZ_EFFECT_HOST_KERNEL: "require" });
    expect(posture.hint).toContain("721");
    expect(posture.hint.toLowerCase()).toContain("mutating");
    expect(posture.hint.toLowerCase()).toContain("mcp.invoke");
  });
});