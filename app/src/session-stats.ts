/**
 * J-5 CLI: summarise the post-mortem corpus and emit read-only tool/prompt
 * tuning suggestions over it. Never mutates sessions and never uses the network.
 *
 *   bun run src/session-stats.ts --postmortems <state-dir>
 *   bun run src/session-stats.ts --postmortems <state-dir> --suggest
 *   bun run src/session-stats.ts --postmortems <state-dir> --json
 */

import * as path from "node:path";
import { loadPostmortems } from "./core/postmortem";
import { metricContract } from "./core/metrics";
import {
  buildWorkspaceCorpusReport,
  histogramFromPostmortems,
  renderCorpusTuningReport,
  renderFullCorpusSummary,
  renderFullCorpusTuningReport,
  renderSessionCorpusSummary,
  suggestCorpusTuning,
} from "./core/session-corpus-stats";

/**
 * H-7 / ruling 510 — the corrupt-file count this CLI reports is a published
 * numeric statistic, so it is contracted before any rendering. The state dir
 * is known; the loader does not expose the total number of files scanned, so
 * that part of the population is honestly "unknown" rather than fabricated.
 */
function corruptQuarantineBlock(stateDir: string, count: number): string {
  return metricContract({
    metric: "corrupt post-mortems quarantined during load",
    anchor: "none — first measurement (no prior load of this state dir to compare against)",
    population: `post-mortem files under ${stateDir}; total files scanned unknown`,
    excludes: "none — every unparseable post-mortem file is quarantined, never read as empty",
    value: count,
  });
}

const USAGE =
  "usage: bun run src/session-stats.ts (--postmortems <state-dir> | --workspace <workspace>) [--suggest|--tune] [--json]";

function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? "" : value;
}

export async function runSessionStatsCli(argv: readonly string[]): Promise<number> {
  const workspace = argValue(argv, "--workspace");
  const suggest = argv.includes("--suggest") || argv.includes("--tune");
  const json = argv.includes("--json");

  // Full-corpus mode: post-mortems + the session SQLite DB + Markdown transcripts.
  // Bounded and read-only; --suggest/--tune/--json all apply to the fuller corpus.
  if (workspace !== undefined) {
    if (workspace === "") {
      console.error(USAGE);
      return 2;
    }
    const report = await buildWorkspaceCorpusReport(path.resolve(workspace));
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else if (suggest) {
      console.log(renderFullCorpusTuningReport(report));
    } else {
      console.log(renderFullCorpusSummary(report));
    }
    return 0;
  }

  const dir = argValue(argv, "--postmortems");
  if (dir === undefined || dir === "") {
    console.error(USAGE);
    return 2;
  }
  const stateDir = path.resolve(dir);
  const loaded = await loadPostmortems(stateDir);
  // H-7/ruling 510: contract the load-status number. The human status line
  // below is kept byte-identical; this block is its machine-readable form and
  // is surfaced through the --json publication surface.
  const quarantinePublished = loaded.corrupt ? [corruptQuarantineBlock(stateDir, loaded.quarantine.length)] : [];
  if (loaded.corrupt) {
    console.error(`session-stats: ${loaded.quarantine.length} corrupt post-mortem(s) quarantined`);
  }
  const summary = histogramFromPostmortems(loaded.postmortems);
  if (json) {
    const report = suggestCorpusTuning(loaded.postmortems);
    // Additive top-level `published` (summary + suggestions + load status).
    // The existing `summary` / `suggestions` fields are left unchanged so the
    // machine-readable output stays backward compatible.
    console.log(JSON.stringify({ ...report, published: [...report.published, ...quarantinePublished] }, null, 2));
    return 0;
  }
  if (suggest) {
    console.log(renderCorpusTuningReport(suggestCorpusTuning(loaded.postmortems)));
    return 0;
  }
  console.log(renderSessionCorpusSummary(summary));
  return 0;
}

if (import.meta.main) {
  void runSessionStatsCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
