/**
 * Opt-in blocking gate when reconcile probe / unpaired ledger / UNKNOWN is open (ruling **293**, **303**, **304**).
 *
 * Reduced precursor to docs/13 R170 full protocol: `=1` session latch; `=resource` blocks only
 * mutating tools whose postimage path overlaps paths extracted from mismatched/UNKNOWN effects
 * (see `effect-resource-gate.ts` for in-run same-path freeze).
 */

import * as path from "node:path";
import type { EffectHost, EffectRecord } from "./effect-host";
import { loadEffectLedger } from "./effect-ledger";
import { formatEffectReconcileProbeSummary, probeEffectReconcile } from "./effect-reconcile-probe";
import { resourceKeyFromEffectRecord } from "./effect-reconcile-probe-io";
import { postimagePathForTool } from "./receipt-postimage";
import {
  formatUnpairedSessionKernelNotice,
  reconcileSessionKernel,
} from "./session-kernel-reconcile";

export type EffectReconcileBlockMode = "off" | "session" | "resource";

export const EFFECT_RECONCILE_BLOCK_SESSION_NOTICE =
  "[effect-reconcile-block] HZ_EFFECT_RECONCILE_BLOCK=1: mutating tools blocked until reconcile clears";

export const EFFECT_RECONCILE_BLOCK_RESOURCE_NOTICE =
  "[effect-reconcile-block] HZ_EFFECT_RECONCILE_BLOCK=resource: mutating tools blocked on reconciled-resource path(s)";

/** @deprecated Use mode-specific notices; kept for test substring stability. */
export const EFFECT_RECONCILE_BLOCK_NOTICE = EFFECT_RECONCILE_BLOCK_SESSION_NOTICE;

const BLOCKED_MUTATION_TOOLS = new Set([
  "write",
  "edit",
  "shell",
  "apply_patch",
  "ast_edit",
  "multi_edit",
  "undo",
]);

type ReconcileBlockLatch = { reason: string; latchedAt: number; blockedPaths: string[] };

const latches = new Map<string, ReconcileBlockLatch>();

function latchKey(workspace: string, sessionId: string): string {
  return `${workspace}\0${sessionId}`;
}

export function effectReconcileBlockMode(
  env: Record<string, string | undefined> = process.env,
): EffectReconcileBlockMode {
  const raw = env.HZ_EFFECT_RECONCILE_BLOCK?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false" || raw === "off" || raw === "no") return "off";
  if (raw === "resource") return "resource";
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "session") return "session";
  return "off";
}

export function effectReconcileBlockEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return effectReconcileBlockMode(env) !== "off";
}

export function effectReconcileBlockDoctorHint(
  env: Record<string, string | undefined> = process.env,
): string {
  const mode = effectReconcileBlockMode(env);
  if (mode === "off") {
    return "HZ_EFFECT_RECONCILE_BLOCK unset: optional session (`=1`) or per-resource (`=resource`) mutating-tool gate after reconcile mismatch";
  }
  if (mode === "resource") {
    return "HZ_EFFECT_RECONCILE_BLOCK=resource: path-filtered mutating-tool gate (reduced R170; status chip + /unknown status wire **304**)";
  }
  return "HZ_EFFECT_RECONCILE_BLOCK=1: session-wide mutating-tool gate until /unknown reconcile (status chip + /unknown status; reduced vs full R170)";
}

function reconcileBlockNoticePrefix(mode: EffectReconcileBlockMode): string {
  return mode === "resource" ? EFFECT_RECONCILE_BLOCK_RESOURCE_NOTICE : EFFECT_RECONCILE_BLOCK_SESSION_NOTICE;
}

function resourcePathsOverlap(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (ra === rb) return true;
  return ra.startsWith(rb + path.sep) || rb.startsWith(ra + path.sep);
}

function recordForEffectId(
  effectId: string,
  host: Pick<EffectHost, "getRecord"> | undefined,
  ledgerRecords: EffectRecord[],
): EffectRecord | undefined {
  const fromHost = host?.getRecord(effectId);
  if (fromHost) return fromHost;
  return ledgerRecords.find((r) => r.effectId === effectId);
}

/** Paths from probe mismatches and open UNKNOWN rows when assess can resolve `resourceKey`. */
type ReconcileBlockHostPeek = Pick<EffectHost, "getRecord" | "listEffectIds"> &
  Partial<Pick<EffectHost, "reconcileEffect">>;

export function reconcileBlockResourcePaths(
  workspace: string,
  sessionId: string,
  host?: ReconcileBlockHostPeek,
): string[] {
  const { records } = loadEffectLedger(workspace);
  const paths = new Set<string>();
  const addFromRecord = (rec: ReturnType<EffectHost["getRecord"]>) => {
    const key = resourceKeyFromEffectRecord(rec);
    if (key) paths.add(path.resolve(key));
  };

  const probe = probeEffectReconcile(workspace, {
    sessionId,
    effectHost: host ? { getRecord: (id) => host.getRecord(id), listEffectIds: () => host.listEffectIds() } : undefined,
  });
  for (const m of probe.mismatches) {
    addFromRecord(recordForEffectId(m.effectId, host, records));
  }

  const counted = new Set<string>();
  if (host) {
    for (const effectId of host.listEffectIds()) {
      if (host.reconcileEffect(effectId) !== "unknown") continue;
      counted.add(effectId);
      addFromRecord(host.getRecord(effectId));
    }
  }
  const { verdicts } = loadEffectLedger(workspace);
  for (const row of records) {
    if (counted.has(row.effectId)) continue;
    if (verdicts.get(row.effectId) !== "unknown") continue;
    addFromRecord(row);
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

export type ReconcileBlockResourceDependency = {
  resourcePath: string;
  effectId: string;
  /** Plain dependency reason (probe mismatch kind or open UNKNOWN). */
  because: string;
};

function addDependency(
  deps: ReconcileBlockResourceDependency[],
  seen: Set<string>,
  resourcePath: string | undefined,
  effectId: string,
  because: string,
): void {
  if (!resourcePath) return;
  const resolved = path.resolve(resourcePath);
  const key = `${resolved}\0${effectId}\0${because}`;
  if (seen.has(key)) return;
  seen.add(key);
  deps.push({ resourcePath: resolved, effectId, because });
}

/** Per-resource latch drivers for reduced R170 explainability (ruling **316**). */
export function reconcileBlockResourceDependencies(
  workspace: string,
  sessionId: string,
  host?: ReconcileBlockHostPeek,
): ReconcileBlockResourceDependency[] {
  const { records } = loadEffectLedger(workspace);
  const deps: ReconcileBlockResourceDependency[] = [];
  const seen = new Set<string>();

  const probe = probeEffectReconcile(workspace, {
    sessionId,
    effectHost: host ? { getRecord: (id) => host.getRecord(id), listEffectIds: () => host.listEffectIds() } : undefined,
  });
  for (const m of probe.mismatches) {
    const rec = recordForEffectId(m.effectId, host, records);
    const key = resourceKeyFromEffectRecord(rec);
    addDependency(deps, seen, key, m.effectId, `probe mismatch (${m.kind})`);
  }

  const counted = new Set<string>();
  if (host?.reconcileEffect) {
    for (const effectId of host.listEffectIds()) {
      if (host.reconcileEffect(effectId) !== "unknown") continue;
      counted.add(effectId);
      const rec = host.getRecord(effectId);
      const key = resourceKeyFromEffectRecord(rec);
      addDependency(deps, seen, key, effectId, "open UNKNOWN (session reconcile)");
    }
  }
  const { verdicts } = loadEffectLedger(workspace);
  for (const row of records) {
    if (counted.has(row.effectId)) continue;
    if (verdicts.get(row.effectId) !== "unknown") continue;
    const key = resourceKeyFromEffectRecord(row);
    addDependency(deps, seen, key, row.effectId, "open UNKNOWN (durable ledger)");
  }

  return deps.sort((a, b) => a.resourcePath.localeCompare(b.resourcePath) || a.effectId.localeCompare(b.effectId));
}

/** Lines for `/unknown status`, release refusal, and inset banner (ruling **316**). */
export function formatReconcileBlockResourceDependencyLines(
  deps: readonly ReconcileBlockResourceDependency[],
  opts?: { maxRows?: number },
): string[] {
  if (deps.length === 0) return [];
  const max = Math.max(1, Math.floor(opts?.maxRows ?? 16));
  const lines = ["  per-resource block drivers (reduced R170):"];
  for (const d of deps.slice(0, max)) {
    const id = d.effectId.length > 14 ? `${d.effectId.slice(0, 13)}…` : d.effectId;
    lines.push(`    · ${d.resourcePath} ← ${id} (${d.because})`);
  }
  if (deps.length > max) {
    lines.push(`    · … (${deps.length - max} more driver row(s))`);
  }
  return lines;
}

export function __resetEffectReconcileBlockForTests(): void {
  latches.clear();
}

/** Force latch in tests without needing a live mismatch. */
export function __latchEffectReconcileBlockForTests(
  workspace: string,
  sessionId: string,
  reason = "test latch",
  blockedPaths: string[] = [],
): void {
  latches.set(latchKey(workspace, sessionId), { reason, latchedAt: Date.now(), blockedPaths });
}

function openUnknownEffectCount(
  host: Pick<EffectHost, "getRecord" | "listEffectIds" | "reconcileEffect"> | undefined,
  workspace: string,
): number {
  const counted = new Set<string>();
  let n = 0;
  if (host) {
    for (const effectId of host.listEffectIds()) {
      if (host.reconcileEffect(effectId) === "unknown") {
        counted.add(effectId);
        n += 1;
      }
    }
  }
  const { verdicts, records } = loadEffectLedger(workspace);
  for (const row of records) {
    if (counted.has(row.effectId)) continue;
    if (verdicts.get(row.effectId) === "unknown") n += 1;
  }
  return n;
}

export type EffectReconcileBlockAssessment = {
  shouldBlock: boolean;
  summary: string;
};

export function assessEffectReconcileBlock(
  workspace: string,
  sessionId: string,
  host?: EffectHost,
): EffectReconcileBlockAssessment {
  const probe = probeEffectReconcile(workspace, {
    sessionId,
    effectHost: host ? { getRecord: (id) => host.getRecord(id), listEffectIds: () => host.listEffectIds() } : undefined,
  });
  const unpaired = formatUnpairedSessionKernelNotice(reconcileSessionKernel(workspace, sessionId));
  const unknownCount = openUnknownEffectCount(host, workspace);

  const bits: string[] = [];
  if (probe.mismatches.length > 0) {
    bits.push(formatEffectReconcileProbeSummary(probe));
  }
  if (unpaired !== "") bits.push(unpaired);
  if (unknownCount > 0) bits.push(`${unknownCount} open UNKNOWN effect(s)`);

  if (bits.length === 0) {
    return {
      shouldBlock: false,
      summary: "effect reconcile block: ledger, session, and kernel agree",
    };
  }
  return {
    shouldBlock: true,
    summary: bits.join(" · "),
  };
}

/**
 * Latch after turn/batch when conditions warrant blocking. Returns a blocking notice when newly latched or still blocked.
 */
export function latchEffectReconcileBlock(
  workspace: string,
  sessionId: string,
  host?: EffectHost,
): string | undefined {
  if (!effectReconcileBlockEnabled()) return undefined;
  const assessment = assessEffectReconcileBlock(workspace, sessionId, host);
  const key = latchKey(workspace, sessionId);
  if (!assessment.shouldBlock) {
    latches.delete(key);
    return undefined;
  }
  const mode = effectReconcileBlockMode();
  const blockedPaths = mode === "resource" ? reconcileBlockResourcePaths(workspace, sessionId, host) : [];
  latches.set(key, { reason: assessment.summary, latchedAt: Date.now(), blockedPaths });
  const resourceHint =
    mode === "resource"
      ? blockedPaths.length > 0
        ? ` (blocking ${blockedPaths.length} resource path(s); other paths may proceed)`
        : " (no resource paths extracted — session-wide mutating block for this latch)"
      : "";
  return (
    `${reconcileBlockNoticePrefix(mode)} — ${assessment.summary}${resourceHint} ` +
    `(clear via /unknown reconcile or /unknown reconcile --probe when clean; full R170 per-resource gate still open)`
  );
}

export function isEffectReconcileBlockLatched(workspace: string, sessionId: string): boolean {
  if (!effectReconcileBlockEnabled()) return false;
  return latches.has(latchKey(workspace, sessionId));
}

export type EffectReconcileBlockLatchView = {
  latched: boolean;
  mode: EffectReconcileBlockMode;
  reason?: string;
  blockedPathCount?: number;
  /** Paths extracted from probe mismatch + UNKNOWN when latched (ruling **307**). */
  blockedPaths?: readonly string[];
  /** Effect rows that explain why each blocked resource path is latched (**316**). */
  resourceDependencies?: readonly ReconcileBlockResourceDependency[];
};

/** Blocked resource paths for an active latch (from latch store or live reconcile extract). */
export function effectReconcileBlockLatchBlockedPaths(
  workspace: string,
  sessionId: string,
  host?: ReconcileBlockHostPeek,
): readonly string[] {
  if (!effectReconcileBlockEnabled()) return [];
  const latch = latches.get(latchKey(workspace, sessionId));
  if (!latch) return [];
  if (latch.blockedPaths.length > 0) return latch.blockedPaths;
  return reconcileBlockResourcePaths(workspace, sessionId, host);
}

/** Read-only latch snapshot for TUI status and `/unknown status` (ruling **304**). */
export function effectReconcileBlockLatchView(
  workspace: string,
  sessionId: string,
  host?: ReconcileBlockHostPeek,
): EffectReconcileBlockLatchView {
  const mode = effectReconcileBlockMode();
  if (!effectReconcileBlockEnabled()) return { latched: false, mode: "off" };
  const latch = latches.get(latchKey(workspace, sessionId));
  if (!latch) return { latched: false, mode };
  const blockedPaths = effectReconcileBlockLatchBlockedPaths(workspace, sessionId, host);
  const resourceDependencies =
    mode === "resource" && blockedPaths.length > 0
      ? reconcileBlockResourceDependencies(workspace, sessionId, host)
      : undefined;
  return {
    latched: true,
    mode,
    reason: latch.reason,
    blockedPathCount: blockedPaths.length > 0 ? blockedPaths.length : undefined,
    blockedPaths: blockedPaths.length > 0 ? blockedPaths : undefined,
    resourceDependencies:
      resourceDependencies !== undefined && resourceDependencies.length > 0 ? resourceDependencies : undefined,
  };
}

/** Plain lines for `/unknown status` and inspector notices. */
export function formatEffectReconcileBlockStatusLines(
  view: EffectReconcileBlockLatchView,
): string[] {
  if (!effectReconcileBlockEnabled() || view.mode === "off") {
    return ["effect reconcile block: disabled (HZ_EFFECT_RECONCILE_BLOCK unset)"];
  }
  if (!view.latched) {
    return [`effect reconcile block: off (${view.mode} mode enabled; no active latch)`];
  }
  const modeLabel = view.mode === "resource" ? "resource path filter" : "session-wide";
  const lines = [
    `effect reconcile block: LATCHED (${modeLabel}) — mutating tools blocked until reconcile`,
    `  reason: ${view.reason ?? "(unspecified)"}`,
  ];
  if (view.blockedPaths !== undefined && view.blockedPaths.length > 0) {
    lines.push(`  blocked resource path(s): ${view.blockedPaths.length}`);
    for (const p of view.blockedPaths.slice(0, 16)) {
      lines.push(`    · ${p}`);
    }
    if (view.blockedPaths.length > 16) {
      lines.push(`    · … (${view.blockedPaths.length - 16} more)`);
    }
  } else if (view.mode === "resource" && view.blockedPathCount !== undefined) {
    lines.push(`  blocked resource path(s): ${view.blockedPathCount}`);
  }
  lines.push(
    "  clear: /unknown release (or reconcile --probe / reconcile) when ledger is clean",
  );
  if (view.resourceDependencies !== undefined && view.resourceDependencies.length > 0) {
    lines.push(...formatReconcileBlockResourceDependencyLines(view.resourceDependencies));
  }
  return lines;
}

/** Lines appended to `/unknown` list when reconcile block is latched (ruling **307**). */
export function formatReconcileBlockListLines(view: EffectReconcileBlockLatchView): string[] {
  if (!view.latched) return [];
  const lines = [
    "",
    "effect reconcile block: LATCHED — mutating tools blocked until reconcile",
  ];
  if (view.blockedPaths !== undefined && view.blockedPaths.length > 0) {
    lines.push(`blocked resource path(s):`);
    for (const p of view.blockedPaths.slice(0, 24)) {
      lines.push(`  · ${p}`);
    }
    if (view.blockedPaths.length > 24) {
      lines.push(`  · … (${view.blockedPaths.length - 24} more)`);
    }
  }
  lines.push("clear: /unknown release · /unknown reconcile --probe when clean");
  return lines;
}

/** Re-assess after `/unknown reconcile` or a clean `--probe`; drops latch when clear. */
export function tryReleaseEffectReconcileBlock(
  workspace: string,
  sessionId: string,
  host?: EffectHost,
): boolean {
  if (!effectReconcileBlockEnabled()) return false;
  const key = latchKey(workspace, sessionId);
  if (!latches.has(key)) return false;
  const assessment = assessEffectReconcileBlock(workspace, sessionId, host);
  if (assessment.shouldBlock) {
    const mode = effectReconcileBlockMode();
    const blockedPaths = mode === "resource" ? reconcileBlockResourcePaths(workspace, sessionId, host) : [];
    latches.set(key, {
      reason: assessment.summary,
      latchedAt: latches.get(key)!.latchedAt,
      blockedPaths,
    });
    return false;
  }
  latches.delete(key);
  return true;
}

export function effectReconcileBlockRefusal(
  workspace: string,
  sessionId: string,
  tool: string,
  args?: Record<string, unknown>,
): string | undefined {
  if (!effectReconcileBlockEnabled()) return undefined;
  if (!BLOCKED_MUTATION_TOOLS.has(tool)) return undefined;
  const latch = latches.get(latchKey(workspace, sessionId));
  if (!latch) return undefined;
  const mode = effectReconcileBlockMode();
  if (mode === "resource") {
    const blocked = latch.blockedPaths;
    if (blocked.length > 0) {
      const target = args ? postimagePathForTool(tool, args, workspace) : undefined;
      if (!target) return undefined;
      if (!blocked.some((p) => resourcePathsOverlap(p, target))) return undefined;
      return (
        `${EFFECT_RECONCILE_BLOCK_RESOURCE_NOTICE}: ${latch.reason} ` +
        `(refusing ${tool} on ${target}; run /unknown reconcile when ledger is clean)`
      );
    }
  }
  return (
    `${reconcileBlockNoticePrefix(mode)}: ${latch.reason} ` +
    `(refusing ${tool}; run /unknown reconcile or /unknown reconcile --probe when ledger is clean)`
  );
}
