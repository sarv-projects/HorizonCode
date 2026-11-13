/**
 * EffectHost kernel-route honesty (ruling **285**) — doctor + require-mode gate.
 */

import {
  editArgsEligibleForKernelRoute,
  effectHostKernelMode,
  shellArgsEligibleForKernelRoute,
  writeArgsEligibleForKernelRoute,
} from "./effect-kernel-mutation-route";
import {
  applyPatchArgsEligibleForKernelRoute,
  astEditArgsEligibleForKernelRoute,
  astEditProjectionMissRequireDetail,
  type AstEditProjectionMissReason,
} from "./effect-kernel-tool-projection";
import { effectHostEditRepairEnabled } from "./effect-host-edit-repair";

const APPLY_PATCH_FIRST_HIT_RESIDUAL =
  "Bun apply_patch position-ordered first-hit Levenshtein/score fuzz is intentionally Bun-only (kernel uses unique dominant / unique max-score, not first-hit)";

const EDIT_REPAIR_FIX_LINE =
  "export HZ_EFFECT_HOST_EDIT_REPAIR=1   # kernel apply_patch fuzzy rungs (dominant score ≥0.97 Δ0.08, unique Levenshtein ≥0.66; first-hit score fuzz stays Bun-only)";

/** Prototype trust spine — recommend require when not already on honesty gate (ruling **313**). */
export const EFFECT_HOST_PROTOTYPE_HONESTY_REQUIRE_DETAIL =
  "prototype trust spine: HZ_EFFECT_HOST_KERNEL=require refuses Bun-owned mutations that cannot kernel-route; " +
  "HZ_VERIFY_POSTIMAGE_REPLAY auto-enables at session verify when require is set (ruling **301**) — not full Rust observe for all tools";

export function effectHostPrototypeHonestyRecommendRequire(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const mode = effectHostKernelMode(env);
  return mode !== "require";
}

export function effectHostPrototypeHonestyDoctorHint(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!effectHostPrototypeHonestyRecommendRequire(env)) return undefined;
  return `${EFFECT_HOST_PROTOTYPE_HONESTY_REQUIRE_DETAIL}; run hzcode doctor --fix effect.host`;
}

function effectHostEditRepairFixLines(
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (effectHostEditRepairEnabled(env)) {
    return ["HZ_EFFECT_HOST_EDIT_REPAIR already enables kernel apply_patch fuzzy rungs (incl. dominant score)"];
  }
  return [EDIT_REPAIR_FIX_LINE];
}

export type EffectHostDoctorPosture = {
  mode: "off" | "opt-in" | "default" | "require";
  detail: string;
  hint: string;
};

export function effectHostDoctorPosture(env: Record<string, string | undefined> = process.env): EffectHostDoctorPosture {
  const mode = effectHostKernelMode(env);
  const covered =
    "kernel `effect.execute` covers eligible workspace `write` (path+content), `edit` (exact old→new, no anchors), " +
    "argv-only `shell` (no shell metachar/interpreter), sequential Add/exact-Update/Delete/exact-Move `apply_patch`, " +
    "and literal or metavar `ast_edit` (incl. variadic `$$$` when shape-eligible) when rewriteMatches yields one exact old→new (kernel fs.edit)";
  const repairResidual = effectHostEditRepairEnabled(env)
    ? `kernel fs.edit + apply_patch projection: trim/newline + apply_patch trimEnd + per-line trim (3-way merge) + relative-indent + unicode-fold + unique line-patch anchors + unique dominant score (≥0.97, Δ0.08) + unique max-score Levenshtein (≥0.66) when \`HZ_EFFECT_HOST_EDIT_REPAIR=1\`; ${APPLY_PATCH_FIRST_HIT_RESIDUAL}`
    : `kernel repair + apply_patch trim/indent/fold/Levenshtein rungs off unless \`HZ_EFFECT_HOST_EDIT_REPAIR=1\`; fuzz-needed patches stay Bun-owned at kernel route; ${APPLY_PATCH_FIRST_HIT_RESIDUAL}`;
  const shellResidual =
    "shell: argv-only simple commands may kernel-route; compound/interpreter shell strings cannot — under `=require` they are refused; under `=default`/`=1` they fall back to ambient Bun `shell` (not hermetic kernel `shell.exec`)";
  const multiChunkResidual =
    "apply_patch Update residual: cross-file / ambiguous context / below-threshold or tied Levenshtein chunks stay Bun-owned; " +
    "single-file EOF-anchored exact chunk → kernel fs.edit when unique on-disk match (**300** reduced); " +
    "same-file sequential exact-chunk multi-Update → ordered kernel fs.edit when on-disk bytes resolve";
  const astResidual =
    "ast_edit residual: variadic `$$$` kernel-routes only when rewriteMatches unique-projects to one old→new; " +
    "multi-match / lexer / truncation refused under `=require` with named reason (**322**); Bun-owned under default/=1";
  const residual =
    `Bun still owns write/edit/shell when unset; ${multiChunkResidual}; ${astResidual}; ${shellResidual}; ` +
    `kernel routes Delete/Move (exact single-chunk) when routed; ${repairResidual}`;
  if (mode === "off") {
    return {
      mode: "off",
      detail: `HZ_EFFECT_HOST_KERNEL unset: ${residual}`,
      hint:
        "prototype: export HZ_EFFECT_HOST_KERNEL=default (routes like =1; falls back when ineligible); " +
        "honesty gate: HZ_EFFECT_HOST_KERNEL=require refuses Bun-owned mutations — run `hzcode doctor --fix effect.host`",
    };
  }
  if (mode === "require") {
    return {
      mode: "require",
      detail: `HZ_EFFECT_HOST_KERNEL=require: fail-closed honesty gate — ${covered}; other mutating tools refused`,
      hint: `${residual}; loop refuses write/edit/shell that cannot reach kernel`,
    };
  }
  if (mode === "default") {
    const honestyHint = effectHostPrototypeHonestyDoctorHint(env);
    return {
      mode: "default",
      detail:
        `HZ_EFFECT_HOST_KERNEL=default: recommended prototype posture — routes ${covered}; ` +
        "falls back to ambient Bun tools when ineligible or kernel unavailable (same as =1; does not flip silent production default); " +
        shellResidual,
      hint: honestyHint
        ? `${honestyHint}; ambient fallback residual: ${multiChunkResidual}`
        : `use =require for fail-closed honesty gate; ${multiChunkResidual}`,
    };
  }
  return {
    mode: "opt-in",
    detail: `HZ_EFFECT_HOST_KERNEL=1: opt-in routes ${covered}; falls back to Bun when ineligible or kernel unavailable`,
    hint: residual,
  };
}

/** Read-only fix lines for `hzcode doctor --fix <id>` (ruling **299**). */
export function effectHostDoctorFixLines(env: Record<string, string | undefined> = process.env): string[] {
  const mode = effectHostKernelMode(env);
  const repairFix = effectHostEditRepairFixLines(env);
  if (mode === "require") {
    return [
      "HZ_EFFECT_HOST_KERNEL=require already set (honesty gate — eligible mutations must kernel-route)",
      ...repairFix,
    ];
  }
  if (mode === "default" || mode === "opt-in") {
    return [
      "HZ_EFFECT_HOST_KERNEL already enables kernel-route (prototype posture)",
      "export HZ_EFFECT_HOST_KERNEL=require   # prototype trust spine: fail-closed + auto postimage replay at verify (301)",
      ...repairFix,
    ];
  }
  return [
    "# EffectHost kernel-route (diagnose-only — export in your shell or service unit)",
    "export HZ_EFFECT_HOST_KERNEL=default   # prototype: route eligible write/edit/shell/apply_patch/ast_edit like =1",
    "export HZ_EFFECT_HOST_KERNEL=require   # prototype trust spine: fail-closed + auto postimage replay at verify (301)",
    ...repairFix,
  ];
}

const REQUIRE_MUTATION_TOOLS = new Set(["write", "edit", "shell", "apply_patch", "ast_edit"]);

export const EFFECT_HOST_KERNEL_REQUIRE_NOTICE =
  "[effect-host-kernel] HZ_EFFECT_HOST_KERNEL=require: refused — mutation not routed through kernel";

/**
 * When mode is `require`, returns a user-visible refusal reason or undefined if
 * the tool may proceed (non-mutation or kernel route already succeeded).
 */
export function effectHostKernelRequireRefusal(
  tool: string,
  args: Record<string, unknown>,
  kernelRouted: boolean,
  opts?: { astEditProjectionMiss?: AstEditProjectionMissReason },
): string | undefined {
  if (effectHostKernelMode() !== "require") return undefined;
  if (!REQUIRE_MUTATION_TOOLS.has(tool)) return undefined;
  if (kernelRouted) return undefined;
  if (tool === "apply_patch") {
    if (!applyPatchArgsEligibleForKernelRoute(args)) {
      return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (apply_patch not sequential Add/exact-Update/Delete/Move kernel-eligible)`;
    }
    return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (kernel apply_patch projection unavailable)`;
  }
  if (tool === "ast_edit") {
    if (opts?.astEditProjectionMiss) {
      return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (${astEditProjectionMissRequireDetail(opts.astEditProjectionMiss)})`;
    }
    if (!astEditArgsEligibleForKernelRoute(args)) {
      return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (${astEditProjectionMissRequireDetail("shape_ineligible")})`;
    }
    return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (kernel ast_edit projection unavailable)`;
  }
  if (tool === "write") {
    if (!writeArgsEligibleForKernelRoute(args)) {
      return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (write args ineligible for kernel fs.write)`;
    }
    return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (kernel fs.write route unavailable)`;
  }
  if (tool === "edit") {
    if (!editArgsEligibleForKernelRoute(args)) {
      return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (edit args ineligible for kernel fs.edit)`;
    }
    return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (kernel fs.edit route unavailable)`;
  }
  if (tool === "shell") {
    if (!shellArgsEligibleForKernelRoute(args)) {
      return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (compound/interpreter shell command cannot kernel-route — ambient Bun shell refused under require)`;
    }
    return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (kernel shell.exec route unavailable)`;
  }
  return undefined;
}
