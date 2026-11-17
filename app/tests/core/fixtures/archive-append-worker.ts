/**
 * Child-process worker for the curator archive cross-process lock test.
 * Each mode is one real OS process contending with its siblings.
 *   append <stateDir> <tag>   append one distinct artifact row + snapshot
 *   dump   <stateDir>         print the loaded archive's row digests as JSON
 */
import { appendArchiveArtifacts, loadCuratorArchive } from "../../../src/core/curator-archive";
import { sha256Hex } from "../../../src/core/canon";

const [mode, stateDir, tag] = process.argv.slice(2);

if (mode === "append") {
  const snapshot = { contentDigest: sha256Hex(`batch-${tag}`), takenAt: "2026-11-17T12:00:00.000Z" };
  const result = appendArchiveArtifacts(stateDir!, {
    snapshots: [snapshot],
    rows: [{ seq: 0, digest: sha256Hex(`row-${tag}`), kind: "memory", title: `row-${tag}`, snapshot }],
  });
  console.log(JSON.stringify({ ok: true, appendedLines: result.appendedLines, total: result.archive.seq }));
} else if (mode === "dump") {
  const archive = loadCuratorArchive(stateDir!);
  console.log(JSON.stringify({ ok: true, digests: archive.proposals.map((row) => row.digest), seq: archive.seq }));
} else {
  console.log(JSON.stringify({ ok: false, error: "bad mode" }));
  process.exitCode = 1;
}
