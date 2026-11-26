/**
 * EffectHost kernel-route honesty (ruling **285**) — doctor + require-mode gate.
 */

import {
  classifyShellKernelRouteMiss,
  editArgsEligibleForKernelRoute,
  effectHostKernelMode,
  shellArgsEligibleForKernelRoute,
  shellKernelRouteMissRequireDetail,
  writeArgsEligibleForKernelRoute,
} from "./effect-kernel-mutation-route";
import {
  applyPatchArgsEligibleForKernelRoute,
  applyPatchProjectionMissRequireDetail,
  astEditArgsEligibleForKernelRoute,
  astEditProjectionMissRequireDetail,
  type ApplyPatchProjectionMissReason,
  type AstEditProjectionMissReason,
} from "./effect-kernel-tool-projection";
import { effectHostEditRepairEnabled } from "./effect-host-edit-repair";
import {
  effectHostMcpInvokeAmbientRefusal,
  effectHostMcpInvokeMutatingRefusal,
} from "./effect-host-mcp-invoke";
import { isMcpToolName } from "./mcp/registry";

export {
  EFFECT_HOST_KERNEL_MCP_INVOKE_MUTATING_REFUSED_NOTICE,
  EFFECT_HOST_KERNEL_MCP_READONLY_AMBIENT_REFUSED_NOTICE,
  effectHostMcpInvokeAmbientRefusal,
  effectHostMcpInvokeMutatingRefusal,
  effectHostMcpReadOnlyStrictEnabled,
} from "./effect-host-mcp-invoke";

const APPLY_PATCH_FIRST_HIT_RESIDUAL =
  "Bun apply_patch position-ordered first-hit score fuzz when qualifying scores differ remains Bun-only under require (**685** names `bun_first_hit_score_fuzz`); kernel routes tied-equal qualifying band via first-hit tied Levenshtein when HZ_EFFECT_HOST_EDIT_REPAIR=1";

const EDIT_REPAIR_FIX_LINE =
  "export HZ_EFFECT_HOST_EDIT_REPAIR=1   # kernel fs.edit relative-indent, trim three-way, anchored unique line patch (opt-in) + apply_patch unique dominant score ≥0.97 Δ0.08 and Levenshtein ≥0.66 (first-hit score fuzz remains Bun-only)";

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

export const EFFECT_HOST_KERNEL_NO_AMBIENT_FALLBACK_NOTICE =
  "[effect-host-kernel] HZ_EFFECT_HOST_NO_AMBIENT_FALLBACK=1: refused — unrouted mutation would fall back to ambient Bun";

/** Opt-in P0-1 reduction: no silent Bun fallback when a kernel route is missed. */
export function effectHostNoAmbientFallbackEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.HZ_EFFECT_HOST_NO_AMBIENT_FALLBACK === "1" || env.HZ_EFFECT_HOST_STRICT === "1";
}

/** Opt-in Code Mode + EffectHost seam: inner `tools.call` RPCs route through EffectHost. */
export function codeModeEffectHostEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if ("HZ_CODEMODE_EFFECT_HOST" in env) {
    return env.HZ_CODEMODE_EFFECT_HOST === "1";
  }
  return process.env.HZ_CODEMODE_EFFECT_HOST === "1";
}

export function effectHostNoAmbientFallbackRefusal(
  tool: string,
  kernelRouted: boolean,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const mode = effectHostKernelMode(env);
  if (mode !== "default" && mode !== "opt-in") return undefined;
  if (!effectHostNoAmbientFallbackEnabled(env)) return undefined;
  if (kernelRouted) return undefined;
  // Mirror the require-mode boundary: only explicitly local, non-host-effect
  // tools may run ambiently. Never-routable and newly registered tools must
  // not slip through the strict default gate.
  if (REQUIRE_LOCAL_ONLY_TOOLS.has(tool)) return undefined;
  if (tool === "code_mode" && codeModeEffectHostEnabled(env)) return undefined;
  return `${EFFECT_HOST_KERNEL_NO_AMBIENT_FALLBACK_NOTICE} (${tool})`;
}

export type EffectHostDoctorPosture = {
  mode: "off" | "opt-in" | "default" | "require";
  detail: string;
  hint: string;
};

export function effectHostDoctorPosture(env: Record<string, string | undefined> = process.env): EffectHostDoctorPosture {
  const mode = effectHostKernelMode(env);
  const mcpStrictPosture =
    "read-only mcp.invoke refused under =default/=1 (**956**; HZ_EFFECT_HOST_MCP_READONLY_STRICT=0 does not restore ambient invoke)";
  const fallbackPosture = effectHostNoAmbientFallbackEnabled(env)
    ? "unrouted mutations refuse instead of Bun-fallback (HZ_EFFECT_HOST_NO_AMBIENT_FALLBACK=1)"
    : "kernel-unavailable mutations can still reach Bun under =default/=1 when the route returns no outcome (opt in with HZ_EFFECT_HOST_NO_AMBIENT_FALLBACK=1)";
  const covered =
    "kernel `effect.execute` covers eligible workspace `write` (path+content), `edit` (exact old→new, no anchors), " +
    "argv-only `shell` (no shell metachar/interpreter), one-step Add/exact-Update/Delete/exact-Move `apply_patch`, " +
    "and literal or metavar `ast_edit` (incl. variadic `$$$` when shape-eligible): one unique site via kernel fs.edit or complete one-file multi-site rewrite via one preimage-pinned atomic kernel fs.write (ruling 353); " +
    "multi-file exact Add/Update/Move/Delete `apply_patch` via reduced kernel `fs.batch` of exact `fs.write`/`fs.edit`/`fs.rename`/`fs.delete` (rulings 539, 548, 552, 553, 630, 631; not full patch parity)";
  const repairResidual = effectHostEditRepairEnabled(env)
    ? `kernel fs.edit + apply_patch projection: trim/newline + fs.edit relative-indent replacement rebase (**345**), reindented trim three-way and unique anchored line-patch (**347**) + trimEnd + per-line trim + per-line unicode-fold line-windows (**335**/**337**/**339**) + apply_patch trimEnd + per-line trim (3-way merge) + relative-indent + unicode-fold + unique line-patch anchors + unique dominant score (≥0.97, Δ0.08) + unique max-score Levenshtein (≥0.66) when \`HZ_EFFECT_HOST_EDIT_REPAIR=1\`; ${APPLY_PATCH_FIRST_HIT_RESIDUAL}`
    : `kernel repair + apply_patch trim/indent/fold/Levenshtein rungs off unless \`HZ_EFFECT_HOST_EDIT_REPAIR=1\`; fuzz-needed patches stay Bun-owned at kernel route; ${APPLY_PATCH_FIRST_HIT_RESIDUAL}`;
  const shellResidual =
    "shell: argv-only simple commands may kernel-route via hz-sandbox-exec when helper resolves (**675**); `HZ_SANDBOX_REQUIRE=1`/`HZ_SHELL_EXEC_REQUIRE_WRAP=1` refuse bare kernel argv when helper missing (**732** — doctor `kernel.shell.exec`); compound/interpreter/metachar refused when EffectHost on (**652**); `timeoutMs` shell refused under `=default`/`=1` (**957**); an unrouted simple shell and a thrown kernel error are final under `=default`/`=1` (**958**); reduced OwnerLog postimages `rm`/`rm -f`/`touch`/`mkdir -p`/`cp`/`mv` (**669**/**686**/**961**); `arbitrary_fs`, `likely_net`, and `unknown` argv refused before spawn (**967**/**968**); reduced shell paths that resolve outside the sandbox, including a symlink, are refused before spawn (**969**); reduced `cp` is copied in-kernel with `O_NOFOLLOW` so a destination swapped to a symlink after the preflight is not followed (**970**); `mv`/`install`/`touch`/`rm` still spawn; never shell-net enforced";
  const multiChunkResidual =
    "apply_patch residual: a same-file exact multi-hunk Update can collapse into ONE preimage-pinned atomic kernel fs.write (ruling **353**); " +
    "multi-file exact Add/Update/Move/Delete plans route via reduced kernel `fs.batch` under one OwnerLog lock (rulings 539, 548, 552, 553, 630, 631 — not full patch parity); " +
    "fuzzy/ambiguous plans still refuse BEFORE any mutation (ruling **349**); " +
    "ambiguous context / below-threshold or tied Levenshtein chunks remain Bun-owned if the user explicitly permits ambient mode; " +
    "single-step unique exact/EOF-anchored chunk → one kernel fs.edit when on-disk bytes resolve";
  const shapeMutationResidual =
    "write/edit/apply_patch/ast_edit: shape-ineligible args refused when EffectHost is on (`=1`/`=default`/`=require`) — no ambient Bun fallback (**667**/**937**); untrusted write/edit/apply_patch refused under `=default`/`=1` (**953**); Bun-only fuzz with a trusted kernel still Bun under non-require";
  const ambientResidual =
    "ambient residual: never-routable tools (`code_mode`, preview, agent, shell_session, …) refused when EffectHost is on (`=1`/`=default`/`=require`) before Guard (**649**/**653**); mutating `mcp.invoke` refused under EffectHost-on — not kernel OwnerLog-admitted (**721**); read-only mcp.invoke refused under `=default`/`=1` even if HZ_EFFECT_HOST_MCP_READONLY_STRICT=0 (**956**; still not OwnerLog-admitted); MCP stdio server spawn/reconnect refused under EffectHost-on (**702**); `undo` kernel-routes (**650**); user hooks suppressed whenever EffectHost is on (**651**/**666**); compound/interpreter shell refused when EffectHost is on (**652**); mixed-score first-hit fuzz refused under require (**687**); hooks not kernel-OwnerLog-admitted";
  const astResidual =
    "ast_edit residual: shape-ineligible args refuse under `=default`/`=1` (**937**); variadic `$$$` kernel-routes only when rewriteMatches unique-projects to one old→new; " +
    "unrouted shape-eligible ast_edit (projection miss or kernel-unavailable unique/multi plan) refuses under `=default`/`=1` (**945**/**952**) — no ambient Bun rewrite; " +
    "multi-match / lexer / truncation projection misses are also refused under `=require` with named reason (**322**)";
  const residual =
    `Bun still owns write/edit/shell when unset; ${multiChunkResidual}; ${astResidual}; ${shellResidual}; ` +
    `${shapeMutationResidual}; ${ambientResidual}; kernel routes Delete/Move (exact single-chunk and multi-file batch) when routed; ${repairResidual}`;
  const runtimeSpineNote =
    "createRuntime on Linux may set =require when the trusted Rust kernel is active (**540**), else =default when sandbox wrap is active, or honor user config `effectHostKernel` / autonomy=regulated (**340**/**630** — doctor still reports off here without export/probe); " +
    "may default HZ_SANDBOX_NETNS=1 when userns/netns/CAP probe ok (**672** — product CREATE advisory only; TLS MITM E2E OPEN; never shell-net enforced); not full EffectHost";
  if (mode === "off") {
    return {
      mode: "off",
      detail: `HZ_EFFECT_HOST_KERNEL unset: ${residual}; ${runtimeSpineNote}`,
      hint:
        "prototype: export HZ_EFFECT_HOST_KERNEL=default (routes like =1; falls back when ineligible); " +
        "honesty gate: HZ_EFFECT_HOST_KERNEL=require refuses Bun-owned mutations — run `hzcode doctor --fix effect.host`",
    };
  }
  if (mode === "require") {
    return {
      mode: "require",
      detail: `HZ_EFFECT_HOST_KERNEL=require: fail-closed honesty gate — ${covered}; undo kernel-routes (**650**); user hooks suppressed (**651**); never-routable tools (code_mode/MCP/preview/agent/…) refused (**649**/**653**)`,
      hint: `${residual}; loop refuses write/edit/shell/code_mode that cannot reach kernel`,
    };
  }
  if (mode === "default") {
    const honestyHint = effectHostPrototypeHonestyDoctorHint(env);
    return {
      mode: "default",
      detail:
        `HZ_EFFECT_HOST_KERNEL=default: recommended prototype posture — routes ${covered}; ` +
        "never-routable ambient tools refused (**653**); mutating mcp.invoke refused (**721**); MCP stdio spawn refused (**702**); compound/interpreter shell refused (**652**); " +
        "shape-ineligible write/edit/apply_patch/ast_edit refused (**667**/**937**); unrouted shape-eligible ast_edit refused (**952**); untrusted write/edit/apply_patch refused instead of ambient Bun (**953**); untrusted shell refused (**954**); untrusted undo refused (**955**); user hooks suppressed (**666**); mixed-score apply_patch does not Bun-apply (**966**); " +
        `${mcpStrictPosture}; ${fallbackPosture}; ` +
        shellResidual,
      hint: honestyHint
        ? `${honestyHint}; ambient fallback residual: ${multiChunkResidual}`
        : `use =require for fail-closed honesty gate; ${multiChunkResidual}`,
    };
  }
  return {
    mode: "opt-in",
    detail: `HZ_EFFECT_HOST_KERNEL=1: opt-in routes ${covered}; shape-ineligible write/edit/apply_patch/ast_edit refused (**667**/**937**); unrouted shape-eligible ast_edit refused (**952**); untrusted write/edit/apply_patch refused (**953**); untrusted shell refused (**954**); untrusted undo refused (**955**); user hooks suppressed (**666**); ${mcpStrictPosture}; mixed-score apply_patch does not Bun-apply (**966**); an unprojected patch still falls back to Bun`,
    hint: residual,
  };
}

/** Read-only fix lines for `hzcode doctor --fix <id>` (ruling **299**). */
function strictPostureFixLines(env: Record<string, string | undefined>): string[] {
  return [
    "# read-only mcp.invoke already refused under =default/=1 (**956**); HZ_EFFECT_HOST_MCP_READONLY_STRICT=0 does not restore it",
    "export HZ_EFFECT_HOST_NO_AMBIENT_FALLBACK=1  # refuse unrouted mutations/never-routable tools instead of Bun fallback (P0-1)",
    ...(env.HZ_R172_REQUIRE_KEYED === "1" ? ["HZ_R172_REQUIRE_KEYED=1 already set (strict keyed receipt verification)"] : []),
  ];
}

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
      ...strictPostureFixLines(env),
    ];
  }
  return [
    "# EffectHost kernel-route (diagnose-only — export in your shell or service unit)",
    'export HZ_EFFECT_HOST_KERNEL=default   # prototype: route eligible write/edit/shell/apply_patch/ast_edit like =1',
    'export HZ_EFFECT_HOST_KERNEL=require   # prototype trust spine: fail-closed + auto postimage replay at verify (301)',
    "# createRuntime on Linux prefers =require when trusted Rust kernel is active and env unset (**540**); sandbox wrap alone may still project =default",
    '# Or persist in ~/.config/horizon/config.json: "effectHostKernel": "default" or "require" (createRuntime when env unset)',
    ...repairFix,
  ];
}

const REQUIRE_MUTATION_TOOLS = new Set([
  "write",
  "edit",
  "shell",
  "apply_patch",
  "ast_edit",
  "undo", // ruling **650** — kernel fs.write/fs.delete restore
]);
// Strict mode must not turn a newly registered tool (or an MCP tool of unknown
// effect class) into an ambient execution bypass. These are the explicitly
// admitted local, non-host-effect operations; everything else needs a kernel
// execute route or is refused until one is implemented.
const REQUIRE_LOCAL_ONLY_TOOLS = new Set([
  "read", "grep", "glob", "repo_map", "ast_search", "memory_search",
  "handoff_search", "tool_search", "git_status", "git_diff", "git_log", "git_blame",
  "ctx_inspect", "history_snip_preview", "verified_open",
]);

export const EFFECT_HOST_KERNEL_REQUIRE_NOTICE =
  "[effect-host-kernel] HZ_EFFECT_HOST_KERNEL=require: refused — mutation not routed through kernel";

/** Notice when user hooks are skipped under `=require` (ruling **651**). */
export const EFFECT_HOST_KERNEL_REQUIRE_HOOKS_SUPPRESSED_NOTICE =
  "[effect-host-kernel] HZ_EFFECT_HOST_KERNEL=require: user hooks suppressed — Bun hook spawns are ambient until kernel-routed";

/** Notice when user hooks are skipped under `=default`/`=1` (ruling **666**). */
export const EFFECT_HOST_KERNEL_ON_HOOKS_SUPPRESSED_NOTICE =
  "[effect-host-kernel] HZ_EFFECT_HOST_KERNEL on: user hooks suppressed — Bun hook spawns are ambient until kernel-routed";

export const EFFECT_HOST_KERNEL_NO_AMBIENT_TOOL_NOTICE =
  "[effect-host-kernel] HZ_EFFECT_HOST_KERNEL on: refused — no kernel EffectHost route";

/** Notice when MCP stdio server spawn/reconnect is blocked under EffectHost-on (ruling **702**). */
export const EFFECT_HOST_KERNEL_MCP_SPAWN_REFUSED_NOTICE =
  "[effect-host-kernel] HZ_EFFECT_HOST_KERNEL on: refused — MCP server spawn is ambient until kernel-routed";

/**
 * Fail-closed MCP server child spawn when EffectHost kernel spine is active
 * (`=1` / `=default` / `=require`). Mutating tool invokes are refused (**721**);
 * this closes ambient `spawnOwned` connect/reconnect paths.
 */
export function effectHostMcpAmbientSpawnRefusal(
  serverId: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const mode = effectHostKernelMode(env);
  if (mode === "off") return undefined;
  return `${EFFECT_HOST_KERNEL_MCP_SPAWN_REFUSED_NOTICE} (mcp server ${serverId})`;
}

/**
 * P0-1 / ruling **653**: under `=default`/`=1`, refuse tools that can never
 * kernel-route (preview/agent/code_mode/MCP/shell_session/…) before Guard/hooks
 * — same never-routable set as require (**649**); shape-ineligible write/edit/
 * apply_patch refusal under =default/=1 is **667** (not here).
 */
export function effectHostNoAmbientToolPreflight(
  tool: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const mode = effectHostKernelMode(env);
  if (mode !== "default" && mode !== "opt-in") return undefined;
  if (REQUIRE_LOCAL_ONLY_TOOLS.has(tool)) return undefined;
  if (tool === "todo" || tool === "todo_write") {
    if (env.HZ_TODO_DURABLE === "1" || process.env.HZ_TODO_DURABLE === "1") {
      return `${EFFECT_HOST_KERNEL_NO_AMBIENT_TOOL_NOTICE} for durable todo`;
    }
    return undefined;
  }
  if (tool === "present") return undefined;
  if (tool === "code_mode" && codeModeEffectHostEnabled(env)) return undefined;
  if (REQUIRE_MUTATION_TOOLS.has(tool)) return undefined;
  const mcpMutating = effectHostMcpInvokeMutatingRefusal(tool, env);
  if (mcpMutating !== undefined) return mcpMutating;
  const mcpAmbient = effectHostMcpInvokeAmbientRefusal(tool, env);
  if (mcpAmbient !== undefined) return mcpAmbient;
  if (isMcpToolName(tool)) return undefined;
  return `${EFFECT_HOST_KERNEL_NO_AMBIENT_TOOL_NOTICE} for ${tool}`;
}

/**
 * P0-1 / rulings **651** + **666**: whenever EffectHost is on (`=require`,
 * `=default`, or `=1`), do not spawn user hooks (deciding or observation).
 * Bun hook children are ambient until a kernel route exists.
 * Returns `{state:"none"}` when suppression applies.
 */
export function effectHostRequireSuppressHooks<T extends { state: string }>(
  hooks: T,
  env: Record<string, string | undefined> = process.env,
): { hooks: T | { state: "none" }; suppressed: boolean } {
  const mode = effectHostKernelMode(env);
  if (mode !== "require" && mode !== "default" && mode !== "opt-in") {
    return { hooks, suppressed: false };
  }
  if (hooks.state === "none") return { hooks, suppressed: false };
  return { hooks: { state: "none" }, suppressed: true };
}

/** Notice string for the active EffectHost mode after hooks suppress. */
export function effectHostHooksSuppressedNotice(
  env: Record<string, string | undefined> = process.env,
): string {
  return effectHostKernelMode(env) === "require"
    ? EFFECT_HOST_KERNEL_REQUIRE_HOOKS_SUPPRESSED_NOTICE
    : EFFECT_HOST_KERNEL_ON_HOOKS_SUPPRESSED_NOTICE;
}

/**
 * Early `=require` gate (ruling **649**): refuse ambient / shape-ineligible tools
 * BEFORE Guard ask and pre-tool hooks so a hook cannot side-effect a path that
 * will never kernel-route. Eligible write/edit/shell/apply_patch/ast_edit defer
 * to the post-route `effectHostKernelRequireRefusal` (needs kernel attempt or
 * on-disk projection classify for Bun-only fuzz).
 */
export function effectHostKernelRequirePreflight(
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (effectHostKernelMode() !== "require") return undefined;
  if (REQUIRE_LOCAL_ONLY_TOOLS.has(tool)) return undefined;
  if (tool === "todo" || tool === "todo_write") {
    if (process.env.HZ_TODO_DURABLE === "1") {
      return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (no kernel EffectHost route for durable todo)`;
    }
    return undefined;
  }
  if (tool === "present") return undefined;
  if (tool === "code_mode" && codeModeEffectHostEnabled()) return undefined;
  const mcpMutatingPreflight = effectHostMcpInvokeMutatingRefusal(tool);
  if (mcpMutatingPreflight !== undefined) return mcpMutatingPreflight;
  if (isMcpToolName(tool)) {
    return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (no kernel EffectHost route for read-only ${tool})`;
  }
  if (!REQUIRE_MUTATION_TOOLS.has(tool)) {
    return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (no kernel EffectHost route for ${tool})`;
  }
  if (tool === "write" && !writeArgsEligibleForKernelRoute(args)) {
    return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (write args ineligible for kernel fs.write)`;
  }
  if (tool === "edit" && !editArgsEligibleForKernelRoute(args)) {
    return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (edit args ineligible for kernel fs.edit)`;
  }
  if (tool === "shell") {
    const command = typeof args.command === "string" ? args.command : "";
    const miss = classifyShellKernelRouteMiss(command, { timeoutMs: args.timeoutMs });
    if (miss !== undefined) {
      return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (${shellKernelRouteMissRequireDetail(miss)})`;
    }
    if (!shellArgsEligibleForKernelRoute(args)) {
      return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (shell command cannot kernel-route under require)`;
    }
    return undefined;
  }
  if (tool === "apply_patch" && !applyPatchArgsEligibleForKernelRoute(args)) {
    return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (${applyPatchProjectionMissRequireDetail("shape_ineligible")})`;
  }
  if (tool === "ast_edit" && !astEditArgsEligibleForKernelRoute(args)) {
    return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (${astEditProjectionMissRequireDetail("shape_ineligible")})`;
  }
  return undefined;
}

/**
 * When mode is `require`, returns a user-visible refusal reason or undefined if
 * the tool may proceed (non-mutation or kernel route already succeeded).
 */
export function effectHostKernelRequireRefusal(
  tool: string,
  args: Record<string, unknown>,
  kernelRouted: boolean,
  opts?: {
    astEditProjectionMiss?: AstEditProjectionMissReason;
    applyPatchProjectionMiss?: ApplyPatchProjectionMissReason;
  },
): string | undefined {
  if (effectHostKernelMode() !== "require") return undefined;
  if (REQUIRE_LOCAL_ONLY_TOOLS.has(tool)) return undefined;
  // Session-only checklist / deliverables: allowed. Durable todo disk writes are
  // not kernel-routed — refuse under require when HZ_TODO_DURABLE=1.
  if (tool === "todo" || tool === "todo_write") {
    if (process.env.HZ_TODO_DURABLE === "1") {
      return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (no kernel EffectHost route for durable todo)`;
    }
    return undefined;
  }
  if (tool === "present") return undefined;
  if (tool === "code_mode" && codeModeEffectHostEnabled()) return undefined;
  const mcpMutatingPost = effectHostMcpInvokeMutatingRefusal(tool);
  if (mcpMutatingPost !== undefined) return mcpMutatingPost;
  if (isMcpToolName(tool)) {
    return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (no kernel EffectHost route for read-only ${tool})`;
  }
  // New or dynamically contributed tools are effectful until proven otherwise.
  // In particular shell_session, code_mode, preview, MCP and agent must
  // not acquire ambient Bun execution merely by avoiding the routed names.
  if (!REQUIRE_MUTATION_TOOLS.has(tool)) {
    return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (no kernel EffectHost route for ${tool})`;
  }
  if (kernelRouted) return undefined;
  if (tool === "apply_patch") {
    if (opts?.applyPatchProjectionMiss) {
      return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (${applyPatchProjectionMissRequireDetail(opts.applyPatchProjectionMiss)})`;
    }
    if (!applyPatchArgsEligibleForKernelRoute(args)) {
      return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (${applyPatchProjectionMissRequireDetail("shape_ineligible")})`;
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
    const command = typeof args.command === "string" ? args.command : "";
    const miss = classifyShellKernelRouteMiss(command, { timeoutMs: args.timeoutMs });
    if (miss !== undefined) {
      return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (${shellKernelRouteMissRequireDetail(miss)})`;
    }
    if (!shellArgsEligibleForKernelRoute(args)) {
      return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (shell command cannot kernel-route under require)`;
    }
    return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (kernel shell.exec route unavailable)`;
  }
  if (tool === "undo") {
    return `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} (kernel undo route unavailable)`;
  }
  return undefined;
}
