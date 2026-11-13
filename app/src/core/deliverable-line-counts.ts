/**
 * present residual: line counts for declared deliverables (git numstat when
 * possible, else file line count).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "path";

export interface DeliverableLineStat {
  rel: string;
  lines: number;
  /** Present when git reported a diff stat for this path. */
  gitDelta?: string;
}

function countFileLines(abs: string): number {
  try {
    const text = readFileSync(abs, "utf8");
    if (text === "") return 0;
    return text.split(/\r?\n/).length;
  } catch {
    return -1;
  }
}

function gitNumstat(workspace: string, rel: string): string | undefined {
  const r = spawnSync("git", ["diff", "--numstat", "HEAD", "--", rel], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.status !== 0 || !r.stdout.trim()) return undefined;
  const line = r.stdout.trim().split("\n")[0]?.trim() ?? "";
  const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
  if (!m) return undefined;
  return `+${m[1]}/-${m[2]}`;
}

export function deliverableLineStats(workspace: string, relPaths: readonly string[]): DeliverableLineStat[] {
  const root = path.resolve(workspace);
  const out: DeliverableLineStat[] = [];
  for (const rel of relPaths) {
    const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
    const abs = path.join(root, norm);
    const stat: DeliverableLineStat = { rel: norm, lines: existsSync(abs) ? countFileLines(abs) : -1 };
    const delta = gitNumstat(root, norm);
    if (delta !== undefined) stat.gitDelta = delta;
    out.push(stat);
  }
  return out;
}

export function formatDeliverableLineStats(stats: readonly DeliverableLineStat[]): string[] {
  return stats.map((s) => {
    const base = s.lines >= 0 ? `${s.lines} line(s)` : "missing";
    return s.gitDelta ? `- ${s.rel}: ${base} (git ${s.gitDelta})` : `- ${s.rel}: ${base}`;
  });
}
