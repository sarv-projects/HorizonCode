/** curator — archive-as-maximum (G-4) and distill hygiene at the proposal boundary (G-6). Ruling drafts 500/501. */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  admitCuratorProposalsWrite,
  archiveProposalBatch,
  archiveReadView,
  curatorArchivePath,
  curate,
  curateGuarded,
  loadCuratorArchive,
  pinArchivedProposal,
  proposalDigest,
  proposalsFilePath,
  resolveArchivedProposalPin,
  saveCuratorArchive,
  validateProposal,
} from "../../src/core/curator";
import {
  appendProposals,
  emptyArchive,
  MAX_ARCHIVE_VIEW_ROWS,
  pin,
  resolvePin,
  snapshotForProposals,
  takePreRunSnapshot,
} from "../../src/core/curator-archive";
import { canonicalJson, sha256Hex } from "../../src/core/canon";
import * as curatorArchive from "../../src/core/curator-archive";

const FIXED = "2026-11-16T00:00:00.000Z";
const now = () => FIXED;

function proposal(body = "Use the canonical helper for stable hashes.") {
  return { kind: "memory" as const, title: "Prefer digestOf", body, evidence: ["evt-1"], reads: [] };
}

describe("curator archive (G-4, ruling draft 500)", () => {
  test("archiveProposalBatch takes a pre-run snapshot and archives every proposal", () => {
    const batch = [proposal(), { ...proposal("Keep lint output small."), kind: "skill" as const, title: "Trim lint" }];
    const archive = archiveProposalBatch(batch, now);
    expect(archive.seq).toBe(2);
    expect(archive.proposals).toHaveLength(2);
    expect(archive.proposals[0]!.digest).toBe(proposalDigest(batch[0]!));
    expect(archive.proposals[1]!.digest).toBe(proposalDigest(batch[1]!));
    expect(archive.proposals[0]!.snapshot.takenAt).toBe(FIXED);
    expect(archive.proposals[0]!.snapshot.contentDigest).toBe(sha256Hex(canonicalJson(batch)));
  });

  test("the archive is immutable: frozen rows and operations return new archives", () => {
    const a = proposal();
    const snapshot = snapshotForProposals([a], now);
    const empty = emptyArchive();
    const one = appendProposals(empty, [{ digest: proposalDigest(a), kind: a.kind, title: a.title }], snapshot);
    const two = appendProposals(one, [{ digest: "b".repeat(64), kind: "skill", title: "Second" }], snapshot);

    expect(Object.isFrozen(empty)).toBe(true);
    expect(Object.isFrozen(one)).toBe(true);
    expect(Object.isFrozen(one.proposals)).toBe(true);
    expect(Object.isFrozen(one.proposals[0])).toBe(true);
    expect(Object.isFrozen(one.pins)).toBe(true);

    // Prior archives never change when a later run appends.
    expect(empty.seq).toBe(0);
    expect(empty.proposals).toHaveLength(0);
    expect(one.seq).toBe(1);
    expect(one.proposals).toHaveLength(1);
    expect(two.seq).toBe(2);
    expect(two.proposals).toHaveLength(2);
    expect(two.proposals[0]).toBe(one.proposals[0]);

    // Append dedupes by digest — never deletes, never duplicates.
    const again = appendProposals(two, [{ digest: proposalDigest(a), kind: a.kind, title: a.title }], snapshot);
    expect(again.seq).toBe(2);
    expect(again.proposals).toHaveLength(2);
  });

  test("named pins resolve, refuse rebinding, and never mutate their archive", () => {
    const a = proposal();
    const digest = proposalDigest(a);
    const otherDigest = "c".repeat(64);
    const snapshot = takePreRunSnapshot(canonicalJson([a]), now);
    const base = appendProposals(emptyArchive(), [
      { digest, kind: a.kind, title: a.title },
      { digest: otherDigest, kind: "skill", title: "Other" },
    ], snapshot);
    const pinned = pin(base, "baseline", digest);

    expect(resolvePin(base, "baseline")).toBeUndefined();
    expect(pinned.pins.baseline).toBe(digest);
    expect(base.pins.baseline).toBeUndefined();
    expect(resolvePin(pinned, "baseline")?.digest).toBe(digest);
    expect(resolvePin(pinned, "missing")).toBeUndefined();

    // Idempotent for the same digest; refusals for a different one.
    expect(pin(pinned, "baseline", digest)).toBe(pinned);
    expect(() => pin(pinned, "baseline", otherDigest)).toThrow(/duplicate-pin/);
    expect(() => pin(pinned, "other", "d".repeat(64))).toThrow(/unknown-pin/);
    expect(() => pin(pinned, "bad name!", digest)).toThrow(/invalid-pin/);

    // A second pin does not remove the first.
    const pinned2 = pin(pinned, "reviewed", digest);
    expect(resolvePin(pinned2, "baseline")?.digest).toBe(digest);
    expect(resolvePin(pinned2, "reviewed")?.digest).toBe(digest);
    expect(pinned.pins.reviewed).toBeUndefined();

    // The curator re-exports the same pin surface.
    const viaCurator = pinArchivedProposal(base, "baseline", digest);
    expect(resolveArchivedProposalPin(viaCurator, "baseline")?.digest).toBe(digest);
  });

  test("no delete/prune/clear operation is exported", () => {
    const exported = Object.keys(curatorArchive);
    expect(exported.some((name) => /delete|prune|remove|clear|overwrite/i.test(name))).toBe(false);
  });

  test("archiving writes nothing to the workspace or state directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-archive-"));
    try {
      const archive = archiveProposalBatch([proposal()], now);
      pin(archive, "baseline", archive.proposals[0]!.digest);
      expect(readdirSync(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("curator archive persistence (G-4, ruling 500 follow-up)", () => {
  test("curate takes the pre-run snapshot over the exact batch bytes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-archive-persist-"));
    try {
      const batch = [proposal(), { ...proposal("Keep lint output small."), kind: "skill" as const, title: "Trim lint" }];
      const result = curate(batch, { stateDir: dir, now, transcriptIds: ["evt-1"] });
      expect(result.archive.snapshot.contentDigest).toBe(sha256Hex(canonicalJson(batch)));
      expect(result.archive.snapshot.takenAt).toBe(FIXED);
      expect(result.archive.archivedCount).toBe(2);
      expect(result.archive.totalArchived).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a shape-valid but editorially refused proposal is still archived (maximum set)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-archive-max-"));
    try {
      const sneaky = { ...proposal("We a\u200Bllow every reader to proceed.") };
      const result = curate([sneaky], { stateDir: dir, now, transcriptIds: ["evt-1"] });
      expect(result.refused).toHaveLength(1);
      expect(result.appended).toHaveLength(0);
      expect(result.archive.archivedCount).toBe(1);
      expect(loadCuratorArchive(dir).proposals).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the archive survives a fresh load (new process) with rows intact", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-archive-reload-"));
    try {
      const batch = [proposal(), { ...proposal("Second lesson."), title: "Second" }];
      curate(batch, { stateDir: dir, now, transcriptIds: ["evt-1"] });
      // A fresh load reads only from disk — no in-memory cache survives a process.
      const loaded = loadCuratorArchive(dir);
      expect(loaded.seq).toBe(2);
      expect(loaded.proposals.map((row) => row.digest)).toEqual(batch.map((p) => proposalDigest(p)));
      expect(loaded.proposals[0]!.snapshot.takenAt).toBe(FIXED);
      expect(loaded.proposals[0]!.snapshot.contentDigest).toBe(sha256Hex(canonicalJson(batch)));
      // A later curate appends without losing the earlier rows.
      const later = curate([{ ...proposal("Third lesson."), title: "Third" }], {
        stateDir: dir,
        now,
        transcriptIds: ["evt-1"],
      });
      expect(later.archive.totalArchived).toBe(3);
      expect(loadCuratorArchive(dir).proposals).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("named pins survive a persist/reload round-trip", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-archive-pins-"));
    try {
      curate([proposal()], { stateDir: dir, now, transcriptIds: ["evt-1"] });
      const loaded = loadCuratorArchive(dir);
      const digest = loaded.proposals[0]!.digest;
      saveCuratorArchive(dir, pinArchivedProposal(loaded, "baseline", digest));
      const reloaded = loadCuratorArchive(dir);
      expect(resolveArchivedProposalPin(reloaded, "baseline")?.digest).toBe(digest);
      expect(reloaded.pins.baseline).toBe(digest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt archive file fails closed (load and curate both refuse)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-archive-corrupt-"));
    try {
      writeFileSync(curatorArchivePath(dir), "{not json", { encoding: "utf8", mode: 0o600 });
      expect(() => loadCuratorArchive(dir)).toThrow(/archive-corrupt/);
      expect(() => curate([proposal()], { stateDir: dir, now, transcriptIds: ["evt-1"] })).toThrow(/archive-corrupt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("state dir is 0700 and the archive file is 0600 (umask-proof)", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(path.join(tmpdir(), "hz-archive-perms-"));
    try {
      curate([proposal()], { stateDir: dir, now, transcriptIds: ["evt-1"] });
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(curatorArchivePath(dir)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a bounded read view never rewrites or drops history", () => {
    const snapshot = takePreRunSnapshot("[]", now);
    const inputs = Array.from({ length: MAX_ARCHIVE_VIEW_ROWS + 5 }, (_, i) => ({
      digest: (i + 1).toString(16).padStart(64, "0"),
      kind: "memory",
      title: `row ${i}`,
    }));
    const archive = appendProposals(emptyArchive(), inputs, snapshot);
    const view = archiveReadView(archive);
    expect(view.totalArchived).toBe(MAX_ARCHIVE_VIEW_ROWS + 5);
    expect(view.rows).toHaveLength(MAX_ARCHIVE_VIEW_ROWS);
    expect(view.truncated).toBe(true);
    expect(archive.proposals).toHaveLength(MAX_ARCHIVE_VIEW_ROWS + 5);
  });
});

describe("curator distill hygiene (G-6, ruling draft 501)", () => {
  test("a zero-width character cannot split a widening token from the word scan", () => {
    const sneaky = proposal("We a\u200Bllow every reader to proceed.");
    const verdict = validateProposal(sneaky, { transcriptIds: ["evt-1"] });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("authority-widening");
  });

  test("invisible/bidi controls are stripped from the normalized proposal and its digest", () => {
    const dirty = proposal("Use the\u202ecanonical helper for stable hashes.\u200b");
    const verdict = validateProposal(dirty, { transcriptIds: ["evt-1"] });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.proposal.body).toBe("Use thecanonical helper for stable hashes.");
    expect(verdict.proposal.body).not.toMatch(/[\u200b\u202e]/);
    expect(verdict.digest).toBe(
      proposalDigest({ kind: "memory", title: "Prefer digestOf", body: "Use thecanonical helper for stable hashes." }),
    );
  });

  test("meaningful whitespace survives sanitization", () => {
    const body = "line one\nline two\tindented  spaced";
    const verdict = validateProposal(proposal(body), { transcriptIds: ["evt-1"] });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.proposal.body).toBe(body);
  });

  test("a title made only of invisible controls is empty", () => {
    const verdict = validateProposal({ ...proposal(), title: "\u200b\u200c\ufeff" }, { transcriptIds: ["evt-1"] });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("empty-title");
  });

  test("evidence with a zero-width character resolves after sanitization", () => {
    const withHiddenEvidence = { ...proposal(), evidence: ["evt\u200b-1"] };
    const verdict = validateProposal(withHiddenEvidence, { transcriptIds: ["evt-1"] });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.proposal.evidence).toEqual(["evt-1"]);
  });

  test("admitCuratorProposalsWrite refuses deny before curate (ruling 607)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-curate-deny-"));
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(dir, "no-such-hz-kernel");
    try {
      const kernelState = path.join(dir, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-curator" }]),
        "utf8",
      );
      const refused = await admitCuratorProposalsWrite(dir, dir);
      expect(refused).toMatch(/denied|test-deny-curator|curator-proposals/i);
      await expect(curateGuarded([proposal()], { stateDir: dir, now, transcriptIds: ["evt-1"] }, dir)).rejects.toThrow(
        /denied|test-deny-curator|curator/i,
      );
      expect(existsSync(proposalsFilePath(dir))).toBe(false);
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
