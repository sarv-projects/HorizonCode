/**
 * Ruling 721 — mutating mcp.invoke fail-closed under EffectHost-on.
 */

import { describe, expect, test } from "bun:test";
import {
  EFFECT_HOST_KERNEL_MCP_INVOKE_MUTATING_REFUSED_NOTICE,
  EFFECT_HOST_KERNEL_REQUIRE_NOTICE,
  effectHostDoctorPosture,
  effectHostKernelRequirePreflight,
  effectHostMcpInvokeAmbientRefusal,
  effectHostMcpInvokeMutatingRefusal,
  effectHostNoAmbientToolPreflight,
} from "../../src/core/effect-host-posture";
import { clearMcpTools, registerMcpTools } from "../../src/core/mcp/registry";
import { restoreEnv, setEnv, snapshotEnv } from "./helpers";

describe("opt-in strict read-only MCP ambient refusal (P0-1 reduction)", () => {
  test("refuses read-only mcp.invoke under default/=1 even when the strict flag is unset or zero", () => {
    const snap = snapshotEnv();
    try {
      clearMcpTools();
      registerMcpTools("srv", [{ name: "ro", inputSchema: { type: "object" }, readOnlyHint: true }]);
      const ro = "mcp__srv__ro";
      // Ruling 919: refusing is the DEFAULT; no strict flag is set here.
      setEnv({ HZ_EFFECT_HOST_KERNEL: "default", HZ_EFFECT_HOST_MCP_READONLY_STRICT: undefined });
      expect(effectHostMcpInvokeAmbientRefusal(ro)).toContain("read-only mcp.invoke");
      expect(effectHostNoAmbientToolPreflight(ro)).toContain("read-only mcp.invoke");

      setEnv({ HZ_EFFECT_HOST_KERNEL: "1" });
      expect(effectHostMcpInvokeAmbientRefusal(ro)).toContain("read-only mcp.invoke");

      // The flag no longer restores an ambient call (ruling 956).
      setEnv({ HZ_EFFECT_HOST_MCP_READONLY_STRICT: "0" });
      expect(effectHostMcpInvokeAmbientRefusal(ro)).toContain("read-only mcp.invoke");
      setEnv({ HZ_EFFECT_HOST_MCP_READONLY_STRICT: undefined, HZ_EFFECT_HOST_STRICT: "0" });
      expect(effectHostMcpInvokeAmbientRefusal(ro)).toContain("read-only mcp.invoke");

      setEnv({ HZ_EFFECT_HOST_KERNEL: "require", HZ_EFFECT_HOST_MCP_READONLY_STRICT: "1" });
      // require already refuses every ambient MCP tool through the existing rule.
      expect(effectHostMcpInvokeAmbientRefusal(ro)).toBeUndefined();

      setEnv({ HZ_EFFECT_HOST_KERNEL: undefined });
      expect(effectHostMcpInvokeAmbientRefusal(ro)).toBeUndefined();
    } finally {
      clearMcpTools();
      restoreEnv(snap);
    }
  });

  test("read-only mcp.invoke stays refused when the strict opt-out is set", () => {
    const snap = snapshotEnv();
    try {
      clearMcpTools();
      registerMcpTools("srv", [{ name: "ro", inputSchema: { type: "object" }, readOnlyHint: true }]);
      const ro = "mcp__srv__ro";
      setEnv({ HZ_EFFECT_HOST_KERNEL: "default", HZ_EFFECT_HOST_MCP_READONLY_STRICT: "0" });
      expect(effectHostMcpInvokeAmbientRefusal(ro)).toContain("read-only mcp.invoke");
      expect(effectHostNoAmbientToolPreflight(ro)).toContain("read-only mcp.invoke");
      setEnv({
        HZ_EFFECT_HOST_KERNEL: "1",
        HZ_EFFECT_HOST_MCP_READONLY_STRICT: undefined,
        HZ_EFFECT_HOST_STRICT: "0",
      });
      expect(effectHostMcpInvokeAmbientRefusal(ro)).toContain("read-only mcp.invoke");
    } finally {
      clearMcpTools();
      restoreEnv(snap);
    }
  });
});

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

  test("preflight: read-only MCP refused under default; mutating refused", () => {
    const snap = snapshotEnv();
    try {
      clearMcpTools();
      registerMcpTools("srv", [
        { name: "ro", inputSchema: { type: "object" }, readOnlyHint: true },
        { name: "mut", inputSchema: { type: "object" } },
      ]);
      setEnv({ HZ_EFFECT_HOST_KERNEL: "default" });
      expect(effectHostNoAmbientToolPreflight("mcp__srv__ro")).toContain("read-only mcp.invoke");
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