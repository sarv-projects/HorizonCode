/**
 * Opt-in blocking gate when reconcile probe / unpaired ledger / UNKNOWN is open (ruling **293**, **303**, **304**).
 *
 * Reduced precursor to docs/13 R170 full protocol: `=1` session latch; `=resource` blocks
 * potential host effects on overlapping resources and fails closed when a target is unscoped.
 * Ruling 344 persists latch/release transitions, retains barriers until explicit clean
 * reconciliation, and assesses at first mutator admission. Still opt-in, not Rust OwnerLog.
 */

import * as path from "node:path";
import { realpathish } from "./paths";
import type { EffectHost, EffectRecord } from "./effect-host";
import { loadEffectLedger } from "./effect-ledger";
import { appendReconcileLatch, loadReconcileLatch } from "./effect-reconcile-latch-store";
import { formatEffectReconcileProbeSummary, probeEffectReconcile } from "./effect-reconcile-probe";
import { resourceKeyFromEffectRecord } from "./effect-reconcile-probe-io";
import {
  observePendingEffectIdsOverlappingPath,
  observePendingResourceKeys,
  mutationResourceTargets,
} from "./effect-resource-gate";
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

/** Only tools whose admission is known not to mutate host state can pass
 * a reconciliation latch. Newly registered or MCP tools are not presumed safe. */
const RECONCILE_READ_ONLY_TOOLS = new Set([
  "read", "grep", "glob", "repo_map", "ast_search", "memory_search",
  "handoff_search", "tool_search",
]);

type ReconcileBlockLatch = { reason: string; latchedAt: number; blockedPaths: string[] };

const latches = new Map<string, ReconcileBlockLatch>();

function latchKey(workspace: string, sessionId: string): string {
  return `${workspace}\0${sessionId}`;
}

/** Read durable transitions on each admission: a separate runtime can latch or
 * explicitly release without leaving this runtime's map stale. */
function currentLatch(workspace: string, sessionId: string): ReconcileBlockLatch | undefined {
  const key = latchKey(workspace, sessionId);
  const persisted = loadReconcileLatch(workspace, sessionId);
  if (persisted.present) {
    if (persisted.latch) {
      latches.set(key, persisted.latch);
      return persisted.latch;
    }
    latches.delete(key);
    return undefined;
  }
  return latches.get(key);
}

function persistLatch(workspace: string, sessionId: string, next: ReconcileBlockLatch): void {
  const prev = currentLatch(workspace, sessionId);
  // [] is a SESSION-WIDE, unscoped barrier: there is no proof that its
  // dependencies are limited to particular paths. Once an unscoped mismatch
  // joins a latch, never narrow it again until an explicit clean release.
  const unscoped = next.blockedPaths.length === 0 ||
    (prev !== undefined && prev.blockedPaths.length === 0);
  const paths = unscoped
    ? []
    : [...new Set([...(prev?.blockedPaths ?? []), ...next.blockedPaths])].sort();
  // If the set is too large for a single reliable JSONL append, session-wide
  // refusal is safer than losing a blocked path through truncation.
  const full: ReconcileBlockLatch = {
    ...next,
    latchedAt: prev?.latchedAt ?? next.latchedAt,
    blockedPaths: paths.length > 256 ? [] : paths,
  };
  if (prev && prev.reason === full.reason &&
      prev.blockedPaths.length === full.blockedPaths.length &&
      prev.blockedPaths.every((p, i) => p === full.blockedPaths[i])) return;
  appendReconcileLatch(workspace, sessionId, full);
  latches.set(latchKey(workspace, sessionId), full);
}

function persistRelease(workspace: string, sessionId: string): void {
  appendReconcileLatch(workspace, sessionId, null);
  latches.delete(latchKey(workspace, sessionId));
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
    return (
      "HZ_EFFECT_RECONCILE_BLOCK=resource: path-filtered mutating-tool gate (reduced R170; status chip + /unknown status wire **304**); " +
      "durable latch until explicit clean /unknown release, first-admission preflight, unknown-target fail-closed (**344**); " +
      "all projected apply_patch paths and rename ends gated; unscoped shell denied during observe-pending; status/inset drivers (**342**)"
    );
  }
  return (
    "HZ_EFFECT_RECONCILE_BLOCK=1: session-wide potential-effect gate (reduced R170); " +
    "durable latch persists across restarts, admission preflight, and clean explicit /unknown release (**344**); " +
    "observe-pending overlap checks all projected apply_patch paths; unscoped shell denied until observe; " +
    "scrollback/fullscreen status and inset barrier (**342** reduced)"
  );
}

function reconcileBlockNoticePrefix(mode: EffectReconcileBlockMode): string {
  return mode === "resource" ? EFFECT_RECONCILE_BLOCK_RESOURCE_NOTICE : EFFECT_RECONCILE_BLOCK_SESSION_NOTICE;
}

function resourcePathsOverlap(a: string, b: string): boolean {
  // Resolve existing symlink aliases before comparing. A write to alias.ts
  // must not bypass a barrier protecting the file it points at.
  const ra = realpathish(a);
  const rb = realpathish(b);
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
  persistLatch(workspace, sessionId, { reason, latchedAt: Date.now(), blockedPaths });
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
  if (!assessment.shouldBlock) {
    // R170: a clean end-of-turn snapshot is NOT the user's explicit
    // reconciliation. Keep the barrier until tryReleaseEffectReconcileBlock.
    const held = currentLatch(workspace, sessionId);
    return held
      ? `${reconcileBlockNoticePrefix(effectReconcileBlockMode())}: ${held.reason} (still latched; run /unknown release after clean reconciliation)`
      : undefined;
  }
  const mode = effectReconcileBlockMode();
  const blockedPaths = mode === "resource" ? reconcileBlockResourcePaths(workspace, sessionId, host) : [];
  persistLatch(workspace, sessionId, {
    reason: assessment.summary,
    latchedAt: Date.now(),
    blockedPaths,
  });
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
  return currentLatch(workspace, sessionId) !== undefined;
}

export type ObservePendingResourceDependency = {
  resourcePath: string;
  effectIds: readonly string[];
};

/** In-flight execute-without-observe rows on the session host (ruling **342** reduced R170 inspector). */
export function reconcileBlockObservePendingDependencies(
  host?: ReconcileBlockHostPeek,
): ObservePendingResourceDependency[] {
  if (!host) return [];
  const pending = observePendingResourceKeys(host as EffectHost);
  const deps: ObservePendingResourceDependency[] = [];
  for (const [resourcePath, effectIds] of pending) {
    deps.push({ resourcePath, effectIds: [...effectIds] });
  }
  return deps.sort((a, b) => a.resourcePath.localeCompare(b.resourcePath));
}

/** Lines for `/unknown status`, scrollback, and fullscreen inset observe-pending barrier (**342**). */
export function formatObservePendingDependencyLines(
  deps: readonly ObservePendingResourceDependency[],
  opts?: { maxRows?: number },
): string[] {
  if (deps.length === 0) return [];
  const max = Math.max(1, Math.floor(opts?.maxRows ?? 16));
  const lines = [
    "  observe-pending block drivers (reduced R170): overlapping mutating tools blocked until receipt observe",
  ];
  for (const d of deps.slice(0, max)) {
    const ids = d.effectIds
      .slice(0, 3)
      .map((id) => (id.length > 14 ? `${id.slice(0, 13)}…` : id))
      .join(", ");
    const extra = d.effectIds.length > 3 ? ` (+${d.effectIds.length - 3} more)` : "";
    lines.push(`    · ${d.resourcePath} ← ${ids}${extra}`);
  }
  if (deps.length > max) {
    lines.push(`    · … (${deps.length - max} more observe-pending row(s))`);
  }
  return lines;
}

/** Plain inspector block for scrollback / fullscreen inset when observe-pending is active (**342**). */
export function formatObservePendingInspectorLines(view: EffectReconcileBlockLatchView): string[] {
  if (!view.observePendingDependencies?.length || view.mode === "off") return [];
  const lines = [
    `observe-pending barrier — mutating tools blocked on overlapping path(s) until receipt observe settles`,
    `  path(s): ${view.observePendingDependencies.length}`,
    ...formatObservePendingDependencyLines(view.observePendingDependencies),
    "  clear: wait for receipt observe (not /unknown release); /unknown status for live list",
  ];
  return lines;
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
  /** Execute-without-observe drivers when `HZ_EFFECT_RECONCILE_BLOCK` enabled (**342**). */
  observePendingDependencies?: readonly ObservePendingResourceDependency[];
  /** True when observe-pending overlap gate may refuse mutating tools (**342**). */
  observePendingActive?: boolean;
};

/** Blocked resource paths for an active latch (from latch store or live reconcile extract). */
export function effectReconcileBlockLatchBlockedPaths(
  workspace: string,
  sessionId: string,
  host?: ReconcileBlockHostPeek,
): readonly string[] {
  if (!effectReconcileBlockEnabled()) return [];
  const latch = currentLatch(workspace, sessionId);
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
  const observePendingDependencies = effectReconcileBlockEnabled()
    ? reconcileBlockObservePendingDependencies(host)
    : [];
  const observeFields =
    observePendingDependencies.length > 0
      ? {
          observePendingDependencies,
          observePendingActive: true as const,
        }
      : {};
  if (!effectReconcileBlockEnabled()) {
    return { latched: false, mode: "off", ...observeFields };
  }
  const latch = currentLatch(workspace, sessionId);
  if (!latch) return { latched: false, mode, ...observeFields };
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
    ...observeFields,
  };
}

function appendObservePendingStatusLines(view: EffectReconcileBlockLatchView, lines: string[]): void {
  if (view.observePendingDependencies === undefined || view.observePendingDependencies.length === 0) return;
  lines.push(
    `effect reconcile block: observe-pending (${view.observePendingDependencies.length} resource path(s)) — overlapping mutating tools blocked`,
  );
  lines.push(...formatObservePendingDependencyLines(view.observePendingDependencies));
  lines.push("  clear observe-pending: receipt observe settles in-flight effect (not /unknown release)");
}

/** Plain lines for `/unknown status` and inspector notices. */
export function formatEffectReconcileBlockStatusLines(
  view: EffectReconcileBlockLatchView,
): string[] {
  if (!effectReconcileBlockEnabled() || view.mode === "off") {
    return ["effect reconcile block: disabled (HZ_EFFECT_RECONCILE_BLOCK unset)"];
  }
  if (!view.latched) {
    const lines = [`effect reconcile block: off (${view.mode} mode enabled; no active latch)`];
    appendObservePendingStatusLines(view, lines);
    return lines;
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
  appendObservePendingStatusLines(view, lines);
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
  if (view.observePendingDependencies !== undefined && view.observePendingDependencies.length > 0) {
    lines.push("");
    lines.push(
      `observe-pending: ${view.observePendingDependencies.length} resource path(s) — overlapping mutators blocked until observe`,
    );
    for (const d of view.observePendingDependencies.slice(0, 12)) {
      const id = d.effectIds[0];
      const short = id && id.length > 14 ? `${id.slice(0, 13)}…` : id ?? "—";
      lines.push(`  · ${d.resourcePath} ← ${short}`);
    }
    if (view.observePendingDependencies.length > 12) {
      lines.push(`  · … (${view.observePendingDependencies.length - 12} more)`);
    }
  }
  return lines;
}

/** Re-assess after `/unknown reconcile` or a clean `--probe`; drops latch when clear. */
export function tryReleaseEffectReconcileBlock(
  workspace: string,
  sessionId: string,
  host?: EffectHost,
): boolean {
  if (!effectReconcileBlockEnabled()) return false;
  const held = currentLatch(workspace, sessionId);
  if (!held) return false;
  const assessment = assessEffectReconcileBlock(workspace, sessionId, host);
  if (assessment.shouldBlock) {
    const mode = effectReconcileBlockMode();
    persistLatch(workspace, sessionId, {
      reason: assessment.summary,
      latchedAt: held.latchedAt,
      blockedPaths: mode === "resource" ? reconcileBlockResourcePaths(workspace, sessionId, host) : [],
    });
    return false;
  }
  persistRelease(workspace, sessionId);
  return true;
}

const OBSERVE_PENDING_BLOCK_TOOLS = new Set([
  "write",
  "edit",
  "multi_edit",
  "apply_patch",
  "ast_edit",
  "shell",
]);

export const EFFECT_RECONCILE_BLOCK_OBSERVE_PENDING_NOTICE =
  "[effect-reconcile-block] observe not settled";

/**
 * Refuse path-keyed mutators when an effect on the same path finished execute but observe/receipt
 * has not landed yet (rulings **333** `apply_patch`/`ast_edit`, **334** `write`/`edit`/`multi_edit`;
 * `shell` when postimage or explicit path/cwd resolves (**336** reduced) — requires `HZ_EFFECT_RECONCILE_BLOCK`).
 */
export function effectReconcileBlockObservePendingRefusal(
  workspace: string,
  tool: string,
  args: Record<string, unknown> | undefined,
  host?: EffectHost,
): string | undefined {
  if (!effectReconcileBlockEnabled()) return undefined;
  if (!OBSERVE_PENDING_BLOCK_TOOLS.has(tool)) return undefined;
  const targets = args ? mutationResourceTargets(tool, args, workspace) : undefined;
  if (!targets || targets.length === 0) {
    // Shell with no declared cwd and unprojectable patches cannot prove they
    // avoid any of the resources for which a receipt has not been observed.
    if (tool !== "shell" && tool !== "apply_patch") return undefined;
    const pending = observePendingResourceKeys(host);
    if (pending.size === 0) return undefined;
    const driving = [...new Set([...pending.values()].flat())];
    const shown = driving.slice(0, 3).map((id) => (id.length > 14 ? `${id.slice(0, 13)}…` : id));
    return `${EFFECT_RECONCILE_BLOCK_OBSERVE_PENDING_NOTICE}: unknown resource target — ` +
      `refusing ${tool} until receipt observe settles (driving effect(s): ${shown.join(", ")})`;
  }
  for (const target of targets) {
    const drivers = observePendingEffectIdsOverlappingPath(host, target);
    if (drivers.length === 0) continue;
    const shown = drivers.slice(0, 3).map((id) => (id.length > 14 ? `${id.slice(0, 13)}…` : id));
    const extra = drivers.length > shown.length ? ` (+${drivers.length - shown.length} more in-flight effect(s))` : "";
    return `${EFFECT_RECONCILE_BLOCK_OBSERVE_PENDING_NOTICE}: resource ${target} — ` +
      `refusing ${tool} until receipt observe settles (HZ_EFFECT_RECONCILE_BLOCK; driving effect(s): ${shown.join(", ")}${extra})`;
  }
  return undefined;
}

export function effectReconcileBlockRefusal(
  workspace: string,
  sessionId: string,
  tool: string,
  args?: Record<string, unknown>,
  host?: EffectHost,
  opts?: { preflighted?: boolean },
): string | undefined {
  if (!effectReconcileBlockEnabled()) return undefined;
  if (RECONCILE_READ_ONLY_TOOLS.has(tool)) return undefined;
  let latch = currentLatch(workspace, sessionId);
  if (!latch && opts?.preflighted !== true) {
    // Assess BEFORE this tool's tool.call event is appended. runOneToolCall
    // preflights ahead of that append and then only reads the latched verdict
    // here; otherwise a normal in-flight call would count as its own orphan.
    latchEffectReconcileBlock(workspace, sessionId, host);
    latch = currentLatch(workspace, sessionId);
  }
  if (!latch) return undefined;
  const mode = effectReconcileBlockMode();
  if (mode === "resource") {
    const blocked = latch.blockedPaths;
    if (blocked.length > 0) {
      const targets = args ? mutationResourceTargets(tool, args, workspace) : undefined;
      if (!targets || targets.length === 0) {
        return `${EFFECT_RECONCILE_BLOCK_RESOURCE_NOTICE}: ${latch.reason} ` +
          `(refusing ${tool}: unknown resource target cannot prove disjoint from blocked path(s))`;
      }
      const overlap = targets.find((target) => blocked.some((p) => resourcePathsOverlap(p, target)));
      if (!overlap) return undefined;
      return (
        `${EFFECT_RECONCILE_BLOCK_RESOURCE_NOTICE}: ${latch.reason} ` +
        `(refusing ${tool} on ${overlap}; run /unknown reconcile when ledger is clean)`
      );
    }
  }
  return (
    `${reconcileBlockNoticePrefix(mode)}: ${latch.reason} ` +
    `(refusing ${tool}; run /unknown reconcile or /unknown reconcile --probe when ledger is clean)`
  );
}
