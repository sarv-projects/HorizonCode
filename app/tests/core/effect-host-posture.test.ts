import { describe, expect, test } from "bun:test";
import {
  effectHostDoctorFixLines,
  effectHostDoctorPosture,
  effectHostKernelRequireRefusal,
  effectHostPrototypeHonestyDoctorHint,
  effectHostPrototypeHonestyRecommendRequire,
  EFFECT_HOST_KERNEL_REQUIRE_NOTICE,
  EFFECT_HOST_PROTOTYPE_HONESTY_REQUIRE_DETAIL,
} from "../../src/core/effect-host-posture";
import { effectHostKernelMode, effectHostKernelMutationEnabled, effectHostKernelRequireMode } from "../../src/core/effect-kernel-mutation-route";
import { restoreEnv, setEnv, snapshotEnv } from "./helpers";

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
      setEnv({ HZ_EFFECT_HOST_KERNEL: "require" });
      for (const tool of [
        "undo", "shell_session", "code_mode", "preview", "agent",
        "debug", "lsp", "lint", "present", "todo", "handoff_create",
        "handoff_resume", "mcp__untrusted__write", "future_custom_tool",
      ]) {
        const refusal = effectHostKernelRequireRefusal(tool, {}, false);
        expect(refusal).toContain(EFFECT_HOST_KERNEL_REQUIRE_NOTICE);
        expect(refusal).toContain(`no kernel EffectHost route for ${tool}`);
      }
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
      )?.toContain("Bun-only fuzz");
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
    expect(req.hint).not.toContain("multi-metavar");
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

  test("unset doctor documents createRuntime spine (ruling 340)", () => {
    expect(effectHostDoctorPosture({}).detail).toContain("createRuntime");
    expect(effectHostDoctorPosture({}).detail).toContain("340");
    const fix = effectHostDoctorFixLines({});
    expect(fix.some((l) => l.includes("effectHostKernel"))).toBe(true);
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
