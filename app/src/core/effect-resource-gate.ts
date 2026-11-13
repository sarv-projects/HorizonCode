/**
 * effect-resource-gate.ts — reduced docs/13 R170 resource freeze (ruling 243).
 *
 * When an effect is still `unknown`, refuse another mutating tool call that
 * targets the same postimage path / resource key in the same run (`ast_edit` **317**).
 * Refusal names driving UNKNOWN effect id(s) when known. TUI inspector actions remain designed-only.
 */

import { postimagePathForTool } from "./receipt-postimage";
import type { EffectHost, EffectRecord } from "./effect-host";

const GATE_TOOLS = new Set(["write", "edit", "apply_patch", "ast_edit", "multi_edit"]);

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
      if (step.resourceKey) keys.add(step.resourceKey);
    }
  }
  return keys;
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
  const key = mutatingToolResourceKey(tool, args, workspace);
  if (!key || frozenKeys.size === 0) return undefined;
  if (!frozenKeys.has(key)) return undefined;
  const drivers = unknownEffectIdsForResourceKey(host, key);
  return (
    `HZ_PRECONDITION_FAILED: blocked_by_unknown: resource ${key} is frozen until effect reconciliation completes ` +
    `(docs/13 R170); refusing ${tool} on the same path in this run` +
    formatR170DrivingEffectHint(drivers)
  );
}
