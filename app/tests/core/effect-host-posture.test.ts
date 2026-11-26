import { describe, expect, test } from "bun:test";
import {
  effectHostDoctorFixLines,
  effectHostDoctorPosture,
  effectHostKernelRequirePreflight,
  effectHostKernelRequireRefusal,
  effectHostNoAmbientFallbackRefusal,
  effectHostPrototypeHonestyDoctorHint,
  effectHostPrototypeHonestyRecommendRequire,
  EFFECT_HOST_KERNEL_REQUIRE_NOTICE,
  EFFECT_HOST_PROTOTYPE_HONESTY_REQUIRE_DETAIL,
} from "../../src/core/effect-host-posture";
import { effectHostKernelMode, effectHostKernelMutationEnabled, effectHostKernelRequireMode } from "../../src/core/effect-kernel-mutation-route";
import { restoreEnv, setEnv, snapshotEnv } from "./helpers";

describe("opt-in no-ambient-fallback gate (P0-1 reduction)", () => {
  test("refuses unrouted mutations under default/=1 only with the flag set", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_KERNEL: "default", HZ_EFFECT_HOST_NO_AMBIENT_FALLBACK: "1" });
      for (const tool of ["write", "edit", "shell", "apply_patch", "ast_edit", "undo"]) {
        expect(effectHostNoAmbientFallbackRefusal(tool, false)).toContain("ambient");
        expect(effectHostNoAmbientFallbackRefusal(tool, true)).toBeUndefined();
      }
      expect(effectHostNoAmbientFallbackRefusal("read", false)).toBeUndefined();
      // Never-routable tools must not slip through the strict default gate.
      for (const tool of ["code_mode", "preview", "agent", "shell_session", "best_of_n", "mcp__srv__ro"]) {
        expect(effectHostNoAmbientFallbackRefusal(tool, false)).toContain("ambient");
      }

      setEnv({ HZ_EFFECT_HOST_KERNEL: "1" });
      expect(effectHostNoAmbientFallbackRefusal("write", false)).toContain("ambient");

      setEnv({ HZ_EFFECT_HOST_NO_AMBIENT_FALLBACK: undefined });
      expect(effectHostNoAmbientFallbackRefusal("write", false)).toBeUndefined();

      setEnv({ HZ_EFFECT_HOST_KERNEL: "require", HZ_EFFECT_HOST_NO_AMBIENT_FALLBACK: "1" });
      expect(effectHostNoAmbientFallbackRefusal("write", false)).toBeUndefined();

      setEnv({ HZ_EFFECT_HOST_KERNEL: undefined });
      expect(effectHostNoAmbientFallbackRefusal("write", false)).toBeUndefined();
    } finally {
      restoreEnv(snap);
    }
  });
});

describe("effectHostRequireSuppressHooks (rulings 651 + 666)", () => {
  test("doctor residual documents hook suppress whenever EffectHost is on", () => {
    expect(effectHostDoctorPosture({}).detail).toContain("user hooks suppressed whenever EffectHost is on");
    expect(effectHostDoctorPosture({}).detail).not.toContain("hooks still Bun");
  });
});

describe("effectHostKernelMode", () => {
  test("require enables mutation routing and refuse gate", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_KERNEL: "require" });
      expect(effectHostKernelMode()).toBe("require");
      expect(effectHostKernelMutationEnabled()).toBe(true);
      expect(effectHostKernelRequireMode()).toBe(true);
    } finally {
      restoreEnv(snap);
    }
  });
});

describe("effectHostKernelRequirePreflight (ruling 649)", () => {
  test("refuses ambient tools under require but defers eligible write", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_KERNEL: "require" });
      // undo is kernel-routed (**650**) — preflight must not refuse it early.
      expect(effectHostKernelRequirePreflight("undo", {})).toBeUndefined();
      expect(effectHostKernelRequirePreflight("read", { path: "a.txt" })).toBeUndefined();
      expect(effectHostKernelRequirePreflight("git_status", {})).toBeUndefined();
      expect(effectHostKernelRequirePreflight("git_diff", {})).toBeUndefined();
      expect(effectHostKernelRequirePreflight("ctx_inspect", {})).toBeUndefined();
      expect(effectHostKernelRequirePreflight("history_snip_preview", {})).toBeUndefined();
      expect(effectHostKernelRequirePreflight("verified_open", { path: "a.txt" })).toBeUndefined();
      expect(effectHostKernelRequirePreflight("code_mode", { code: "return 1;" })).toContain("code_mode");
      expect(effectHostKernelRequirePreflight("mcp__x__y", {})).toContain("OwnerLog-admitted");
      expect(
        effectHostKernelRequirePreflight("shell", { command: "echo a && echo b" }),
      )?.toContain("compound");
      // Shape-eligible write must reach kernel route attempt — not preflight-refused.
      expect(
        effectHostKernelRequirePreflight("write", { path: "a.txt", content: "x\n" }),
      ).toBeUndefined();
      expect(
        effectHostKernelRequirePreflight("apply_patch", {
          input: "*** Begin Patch\n*** Update File: src.txt\n@@\n-old\n+new\n*** End Patch",
        }),
      ).toBeUndefined();
    } finally {
      restoreEnv(snap);
    }
  });

  test("preflight is inert when EffectHost is off", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_KERNEL: "0" });
      expect(effectHostKernelRequirePreflight("undo", {})).toBeUndefined();
    } finally {
      restoreEnv(snap);
    }
  });
});

describe("doctor fix lines for strict opt-ins", () => {
  test("--fix effect.host names both strict flags", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_KERNEL: "default" });
      const lines = effectHostDoctorFixLines().join("\n");
      expect(lines).toContain("HZ_EFFECT_HOST_MCP_READONLY_STRICT=0 does not restore");
      expect(lines).toContain("HZ_EFFECT_HOST_NO_AMBIENT_FALLBACK=1");
    } finally {
      restoreEnv(snap);
    }
  });
});

describe("effectHostKernelRequireRefusal", () => {
  test("refuses ineligible ast_edit shape under require", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_KERNEL: "require" });
      expect(
        effectHostKernelRequireRefusal("ast_edit", { path: "f.ts", pat: "foo($A)", out: "bar($B)" }, false),
      )?.toContain("kernel-shape-eligible");
      expect(
        effectHostKernelRequireRefusal("ast_edit", { path: "f.ts", pat: "foo($$$A)", out: "baz($$$B)" }, false),
      )?.toContain("kernel-shape-eligible");
      expect(
        effectHostKernelRequireRefusal("ast_edit", { path: "f.ts", pat: "foo($$$A)", out: "baz($$$A)" }, false),
      )?.toContain("projection unavailable");
      expect(
        effectHostKernelRequireRefusal(
          "ast_edit",
          { path: "f.ts", pat: "foo($$$A)", out: "baz($$$A)" },
          false,
          { astEditProjectionMiss: "multi_match" },
        ),
      )?.toContain("multiple sites");
    } finally {
      restoreEnv(snap);
    }
  });

  test("require refuses unclassified built-in and MCP effect paths by default", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_KERNEL: "require", HZ_TODO_DURABLE: "" });
      for (const tool of [
        "shell_session", "code_mode", "preview", "agent",
        "debug", "lsp", "lint", "handoff_create",
        "handoff_resume", "mcp__untrusted__write", "future_custom_tool",
      ]) {
        const refusal = effectHostKernelRequireRefusal(tool, {}, false);
        expect(refusal).toContain(EFFECT_HOST_KERNEL_REQUIRE_NOTICE);
        if (tool.startsWith("mcp__")) {
          expect(refusal).toContain("OwnerLog-admitted");
        } else {
          expect(refusal).toContain(`no kernel EffectHost route for ${tool}`);
        }
      }
      // Session-only present/todo are local; durable todo still refuses.
      expect(effectHostKernelRequireRefusal("present", {}, false)).toBeUndefined();
      expect(effectHostKernelRequireRefusal("todo", {}, false)).toBeUndefined();
      setEnv({ HZ_TODO_DURABLE: "1" });
      expect(effectHostKernelRequireRefusal("todo", {}, false)).toContain(EFFECT_HOST_KERNEL_REQUIRE_NOTICE);
      for (const local of [
        "read", "grep", "glob", "repo_map", "ast_search",
        "memory_search", "handoff_search", "tool_search",
      ]) {
        expect(effectHostKernelRequireRefusal(local, {}, false)).toBeUndefined();
      }
    } finally {
      restoreEnv(snap);
    }
  });

  test("doctor residual names variadic unique-projection honesty (ruling 320)", () => {
    const posture = effectHostDoctorPosture({});
    expect(posture.detail.toLowerCase()).toContain("variadic");
    expect(posture.detail.toLowerCase()).toContain("unique");
  });

  test("refuses ineligible apply_patch and shell", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_KERNEL: "require" });
      expect(
        effectHostKernelRequireRefusal("apply_patch", { input: "*** Begin Patch\n*** End Patch" }, false),
      )?.toContain("not sequential");
      expect(
        effectHostKernelRequireRefusal("apply_patch", { patch: "..." }, false),
      )?.toContain(EFFECT_HOST_KERNEL_REQUIRE_NOTICE);
      expect(
        effectHostKernelRequireRefusal(
          "apply_patch",
          { input: "*** Begin Patch\n*** Update File: src.txt\n@@\n-old\n+new\n*** End Patch" },
          false,
          { applyPatchProjectionMiss: "bun_fuzz_only" },
        ),
      )?.toContain("below-threshold");
      expect(
        effectHostKernelRequireRefusal(
          "apply_patch",
          { input: "*** Begin Patch\n*** Update File: src.txt\n@@\n-old\n+new\n*** End Patch" },
          false,
          { applyPatchProjectionMiss: "bun_first_hit_score_fuzz" },
        ),
      )?.toContain("first-hit score fuzz");
      expect(
        effectHostKernelRequireRefusal("shell", { command: "bash -c 'echo hi'" }, false),
      )?.toContain("interpreter");
      expect(
        effectHostKernelRequireRefusal("shell", { command: "echo a && echo b" }, false),
      )?.toContain("compound");
      expect(
        effectHostKernelRequireRefusal("shell", { command: "VAR=1 echo hi" }, false),
      )?.toContain("inline");
      expect(
        effectHostKernelRequireRefusal("shell", { command: "echo hi", timeoutMs: 5000 }, false),
      )?.toContain("timeoutMs");
      expect(effectHostKernelRequireRefusal("read", { path: "x" }, false)).toBeUndefined();
    } finally {
      restoreEnv(snap);
    }
  });
});

describe("effectHostDoctorPosture", () => {
  test("documents opt-in vs require", () => {
    expect(effectHostDoctorPosture({}).mode).toBe("off");
    const opt = effectHostDoctorPosture({ HZ_EFFECT_HOST_KERNEL: "1" });
    expect(opt.mode).toBe("opt-in");
    expect(opt.detail.toLowerCase()).toContain("falls back");
    const def = effectHostDoctorPosture({ HZ_EFFECT_HOST_KERNEL: "default" });
    expect(def.mode).toBe("default");
    expect(def.detail.toLowerCase()).toContain("prototype");
    const req = effectHostDoctorPosture({ HZ_EFFECT_HOST_KERNEL: "require" });
    expect(req.mode).toBe("require");
    expect(req.detail.toLowerCase()).toContain("fail-closed");
    expect(req.detail).toContain("apply_patch");
    expect(req.detail.toLowerCase()).toContain("metavar");
    expect(req.detail.toLowerCase()).toContain("code_mode");
    expect(req.detail.toLowerCase()).toContain("fs.rename");
    expect(req.detail.toLowerCase()).toContain("fs.delete");
    expect(req.hint).not.toContain("multi-metavar");
    expect(req.hint.toLowerCase()).toContain("code_mode");
    expect(def.hint.toLowerCase()).toContain("same-file");
    expect(def.hint).toContain("EOF-anchored");
    expect(def.detail.toLowerCase()).toContain("ambient bun");
    expect(def.detail.toLowerCase()).toContain("compound");
    expect(req.hint.toLowerCase()).toContain("ambient bun");
  });

  test("names Levenshtein kernel rung when edit repair enabled", () => {
    const off = effectHostDoctorPosture({});
    expect(off.detail.toLowerCase()).toContain("levenshtein");
    const on = effectHostDoctorPosture({ HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
    expect(on.detail).toContain("0.66");
    expect(on.detail.toLowerCase()).toContain("dominant score");
    expect(on.detail).toContain("0.97");
    expect(on.detail.toLowerCase()).toContain("line-patch");
  });

  test("unset doctor documents createRuntime spine (rulings 340/540)", () => {
    expect(effectHostDoctorPosture({}).detail).toContain("createRuntime");
    expect(effectHostDoctorPosture({}).detail).toContain("340");
    expect(effectHostDoctorPosture({}).detail).toContain("540");
    expect(effectHostDoctorPosture({}).detail).toContain("=require when the trusted Rust kernel is active");
    const fix = effectHostDoctorFixLines({});
    expect(fix.some((l) => l.includes("effectHostKernel"))).toBe(true);
    expect(fix.some((l) => l.includes("prefers =require when trusted Rust kernel"))).toBe(true);
  });

  test("doctor --fix effect.host suggests EDIT_REPAIR for dominant score rung (ruling 312)", () => {
    const off = effectHostDoctorFixLines({});
    expect(off.some((l) => l.includes("HZ_EFFECT_HOST_EDIT_REPAIR=1"))).toBe(true);
    expect(off.some((l) => l.toLowerCase().includes("dominant score"))).toBe(true);
    const on = effectHostDoctorFixLines({ HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
    expect(on.some((l) => l.includes("HZ_EFFECT_HOST_EDIT_REPAIR already"))).toBe(true);
  });

  test("prototype honesty recommends require when not on honesty gate (ruling 313)", () => {
    expect(effectHostPrototypeHonestyRecommendRequire({})).toBe(true);
    expect(effectHostPrototypeHonestyRecommendRequire({ HZ_EFFECT_HOST_KERNEL: "default" })).toBe(true);
    expect(effectHostPrototypeHonestyRecommendRequire({ HZ_EFFECT_HOST_KERNEL: "require" })).toBe(false);
    const defHint = effectHostDoctorPosture({ HZ_EFFECT_HOST_KERNEL: "default" }).hint;
    expect(defHint).toContain(EFFECT_HOST_PROTOTYPE_HONESTY_REQUIRE_DETAIL);
    expect(defHint.toLowerCase()).toContain("prototype trust spine");
    const defFix = effectHostDoctorFixLines({ HZ_EFFECT_HOST_KERNEL: "default" });
    expect(defFix.some((l) => l.includes("HZ_EFFECT_HOST_KERNEL=require"))).toBe(true);
    expect(defFix.some((l) => l.includes("301"))).toBe(true);
    expect(effectHostPrototypeHonestyDoctorHint({ HZ_EFFECT_HOST_KERNEL: "require" })).toBeUndefined();
  });

  test("doctor residual names Bun first-hit score fuzz honesty (ruling 313)", () => {
    expect(effectHostDoctorPosture({}).detail.toLowerCase()).toContain("first-hit");
    expect(effectHostDoctorPosture({ HZ_EFFECT_HOST_EDIT_REPAIR: "1" }).detail.toLowerCase()).toContain(
      "unique dominant",
    );
  });
});
