/**
 * effect-resource-gate.ts — reduced docs/13 R170 resource freeze (ruling 243).
 *
 * When an effect is still `unknown`, refuse another mutating tool call that
 * targets the same postimage path / resource key in the same run (`ast_edit` **317**).
 * Refusal names driving UNKNOWN effect id(s) when known. TUI inspector actions remain designed-only.
 *
 * Observe-pending keys (rulings **333**; **334**): execute recorded, observe not yet — path from execute `resourceKey`.
 */

import * as path from "node:path";
import { realpathish } from "./paths";
import { postimagePathForTool } from "./receipt-postimage";
import { applyPatchKernelProjections } from "./effect-kernel-tool-projection";
import type { EffectHost, EffectRecord } from "./effect-host";

const GATE_TOOLS = new Set(["write", "edit", "apply_patch", "ast_edit", "multi_edit"]);

function workspaceBoundedPath(workspace: string, raw: string): string | undefined {
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace, raw);
  const root = path.resolve(workspace);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
  return resolved;
}

/**
 * Explicit path/cwd on `shell`/`bash` for reconcile-block overlap (ruling **336** reduced).
 * Intentionally does not infer workspace default cwd — only explicit args.
 */
export function shellExplicitResourceTarget(
  args: Record<string, unknown>,
  workspace: string,
): string | undefined {
  const rawFile =
    (typeof args.path === "string" && args.path.trim() !== "" && args.path) ||
    (typeof args.file === "string" && args.file.trim() !== "" && args.file) ||
    (typeof args.file_path === "string" && args.file_path.trim() !== "" && args.file_path) ||
    undefined;
  if (rawFile) return workspaceBoundedPath(workspace, rawFile);
  if (typeof args.cwd === "string" && args.cwd.trim() !== "") {
    return workspaceBoundedPath(workspace, args.cwd);
  }
  return undefined;
}

/** Postimage path for file mutators, or explicit shell path/cwd when present (**336**). */
export function observePendingTargetForTool(
  tool: string,
  args: Record<string, unknown>,
  workspace: string,
): string | undefined {
  const postimage = postimagePathForTool(tool, args, workspace);
  if (postimage) return postimage;
  if (tool === "shell" || tool === "bash") return shellExplicitResourceTarget(args, workspace);
  return undefined;
}

/** All workspace paths a mutation might touch, not merely the final receipt
 * postimage. An unparseable/multi-target command returns undefined (unsafe to
 * claim disjoint from a blocked resource). Rename includes source AND target. */
export function mutationResourceTargets(
  tool: string,
  args: Record<string, unknown>,
  workspace: string,
): string[] | undefined {
  // A shell command may write ANY path regardless of cwd or explicit path
  // hints; treating a declared cwd as exhaustive evidence is unsafe.
  if (tool === "shell" || tool === "bash") return undefined;
  if (tool === "apply_patch") {
    const projections = applyPatchKernelProjections(args);
    if (!projections || projections.length === 0) return undefined;
    const paths = new Set<string>();
    for (const proj of projections) {
      const raw = proj.kind === "rename" ? [proj.from, proj.to] : [proj.path];
      for (const value of raw) {
        const resolved = workspaceBoundedPath(workspace, value);
        if (!resolved) return undefined;
        paths.add(resolved);
      }
    }
    return [...paths];
  }
  const target = observePendingTargetForTool(tool, args, workspace);
  return target ? [target] : undefined;
}

export function mutatingToolResourceKey(
  tool: string,
  args: Record<string, unknown>,
  workspace: string,
): string | undefined {
  if (!GATE_TOOLS.has(tool)) return undefined;
  return postimagePathForTool(tool, args, workspace);
}

export function unknownResourceKeysFromRecords(records: Iterable<EffectRecord>): Set<string> {
  const keys = new Set<string>();
  for (const rec of records) {
    for (const step of rec.steps) {
      if (step.resourceKey) keys.add(path.resolve(step.resourceKey));
    }
  }
  return keys;
}

function resourceKeysDeclaredOnRecord(rec: EffectRecord): string[] {
  const keys = new Set<string>();
  for (const step of rec.steps) {
    if (step.resourceKey) keys.add(path.resolve(step.resourceKey));
  }
  return [...keys];
}

/** Effects with allow+execute but no observe step yet (hydrated ledger rows included). */
export function observePendingResourceKeys(host: EffectHost | undefined): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  if (!host) return byPath;
  for (const effectId of host.listEffectIds()) {
    const rec = host.getRecord(effectId);
    if (!rec) continue;
    const phases = new Set(rec.steps.map((s) => s.phase));
    if (!phases.has("execute") || phases.has("observe")) continue;
    for (const key of resourceKeysDeclaredOnRecord(rec)) {
      const list = byPath.get(key) ?? [];
      list.push(effectId);
      byPath.set(key, list);
    }
  }
  return byPath;
}

export function effectIdsWithObservePendingOnPath(
  host: EffectHost | undefined,
  resourcePath: string,
): string[] {
  const target = path.resolve(resourcePath);
  const pending = observePendingResourceKeys(host);
  const hits: string[] = [];
  for (const [key, ids] of pending) {
    if (key === target) hits.push(...ids);
  }
  return hits.sort((a, b) => a.localeCompare(b));
}

function resourcePathsOverlap(a: string, b: string): boolean {
  // Resolve existing symlink aliases before comparing. A write to alias.ts
  // must not bypass a barrier protecting the file it points at.
  const ra = realpathish(a);
  const rb = realpathish(b);
  if (ra === rb) return true;
  return ra.startsWith(rb + path.sep) || rb.startsWith(ra + path.sep);
}

/** Same-path overlap against any observe-pending resource key on the host. */
export function observePendingEffectIdsOverlappingPath(
  host: EffectHost | undefined,
  resourcePath: string,
): string[] {
  const target = path.resolve(resourcePath);
  const pending = observePendingResourceKeys(host);
  const hits: string[] = [];
  for (const [key, ids] of pending) {
    if (resourcePathsOverlap(key, target)) hits.push(...ids);
  }
  return [...new Set(hits)].sort((a, b) => a.localeCompare(b));
}

export function frozenUnknownResourceKeys(host: EffectHost | undefined): Set<string> {
  if (!host) return new Set();
  const frozen = new Set<string>();
  for (const effectId of host.listEffectIds()) {
    if (host.reconcileEffect(effectId) !== "unknown") continue;
    const rec = host.getRecord(effectId);
    if (!rec) continue;
    for (const key of unknownResourceKeysFromRecords([rec])) {
      frozen.add(key);
    }
  }
  return frozen;
}

/** Open UNKNOWN effect ids that observed the same `resourceKey` (ruling **317** reduced R170). */
export function unknownEffectIdsForResourceKey(
  host: EffectHost | undefined,
  resourceKey: string,
): string[] {
  if (!host) return [];
  const ids: string[] = [];
  for (const effectId of host.listEffectIds()) {
    if (host.reconcileEffect(effectId) !== "unknown") continue;
    const rec = host.getRecord(effectId);
    if (!rec) continue;
    for (const step of rec.steps) {
      if (step.resourceKey === resourceKey) {
        ids.push(effectId);
        break;
      }
    }
  }
  return ids.sort((a, b) => a.localeCompare(b));
}

function formatR170DrivingEffectHint(effectIds: readonly string[]): string {
  if (effectIds.length === 0) return "";
  const shown = effectIds.slice(0, 3).map((id) => (id.length > 14 ? `${id.slice(0, 13)}…` : id));
  const extra =
    effectIds.length > shown.length ? ` (+${effectIds.length - shown.length} more UNKNOWN effect(s))` : "";
  return `; driving UNKNOWN effect(s): ${shown.join(", ")}${extra}`;
}

export function r170ResourceGateRefusal(
  tool: string,
  args: Record<string, unknown>,
  workspace: string,
  frozenKeys: Set<string>,
  host?: EffectHost,
): string | undefined {
  if (!GATE_TOOLS.has(tool) || frozenKeys.size === 0) return undefined;
  const targets = mutationResourceTargets(tool, args, workspace);
  if (!targets) {
    return `HZ_PRECONDITION_FAILED: blocked_by_unknown: refusing ${tool} — ` +
      "unknown resource target cannot prove disjoint from frozen UNKNOWN effects (docs/13 R170)";
  }
  for (const target of targets) {
    for (const frozen of frozenKeys) {
      if (!resourcePathsOverlap(target, frozen)) continue;
      const drivers = unknownEffectIdsForResourceKey(host, frozen);
      return (
        `HZ_PRECONDITION_FAILED: blocked_by_unknown: resource ${frozen} is frozen until effect reconciliation completes ` +
        `(docs/13 R170); refusing ${tool} on the overlapping path ${target} in this run` +
        formatR170DrivingEffectHint(drivers)
      );
    }
  }
  return undefined;
}
