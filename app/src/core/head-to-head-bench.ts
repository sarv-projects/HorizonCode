/**
 * Reproducible head-to-head benchmark scaffold (ruling 644).
 *
 * Defines a fixed task matrix and competitor discovery so live runs against
 * Claude Code / Codex / Oh My Pi / OpenCode are comparable. Default is
 * **dry-run** (no competitor spawn). Set `HZ_H2H_LIVE=1` to attempt PATH
 * binaries — still fails closed per missing competitor rather than inventing
 * pass rates.
 *
 * Does **not** claim a completed 25–50 SWE-bench Verified live matrix here;
 * that requires external dataset + API keys + competitor installs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  admitVerificationFsWrite,
  resolveHzVerificationPath,
} from "./verification-artifact";
import { metricContract } from "./metrics";

export const H2H_COMPETITORS = [
  "horizoncode",
  "claude-code",
  "codex",
  "oh-my-pi",
  "opencode",
] as const;

export type H2HCompetitorId = (typeof H2H_COMPETITORS)[number];

export type H2HTask = {
  id: string;
  kind: "swebench-verified" | "multi-file-engineering";
  title: string;
  /** Honest: live instance id when dataset present; else fixture label. */
  instanceRef: string;
};

export type H2HCompetitorDiscovery = {
  id: H2HCompetitorId;
  available: boolean;
  binary?: string;
  detail: string;
};

export type H2HArmResult = {
  competitor: H2HCompetitorId;
  taskId: string;
  status: "dry_run" | "skipped_missing_binary" | "ran" | "error";
  pass?: boolean;
  costUsd?: number;
  wallMs?: number;
  humanInterruptions?: number;
  detail: string;
};

export type H2HReport = {
  schema: "hz.h2h.bench.v1";
  createdAt: string;
  live: boolean;
  taskCount: number;
  competitors: H2HCompetitorDiscovery[];
  results: H2HArmResult[];
  summary: string;
};

/** Default 25-task matrix: 20 SWE-bench slots + 5 multi-file engineering. */
export function defaultH2HTasks(count = 25): H2HTask[] {
  const n = Math.max(1, Math.min(50, Math.floor(count)));
  const tasks: H2HTask[] = [];
  const sweCount = Math.min(n, Math.max(0, n - 5));
  for (let i = 1; i <= sweCount; i++) {
    tasks.push({
      id: `swe-${String(i).padStart(2, "0")}`,
      kind: "swebench-verified",
      title: `SWE-bench Verified slot ${i}`,
      instanceRef: `swebench-verified:slot-${i}`,
    });
  }
  for (let i = 1; i <= n - sweCount; i++) {
    tasks.push({
      id: `eng-${String(i).padStart(2, "0")}`,
      kind: "multi-file-engineering",
      title: `Multi-file engineering task ${i}`,
      instanceRef: `hz-engineering:fixture-${i}`,
    });
  }
  return tasks;
}

const BINARY_CANDIDATES: Record<H2HCompetitorId, string[]> = {
  horizoncode: ["hzcode"],
  "claude-code": ["claude", "claude-code"],
  codex: ["codex"],
  "oh-my-pi": ["omp", "oh-my-pi"],
  opencode: ["opencode"],
};

function whichBinary(names: string[]): string | undefined {
  for (const name of names) {
    const p = Bun.which(name);
    if (p !== undefined && p !== "") return p;
  }
  return undefined;
}

export function discoverH2HCompetitors(
  which: readonly H2HCompetitorId[] = H2H_COMPETITORS,
): H2HCompetitorDiscovery[] {
  return which.map((id) => {
    const binary = whichBinary(BINARY_CANDIDATES[id]);
    if (binary) {
      return { id, available: true, binary, detail: `found ${binary}` };
    }
    return {
      id,
      available: false,
      detail: `no binary on PATH (${BINARY_CANDIDATES[id].join("|")})`,
    };
  });
}

export function h2hLiveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HZ_H2H_LIVE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Run the matrix. Dry-run records planned arms; live mode still skips missing
 * competitors and does not invent pass rates for unrun tasks.
 */
export function runHeadToHeadBench(opts: {
  tasks?: H2HTask[];
  competitors?: H2HCompetitorDiscovery[];
  live?: boolean;
  /** Product self-check: when live and horizoncode available, record a ran stub. */
  runHorizoncodeProbe?: (task: H2HTask) => H2HArmResult;
}): H2HReport {
  const tasks = opts.tasks ?? defaultH2HTasks(25);
  const competitors = opts.competitors ?? discoverH2HCompetitors();
  const live = opts.live ?? false;
  const results: H2HArmResult[] = [];

  for (const competitor of competitors) {
    for (const task of tasks) {
      if (!live) {
        results.push({
          competitor: competitor.id,
          taskId: task.id,
          status: "dry_run",
          detail: `planned ${competitor.id} × ${task.id} (${task.kind})`,
        });
        continue;
      }
      if (!competitor.available) {
        results.push({
          competitor: competitor.id,
          taskId: task.id,
          status: "skipped_missing_binary",
          detail: competitor.detail,
        });
        continue;
      }
      if (competitor.id === "horizoncode" && opts.runHorizoncodeProbe) {
        results.push(opts.runHorizoncodeProbe(task));
        continue;
      }
      // Live competitor spawn is intentionally not automated here: argv surfaces
      // differ wildly; operators supply adapters. Record honesty.
      results.push({
        competitor: competitor.id,
        taskId: task.id,
        status: "skipped_missing_binary",
        detail: `live adapter for ${competitor.id} not wired — binary present at ${competitor.binary}`,
      });
    }
  }

  const available = competitors.filter((c) => c.available).map((c) => c.id);
  const summary = live
    ? `H2H live scaffold: ${tasks.length} tasks × ${competitors.length} competitors; available=[${available.join(",") || "none"}]; no invented pass rates`
    : `H2H dry-run: ${tasks.length} tasks × ${competitors.length} competitors (${results.length} planned arms); set HZ_H2H_LIVE=1 for live discovery`;

  return {
    schema: "hz.h2h.bench.v1",
    createdAt: new Date().toISOString(),
    live,
    taskCount: tasks.length,
    competitors,
    results,
    summary,
  };
}

/**
 * H-7 metric contract for `hzcode h2h` counts (ruling 803+). The human summary
 * `report.summary` stays byte-identical; these parallel blocks carry
 * Metric/Anchor/Population/Excludes for each published number. In particular
 * no pass rate is published in dry-run (no competitor was invoked) or live
 * scaffold mode (no live adapter is wired), so no pass-rate claim is invented.
 */
export function h2hPublication(report: H2HReport): string[] {
  const anchor = "none — first h2h run (no prior matrix to compare against)";
  const population = report.live
    ? "this h2h live-scaffold matrix (planned arms only; no live adapter wired)"
    : "this h2h dry-run matrix (planned arms only)";
  const excludes = "no competitor invoked and no pass rate claimed — counts of configured/planned arms only; nothing discarded";
  const availableCount = report.competitors.filter((c) => c.available).length;
  return [
    metricContract({
      metric: "h2h task count",
      anchor,
      population,
      excludes,
      value: report.taskCount,
    }),
    metricContract({
      metric: "h2h competitor count",
      anchor,
      population,
      excludes,
      value: report.competitors.length,
    }),
    metricContract({
      metric: "h2h planned-arm count",
      anchor,
      population,
      excludes,
      value: report.results.length,
    }),
    metricContract({
      metric: "h2h available-competitor count",
      anchor,
      population,
      excludes,
      value: availableCount,
    }),
  ];
}

export async function writeH2HReport(workspace: string, report: H2HReport): Promise<string> {
  const fileName = `h2h-${report.live ? "live" : "dry"}-${Date.now()}.json`;
  const out = resolveHzVerificationPath(workspace, ["bench", "h2h"], fileName);
  const refused = await admitVerificationFsWrite(out, workspace);
  if (refused !== undefined) throw new Error(refused);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return out;
}
