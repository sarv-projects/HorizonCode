/** curator-archive NDJSON append log (G-4 residual):
 *  append order, cross-process reload, pins, fail-closed, concurrency, perms,
 *  and migration of legacy canonical-JSON snapshot files without rewriting. */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  appendArchiveArtifacts,
  appendProposals,
  archiveLockPath,
  curatorArchivePath,
  emptyArchive,
  loadArchiveLog,
  loadCuratorArchive,
  parseArchiveLog,
  pin as pinArchive,
  saveCuratorArchive,
  serializeArchive,
  snapshotForProposals,
  type PreRunSnapshot,
} from "../../src/core/curator-archive";
import { sha256Hex } from "../../src/core/canon";

const FIXED = "2026-11-17T00:00:00.000Z";
const now = () => FIXED;
const WORKER = path.join(import.meta.dir, "fixtures", "archive-append-worker.ts");

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "hz-archive-log-"));
}

function makeRun(tag: string, titles: string[]): { snapshot: PreRunSnapshot; rows: Array<{ seq: number; digest: string; kind: string; title: string; snapshot: PreRunSnapshot }> } {
  const snapshot = { contentDigest: sha256Hex(`batch-${tag}`), takenAt: FIXED };
  return {
    snapshot,
    rows: titles.map((title, i) => ({ seq: 0, digest: sha256Hex(`${tag}-${i}`), kind: "memory", title, snapshot })),
  };
}

async function runWorker(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", WORKER, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out: out.trim(), err: err.trim() };
}

describe("curator archive NDJSON append log (G-4 residual)", () => {
  test("append order is preserved; artifacts are distinct immutable lines with a contiguous chain", () => {
    const dir = tempDir();
    try {
      const a = makeRun("a", ["one", "two"]);
      appendArchiveArtifacts(dir, { snapshots: [a.snapshot], rows: a.rows });
      // A pin and a refusal are separate artifact lines, in append order.
      appendArchiveArtifacts(dir, {
        pins: { baseline: a.rows[0]!.digest },
        refusals: [{ digest: sha256Hex("refused-one"), reason: "authority-widening", detail: "scan hit" }],
      });
      const view = loadArchiveLog(dir);
      expect(view.lines.map((line) => line.type)).toEqual(["snapshot", "pin", "refusal"]);
      expect(view.lines.map((line) => line.seq)).toEqual([1, 2, 3]);
      expect(view.lines[0]!.prev).toBe("0".repeat(64));
      expect(view.lines[1]!.prev).toBe(view.lines[0]!.id);
      expect(view.lines[2]!.prev).toBe(view.lines[1]!.id);
      expect(view.archive.proposals.map((row) => row.digest)).toEqual(a.rows.map((row) => row.digest));
      expect(view.archive.proposals.map((row) => row.seq)).toEqual([1, 2]);
      expect(view.refusals).toHaveLength(1);
      expect(view.refusals[0]!.reason).toBe("authority-widening");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fresh process reload sees every line and keeps all rows and pins", async () => {
    const dir = tempDir();
    try {
      const a = makeRun("a", ["one", "two"]);
      const b = makeRun("b", ["three"]);
      appendArchiveArtifacts(dir, { snapshots: [a.snapshot], rows: a.rows });
      appendArchiveArtifacts(dir, { snapshots: [b.snapshot], rows: b.rows });
      saveCuratorArchive(dir, pinArchive(loadCuratorArchive(dir), "reviewed", b.rows[0]!.digest));

      // A new process reads only the file — no in-memory state survives.
      const child = await runWorker("dump", dir);
      expect(child.code).toBe(0);
      const dumped = JSON.parse(child.out);
      expect(dumped.seq).toBe(3);
      expect(dumped.digests).toEqual([...a.rows, ...b.rows].map((row) => row.digest));
      expect(loadArchiveLog(dir).archive.pins.reviewed).toBe(b.rows[0]!.digest);
      expect(loadArchiveLog(dir).lines).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("named pins survive multiple appends and rebinding is refused", () => {
    const dir = tempDir();
    try {
      const a = makeRun("a", ["one", "two"]);
      appendArchiveArtifacts(dir, { snapshots: [a.snapshot], rows: a.rows });
      saveCuratorArchive(dir, pinArchive(loadCuratorArchive(dir), "baseline", a.rows[0]!.digest));
      const b = makeRun("b", ["three"]);
      appendArchiveArtifacts(dir, { snapshots: [b.snapshot], rows: b.rows });
      expect(loadCuratorArchive(dir).pins.baseline).toBe(a.rows[0]!.digest);
      expect(() =>
        appendArchiveArtifacts(dir, { pins: { baseline: a.rows[1]!.digest } }),
      ).toThrow(/archive-corrupt.*already bound/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt line fails closed: a bad JSON line and a forged id both refuse the whole log", () => {
    const dir = tempDir();
    try {
      const a = makeRun("a", ["one", "two"]);
      appendArchiveArtifacts(dir, { snapshots: [a.snapshot], rows: a.rows });
      const file = curatorArchivePath(dir);
      const good = readFileSync(file, "utf8");

      writeFileSync(file, `${good}not-json\n`, "utf8");
      expect(() => loadCuratorArchive(dir)).toThrow(/archive-corrupt/);
      expect(() => loadArchiveLog(dir)).toThrow(/archive-corrupt/);

      // Forge the content address of the first line; the chain breaks.
      const lines = good.trim().split("\n");
      const parsed = JSON.parse(lines[0]!);
      parsed.id = sha256Hex("forged");
      writeFileSync(file, `${JSON.stringify(parsed)}\n${lines.slice(1).join("\n")}\n`, "utf8");
      expect(() => loadCuratorArchive(dir)).toThrow(/archive-corrupt.*content address/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two concurrent processes serialize appends: no lost rows, seq stays gapless", async () => {
    const dir = tempDir();
    try {
      const results = await Promise.all([
        runWorker("append", dir, "left"),
        runWorker("append", dir, "right"),
      ]);
      for (const result of results) expect(result.code).toBe(0);
      expect(results.map((r) => JSON.parse(r.out).appendedLines)).toEqual([1, 1]);

      const view = loadArchiveLog(dir);
      expect(view.lines.map((line) => line.seq)).toEqual([1, 2]);
      expect(view.lines[1]!.prev).toBe(view.lines[0]!.id);
      expect(view.archive.proposals.map((row) => row.digest).sort()).toEqual(
        [sha256Hex("row-left"), sha256Hex("row-right")].sort(),
      );
      expect(view.archive.seq).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("permissions: 0700 dir, 0600 file, and no residual lock file", () => {
    if (process.platform === "win32") return;
    const dir = tempDir();
    try {
      const a = makeRun("a", ["one"]);
      appendArchiveArtifacts(dir, { snapshots: [a.snapshot], rows: a.rows });
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(curatorArchivePath(dir)).mode & 0o777).toBe(0o600);
      expect(existsSync(archiveLockPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("migration reads a legacy canonical-JSON snapshot as a base without rewriting it", () => {
    const dir = tempDir();
    try {
      const a = makeRun("a", ["legacy-one"]);
      // Build a legacy v1 snapshot archive and write its canonical JSON file.
      const snapshot = snapshotForProposals([], now);
      const legacy = appendProposals(emptyArchive(), [{ digest: a.rows[0]!.digest, kind: "memory", title: "legacy-one" }], snapshot);
      const legacyBytes = serializeArchive(legacy);
      writeFileSync(curatorArchivePath(dir), legacyBytes, "utf8");

      const b = makeRun("b", ["new-two"]);
      appendArchiveArtifacts(dir, { snapshots: [b.snapshot], rows: b.rows });

      const view = loadArchiveLog(dir);
      expect(view.legacyBase).toBe(true);
      expect(view.archive.proposals.map((row) => row.digest)).toEqual([a.rows[0]!.digest, b.rows[0]!.digest]);
      // The legacy first line is byte-identical to what was written.
      const firstLine = readFileSync(curatorArchivePath(dir), "utf8").split("\n")[0]!;
      expect(`${firstLine}\n`).toBe(legacyBytes);
      // Standalone parse (a new process) agrees.
      expect(parseArchiveLog(readFileSync(curatorArchivePath(dir), "utf8"), curatorArchivePath(dir)).archive.seq).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
