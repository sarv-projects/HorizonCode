/**
 * unknown-slash.ts — `/unknown` command (docs/28 ruling 264; actions ruling 282).
 */

import type { GuardAction, Runtime } from "../contracts";
import type { UnknownEffectRow } from "../core/effect-unknown-list";
import {
  buildUnknownEvidenceBundle,
  defaultUnknownEvidencePath,
  unknownExportPublication,
  writeUnknownEvidenceBundle,
} from "../core/unknown-evidence";
import { findReceiptForUnknownTarget } from "../core/unknown-receipt-lookup";
import type { EffectRecord } from "../core/effect-host";
import { KernelClient } from "../core/kernel";
import { guardEffectivelyAllows } from "../core/guard-g1-wire";
import { scopeFor } from "../core/loop";
import { printUnknownInspector, formatReceiptChainInspectLines } from "./unknown-inspector";
import type { Renderer } from "./render";
import { parseUnknownSlashArgs } from "./unknown-slash-parse";
import { dim, sanitizeDisplay } from "./style";
import {
  formatEffectReconcileProbeSummary,
  formatProbeIoHintLine,
  formatTerminalProbeLine,
  formatVcsProbeLine,
  probeEffectReconcile,
} from "../core/effect-reconcile-probe";
import {
  effectReconcileBlockLatchView,
  formatEffectReconcileBlockStatusLines,
  formatReconcileBlockListLines,
  formatReconcileBlockResourceDependencyLines,
  reconcileBlockResourceDependencies,
  tryReleaseEffectReconcileBlock,
} from "../core/effect-reconcile-block";

export type EffectOwnerRecoverMode =
  | "prepare_only"
  | "executed_unknown_abandon"
  | "executed_unknown_observe_settle";

export const EFFECT_OWNER_RECOVER_MODES: readonly EffectOwnerRecoverMode[] = [
  "prepare_only",
  "executed_unknown_abandon",
  "executed_unknown_observe_settle",
] as const;

export const RECONCILE_RECOVERY_MODE_HINTS: readonly string[] = [
  "kernel effect.owner.recover modes:",
  "  prepare_only                    — recover a prepared-only crash before dispatch",
  "  executed_unknown_abandon        — attest & abandon an unverified executed UNKNOWN effect",
  "  executed_unknown_observe_settle — observe post-image / receipts and settle an UNKNOWN effect",
  "usage: /reconcile [--probe | status | release | inspect <id> | export | recover <effect-id> <mode>]",
];

export type RuntimeWithUnknownEffects = Runtime & {
  readonly workspace?: string;
  unknownEffects?: () => readonly UnknownEffectRow[];
  getEffectRecord?: (effectId: string) => EffectRecord | undefined;
  listEffectIds?: () => readonly string[];
  reconcileUnknownEffectsNow?: () => Promise<number>;
  tryReleaseReconcileBlockIfClean?: () => boolean;
  reconcileBlockLatch?: () => import("../core/effect-reconcile-block").EffectReconcileBlockLatchView;
  ownerRecover?: (
    effectId: string,
    opts?: { mode?: EffectOwnerRecoverMode; reason?: string },
  ) => Promise<unknown>;
};

function resolveUnknownTarget(rows: readonly UnknownEffectRow[], target: string): string | undefined {
  const needle = target.trim().toLowerCase();
  for (const row of rows) {
    if (row.effectId.toLowerCase() === needle || row.effectId.toLowerCase().startsWith(needle)) return row.effectId;
    const rid = row.receiptId?.toLowerCase();
    if (rid !== undefined && (rid === needle || rid.startsWith(needle))) return row.effectId;
  }
  return undefined;
}

export function buildUnknownInspectLines(
  runtime: Runtime,
  target: string,
): string[] | undefined {
  const rt = runtime as RuntimeWithUnknownEffects;
  const list = rt.unknownEffects;
  if (typeof list !== "function") return undefined;
  const workspace = typeof rt.workspace === "string" ? rt.workspace : undefined;
  if (workspace === undefined) return undefined;
  const rows = list.call(runtime);
  const effectId = resolveUnknownTarget(rows, target);
  const receipt = findReceiptForUnknownTarget(workspace, target);
  const getRecord = rt.getEffectRecord;
  const record =
    effectId && typeof getRecord === "function" ? getRecord(effectId) : undefined;
  if (!record && !receipt) return undefined;
  return formatReceiptChainInspectLines({
    record,
    receipt,
    sessionId: runtime.sessionId,
    workspace,
  });
}

export async function runUnknownCommand(runtime: Runtime, renderer: Renderer, arg?: string): Promise<void> {
  const rt = runtime as RuntimeWithUnknownEffects;
  const list = rt.unknownEffects;
  if (typeof list !== "function") {
    renderer.notice("not supported by this runtime: unknownEffects");
    return;
  }
  const rows = list.call(runtime);
  const cmd = parseUnknownSlashArgs(arg);
  const workspace = typeof rt.workspace === "string" ? rt.workspace : undefined;
  const getRecord = rt.getEffectRecord;
  const listIds = rt.listEffectIds;
  const effectHostPartial =
    typeof getRecord === "function" && typeof listIds === "function"
      ? { getRecord, listEffectIds: () => [...listIds.call(runtime)] }
      : undefined;

  if (cmd.kind === "list") {
    printUnknownInspector(renderer, rows);
    if (workspace !== undefined) {
      const latchFn = rt.reconcileBlockLatch;
      const latch =
        typeof latchFn === "function"
          ? latchFn.call(runtime)
          : effectReconcileBlockLatchView(workspace, runtime.sessionId, effectHostPartial);
      for (const line of formatReconcileBlockListLines(latch)) {
        renderer.line(line.startsWith("  ·") ? dim(line) : line);
      }
    }
    return;
  }

  if (cmd.kind === "release") {
    if (workspace === undefined) {
      renderer.notice("not supported: workspace path for reconcile-block release");
      return;
    }
    const report = probeEffectReconcile(workspace, {
      sessionId: runtime.sessionId,
      effectHost: effectHostPartial,
    });
    if (report.mismatches.length > 0) {
      renderer.notice(formatEffectReconcileProbeSummary(report));
      renderer.notice("effect reconcile block still latched (probe not clean)");
      const deps = reconcileBlockResourceDependencies(workspace, runtime.sessionId, effectHostPartial);
      for (const line of formatReconcileBlockResourceDependencyLines(deps)) {
        renderer.line(line.startsWith("    ·") ? dim(line) : line);
      }
      return;
    }
    const release = rt.tryReleaseReconcileBlockIfClean;
    const cleared =
      typeof release === "function"
        ? release.call(runtime)
        : tryReleaseEffectReconcileBlock(workspace, runtime.sessionId);
    if (cleared) {
      renderer.notice("effect reconcile block cleared (/unknown release)");
    } else {
      renderer.notice("no active reconcile-block latch (or release refused)");
      const latch =
        typeof rt.reconcileBlockLatch === "function"
          ? rt.reconcileBlockLatch.call(runtime)
          : effectReconcileBlockLatchView(workspace, runtime.sessionId, effectHostPartial);
      const deps =
        latch.resourceDependencies ??
        reconcileBlockResourceDependencies(workspace, runtime.sessionId, effectHostPartial);
      for (const line of formatReconcileBlockResourceDependencyLines(deps)) {
        renderer.line(line.startsWith("    ·") ? dim(line) : line);
      }
    }
    return;
  }

  if (cmd.kind === "status") {
    const latchFn = rt.reconcileBlockLatch;
    const latch =
      typeof latchFn === "function"
        ? latchFn.call(runtime)
        : workspace !== undefined
          ? effectReconcileBlockLatchView(workspace, runtime.sessionId, effectHostPartial)
          : { latched: false, mode: "off" as const };
    for (const line of formatEffectReconcileBlockStatusLines(latch)) {
      renderer.line(line);
    }
    renderer.line(`${rows.length} open UNKNOWN effect(s) in this session`);
    return;
  }

  if (cmd.kind === "reconcile") {
    if (cmd.probe) {
      if (workspace === undefined) {
        renderer.notice("not supported: workspace path for reconcile probe");
        return;
      }
      const getRecord = rt.getEffectRecord;
      const listIds = rt.listEffectIds;
      const report = probeEffectReconcile(workspace, {
        sessionId: runtime.sessionId,
        effectHost:
          typeof getRecord === "function" && typeof listIds === "function"
            ? { listEffectIds: () => [...listIds.call(runtime)], getRecord }
            : undefined,
      });
      renderer.notice(formatEffectReconcileProbeSummary(report));
      if (report.mismatches.length === 0) {
        const release = rt.tryReleaseReconcileBlockIfClean;
        if (typeof release === "function" && release()) {
          renderer.notice("effect reconcile block cleared (probe clean)");
        }
      }
      if (report.mismatches.length > 0) {
        for (const m of report.mismatches.slice(0, 12)) {
          renderer.line(
            dim(
              `  · ${sanitizeDisplay(m.kind)} · ${sanitizeDisplay(m.tool)} · ${sanitizeDisplay(m.effectId).slice(0, 13)}… ledger=${sanitizeDisplay(m.ledgerVerdict ?? "—")} session=${sanitizeDisplay(m.sessionVerdict)} kernel=${sanitizeDisplay(m.kernelVerdict ?? "—")}`,
            ),
          );
        }
        if (report.vcsSnapshot) {
          const vcsLine = formatVcsProbeLine(report.vcsSnapshot);
          if (vcsLine) renderer.line(dim(`  · ${sanitizeDisplay(vcsLine)}`));
        }
        if (report.ioHints) {
          for (const hint of report.ioHints.slice(0, 8)) {
            renderer.line(dim(`  · probe ${sanitizeDisplay(formatProbeIoHintLine(hint))}`));
          }
        }
        if (report.terminalSnapshot) {
          for (const row of report.terminalSnapshot.probes) {
            renderer.line(dim(`  · ${sanitizeDisplay(formatTerminalProbeLine(row))}`));
          }
        }
      }
      return;
    }
    const reconcile = rt.reconcileUnknownEffectsNow;
    if (typeof reconcile !== "function") {
      renderer.notice("not supported: reconcileUnknownEffectsNow");
      return;
    }
    const settled = await reconcile();
    if (settled > 0) {
      renderer.notice(`observe-only reconcile settled ${settled} effect(s) from logs/receipts`);
    } else {
      renderer.notice("observe-only reconcile: no UNKNOWN effects became settled (still open or none)");
    }
    printUnknownInspector(renderer, list.call(runtime));
    return;
  }

  if (cmd.kind === "export") {
    if (workspace === undefined) {
      renderer.notice("not supported: workspace path for evidence export");
      return;
    }
    const getRecord = rt.getEffectRecord;
    if (typeof getRecord !== "function") {
      renderer.notice("not supported: getEffectRecord");
      return;
    }
    if (rows.length === 0) {
      renderer.notice("no UNKNOWN effects to export");
      return;
    }
    const bundle = buildUnknownEvidenceBundle({
      workspace,
      sessionId: runtime.sessionId,
      rows,
      getRecord,
    });
    // Under-admission (ruling 571): Guard fs.write on the evidence path first.
    const target = defaultUnknownEvidencePath(workspace, runtime.sessionId);
    const action: GuardAction = { kind: "fs.write", target };
    const kernel = new KernelClient({ workspace });
    let decision;
    try {
      await kernel.start();
      decision = await kernel.checkGuard(action, scopeFor(action, workspace));
    } catch (err) {
      renderer.notice(
        `export refused: the guard could not decide (${err instanceof Error ? err.message : String(err)})`,
      );
      return;
    } finally {
      try {
        await kernel.close();
      } catch {
        /* ignore */
      }
    }
    if (!guardEffectivelyAllows(decision)) {
      const why =
        decision.decision === "ask"
          ? "unattended export never self-approves; allow the path in policy"
          : `denied by policy: ${decision.reason !== undefined && decision.reason !== "" ? decision.reason : "no reason given"}`;
      renderer.notice(`export refused: ${why}`);
      return;
    }
    const out = writeUnknownEvidenceBundle(workspace, bundle, target);
    renderer.notice(`wrote evidence bundle (${rows.length} effect(s)): ${out}`);
    // H-7 (ruling 574): force-evaluate contracts; human notice unchanged.
    void unknownExportPublication({ effectCount: rows.length });
    return;
  }

  // inspect
  if (workspace === undefined) {
    renderer.notice("not supported: workspace path for receipt inspect");
    return;
  }
  const lines = buildUnknownInspectLines(runtime, cmd.target);
  if (!lines) {
    renderer.notice(`no UNKNOWN effect or receipt matched "${cmd.target}"`);
    return;
  }
  for (const line of lines) {
    renderer.line(line.startsWith("  ") || line.startsWith("──") ? dim(line) : line);
  }
}

function isRecoverMode(value: string): value is EffectOwnerRecoverMode {
  return (EFFECT_OWNER_RECOVER_MODES as readonly string[]).includes(value);
}

function printReconcileRecoveryHints(renderer: Renderer): void {
  for (const line of RECONCILE_RECOVERY_MODE_HINTS) {
    renderer.line(line.startsWith("  ") ? dim(line) : line);
  }
}

/**
 * Top-level `/reconcile` UX command (Wave A / Track A4).
 *
 * Delegates status/probe/release/inspect/export to `/unknown` and exposes the
 * 3 kernel `effect.owner.recover` modes (`prepare_only`,
 * `executed_unknown_abandon`, `executed_unknown_observe_settle`).
 */
export async function runReconcileCommand(
  runtime: Runtime,
  renderer: Renderer,
  arg?: string,
): Promise<void> {
  const raw = typeof arg === "string" ? arg.trim() : "";
  if (raw === "") {
    await runUnknownCommand(runtime, renderer, "status");
    printReconcileRecoveryHints(renderer);
    return;
  }

  const parts = raw.split(/\s+/).filter(Boolean);
  const verb = (parts[0] ?? "").toLowerCase();
  const tail = parts.slice(1).join(" ").trim();

  if (verb === "--probe" || verb === "probe") {
    await runUnknownCommand(runtime, renderer, "reconcile --probe");
    return;
  }
  if (verb === "status" || verb === "release" || verb === "clear" || verb === "export") {
    await runUnknownCommand(runtime, renderer, verb);
    return;
  }
  if (verb === "inspect") {
    await runUnknownCommand(runtime, renderer, tail ? `inspect ${tail}` : "");
    return;
  }
  if (verb === "list") {
    await runUnknownCommand(runtime, renderer, "");
    printReconcileRecoveryHints(renderer);
    return;
  }
  if (verb === "recover") {
    const target = parts[1]?.trim() ?? "";
    const modeArg = parts[2]?.trim() ?? "";
    const reason = parts.slice(3).join(" ").trim();
    if (target === "" || !isRecoverMode(modeArg)) {
      renderer.notice(
        "usage: /reconcile recover <effect-id> <prepare_only|executed_unknown_abandon|executed_unknown_observe_settle> [reason]",
      );
      printReconcileRecoveryHints(renderer);
      return;
    }
    const rt = runtime as RuntimeWithUnknownEffects;
    const rows = typeof rt.unknownEffects === "function" ? rt.unknownEffects.call(runtime) : [];
    const resolvedId = resolveUnknownTarget(rows, target) ?? target;
    if (typeof rt.ownerRecover === "function") {
      try {
        await rt.ownerRecover(resolvedId, {
          mode: modeArg,
          ...(reason !== "" ? { reason } : {}),
        });
        renderer.notice(`effect.owner.recover (${modeArg}) completed for ${resolvedId}`);
      } catch (err) {
        renderer.notice(
          `effect.owner.recover failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    const workspace = typeof rt.workspace === "string" ? rt.workspace : undefined;
    if (workspace === undefined) {
      renderer.notice("not supported: workspace path for effect.owner.recover");
      return;
    }
    const kernel = new KernelClient({ workspace });
    try {
      await kernel.start();
      await kernel.ownerRecover(resolvedId, {
        effectId: resolvedId,
        mode: modeArg,
        ...(reason !== "" ? { reason } : {}),
      });
      renderer.notice(`effect.owner.recover (${modeArg}) completed for ${resolvedId}`);
    } catch (err) {
      renderer.notice(
        `effect.owner.recover failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      try {
        await kernel.close();
      } catch {
        /* ignore */
      }
    }
    return;
  }

  // Fallback: run observe-only reconcile and display recovery modes.
  await runUnknownCommand(runtime, renderer, `reconcile ${raw}`);
  printReconcileRecoveryHints(renderer);
}
