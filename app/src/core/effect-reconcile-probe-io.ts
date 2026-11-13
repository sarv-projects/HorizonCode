/**
 * effect-reconcile-probe-io.ts — read-only filesystem + VCS probes for reconcile mismatch
 * enrichment (docs/06 flow 6.8 step 6; ruling **290**). No writes, no re-execution.
 */

import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { EffectRecord } from "./effect-host";
import type { EffectReconcileMismatch } from "./effect-reconcile-probe";

export interface ResourceProbeResult {
  path: string;
  exists: boolean;
  kind?: "file" | "directory" | "other";
  size?: number;
  mtimeMs?: number;
}

export interface VcsProbeSnapshot {
  available: boolean;
  porcelainLineCount: number;
  /** Truncated `git status --porcelain` lines (read-only). */
  porcelainPreview: readonly string[];
  error?: string;
}

export interface EffectReconcileProbeIoHint {
  effectId: string;
  resource?: ResourceProbeResult;
}

export function resourceKeyFromEffectRecord(record: EffectRecord | undefined): string | undefined {
  if (!record) return undefined;
  for (let i = record.steps.length - 1; i >= 0; i -= 1) {
    const key = record.steps[i]?.resourceKey?.trim();
    if (key) return key;
  }
  return undefined;
}

/** Stat or absence for a resolved postimage / resource path (read-only). */
export function probeResourcePath(filePath: string): ResourceProbeResult {
  const pathNorm = filePath.trim();
  if (pathNorm === "") return { path: filePath, exists: false };
  if (!existsSync(pathNorm)) return { path: pathNorm, exists: false };
  try {
    const st = statSync(pathNorm);
    const kind: ResourceProbeResult["kind"] = st.isFile() ? "file" : st.isDirectory() ? "directory" : "other";
    return {
      path: pathNorm,
      exists: true,
      kind,
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  } catch {
    return { path: pathNorm, exists: false };
  }
}

export type GitPorcelainRunner = (
  cwd: string,
) => { ok: boolean; stdout: string; stderr: string };

const defaultGitPorcelain: GitPorcelainRunner = (cwd) => {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 8_000 });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

/** Workspace-level porcelain snapshot; does not mutate the repository. */
export function probeGitStatusPorcelain(
  workspace: string,
  opts?: { maxPreviewLines?: number; run?: GitPorcelainRunner },
): VcsProbeSnapshot {
  const maxPreviewLines = opts?.maxPreviewLines ?? 8;
  const run = opts?.run ?? defaultGitPorcelain;
  const cwd = path.resolve(workspace);
  const r = run(cwd);
  if (!r.ok) {
    const err = (r.stderr || "git status --porcelain failed").trim().slice(0, 120);
    return { available: false, porcelainLineCount: 0, porcelainPreview: [], error: err };
  }
  const lines = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l !== "");
  return {
    available: true,
    porcelainLineCount: lines.length,
    porcelainPreview: lines.slice(0, maxPreviewLines),
  };
}

export function enrichProbeMismatchesWithIo(
  mismatches: readonly EffectReconcileMismatch[],
  resolveRecord: (effectId: string) => EffectRecord | undefined,
): EffectReconcileProbeIoHint[] {
  const out: EffectReconcileProbeIoHint[] = [];
  for (const m of mismatches) {
    const resourceKey = resourceKeyFromEffectRecord(resolveRecord(m.effectId));
    if (!resourceKey) continue;
    out.push({
      effectId: m.effectId,
      resource: probeResourcePath(resourceKey),
    });
  }
  return out;
}

export function formatResourceProbeLine(probe: ResourceProbeResult): string {
  if (!probe.exists) return `fs: missing ${probe.path}`;
  const bits = [probe.kind ?? "?", probe.size !== undefined ? `${probe.size}B` : undefined]
    .filter(Boolean)
    .join(" ");
  return `fs: ${probe.path} (${bits})`;
}

export function formatVcsProbeLine(snap: VcsProbeSnapshot): string | undefined {
  if (!snap.available) {
    return snap.error ? `vcs: unavailable (${snap.error})` : "vcs: unavailable";
  }
  if (snap.porcelainLineCount === 0) return "vcs: git status --porcelain clean";
  const preview = snap.porcelainPreview.join("; ");
  const more = snap.porcelainLineCount > snap.porcelainPreview.length
    ? ` (+${snap.porcelainLineCount - snap.porcelainPreview.length} lines)`
    : "";
  return `vcs: ${snap.porcelainLineCount} dirty path(s) — ${preview}${more}`;
}

export function formatProbeIoHintLine(hint: EffectReconcileProbeIoHint): string {
  const resource = hint.resource ? formatResourceProbeLine(hint.resource) : "fs: (no resourceKey)";
  return `${hint.effectId.slice(0, 8)}… ${resource}`;
}
