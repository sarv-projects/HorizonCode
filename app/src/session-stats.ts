/**
 * J-5 CLI: summarise post-mortem corpus tool usage.
 *
 *   bun run src/session-stats.ts --postmortems <state-dir>
 */

import * as path from "node:path";
import { loadPostmortems } from "./core/postmortem";
import { histogramFromPostmortems, renderSessionCorpusSummary } from "./core/session-corpus-stats";

const USAGE = "usage: bun run src/session-stats.ts --postmortems <state-dir>";

function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? "" : value;
}

export async function runSessionStatsCli(argv: readonly string[]): Promise<number> {
  const dir = argValue(argv, "--postmortems");
  if (dir === undefined || dir === "") {
    console.error(USAGE);
    return 2;
  }
  const stateDir = path.resolve(dir);
  const loaded = await loadPostmortems(stateDir);
  if (loaded.corrupt) {
    console.error(`session-stats: ${loaded.quarantine.length} corrupt post-mortem(s) quarantined`);
  }
  const summary = histogramFromPostmortems(loaded.postmortems);
  console.log(renderSessionCorpusSummary(summary));
  return 0;
}

if (import.meta.main) {
  void runSessionStatsCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
