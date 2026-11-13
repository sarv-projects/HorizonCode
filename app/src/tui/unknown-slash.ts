/**
 * unknown-slash.ts — `/unknown` command (docs/28 ruling 264; actions ruling 282).
 */

import type { Runtime } from "../contracts";
import type { UnknownEffectRow } from "../core/effect-unknown-list";
import {
  buildUnknownEvidenceBundle,
  writeUnknownEvidenceBundle,
} from "../core/unknown-evidence";
import { findReceiptForUnknownTarget } from "../core/unknown-receipt-lookup";
import type { EffectRecord } from "../core/effect-host";
import { printUnknownInspector, formatReceiptChainInspectLines } from "./unknown-inspector";
import type { Renderer } from "./render";
import { parseUnknownSlashArgs } from "./unknown-slash-parse";
import { dim } from "./style";
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

export type RuntimeWithUnknownEffects = Runtime & {
  readonly workspace?: string;
  unknownEffects?: () => readonly UnknownEffectRow[];
  getEffectRecord?: (effectId: string) => EffectRecord | undefined;
  listEffectIds?: () => readonly string[];
  reconcileUnknownEffectsNow?: () => Promise<number>;
  tryReleaseReconcileBlockIfClean?: () => boolean;
  reconcileBlockLatch?: () => import("../core/effect-reconcile-block").EffectReconcileBlockLatchView;
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

export function runUnknownCommand(runtime: Runtime, renderer: Renderer, arg?: string): void {
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
              `  · ${m.kind} · ${m.tool} · ${m.effectId.slice(0, 13)}… ledger=${m.ledgerVerdict ?? "—"} session=${m.sessionVerdict} kernel=${m.kernelVerdict ?? "—"}`,
            ),
          );
        }
        if (report.vcsSnapshot) {
          const vcsLine = formatVcsProbeLine(report.vcsSnapshot);
          if (vcsLine) renderer.line(dim(`  · ${vcsLine}`));
        }
        if (report.ioHints) {
          for (const hint of report.ioHints.slice(0, 8)) {
            renderer.line(dim(`  · probe ${formatProbeIoHintLine(hint)}`));
          }
        }
        if (report.terminalSnapshot) {
          for (const row of report.terminalSnapshot.probes) {
            renderer.line(dim(`  · ${formatTerminalProbeLine(row)}`));
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
    void reconcile().then((settled) => {
      if (settled > 0) {
        renderer.notice(`observe-only reconcile settled ${settled} effect(s) from logs/receipts`);
      } else {
        renderer.notice("observe-only reconcile: no UNKNOWN effects became settled (still open or none)");
      }
      printUnknownInspector(renderer, list.call(runtime));
    });
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
    const out = writeUnknownEvidenceBundle(workspace, bundle);
    renderer.notice(`wrote evidence bundle (${rows.length} effect(s)): ${out}`);
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
