/** curator-apply — HZ_CURATOR_APPLY memory bank notes (ruling 242). */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  assertSafeMemoryBankNotePath,
  curatorApplyEnabled,
  memoryBankNotePath,
  memoryBankNotesDir,
  mergeMemoryBankNoteAppend,
  noteAlreadyContainsProposal,
} from "../../src/core/curator-apply";
import { curate, type StoredProposalRow } from "../../src/core/curator";
import { stateRoot } from "../../src/core/paths";
import { runGrowCli } from "../../src/grow";

const roots: string[] = [];
const envRestore = { ...process.env };

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
  for (const key of Object.keys(process.env)) {
    if (!(key in envRestore)) delete process.env[key];
  }
  Object.assign(process.env, envRestore);
});

function ws(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-curator-apply-"));
  roots.push(dir);
  return dir;
}

const ROW: Pick<StoredProposalRow, "title" | "body" | "digest" | "createdAt"> = {
  title: "Use the canonical JSON helper",
  body: "Hash rows with digestOf.",
  digest: "a".repeat(64),
  createdAt: "2026-11-13T00:00:00.000Z",
};

describe("curatorApplyEnabled", () => {
  test("off unless HZ_CURATOR_APPLY=1", () => {
    expect(curatorApplyEnabled({})).toBe(false);
    expect(curatorApplyEnabled({ HZ_CURATOR_APPLY: "0" })).toBe(false);
    expect(curatorApplyEnabled({ HZ_CURATOR_APPLY: "1" })).toBe(true);
  });
});

describe("memory bank note merge", () => {
  test("merge is append-only and dedupes by proposal digest marker", () => {
    const first = mergeMemoryBankNoteAppend(null, ROW);
    expect(first).toContain("digestOf");
    expect(first).toContain(`proposal ${ROW.digest}`);
    expect(mergeMemoryBankNoteAppend(first!, ROW)).toBeNull();
    expect(noteAlreadyContainsProposal(first!, ROW.digest)).toBe(true);
  });

  test("assertSafeMemoryBankNotePath refuses escape targets", () => {
    const workspace = ws();
    const legit = memoryBankNotePath(workspace, ROW);
    expect(() => assertSafeMemoryBankNotePath(workspace, legit)).not.toThrow();
    const escape = path.join(stateRoot(workspace), "MEMORY.md");
    expect(() => assertSafeMemoryBankNotePath(workspace, escape)).toThrow(/path-escape/);
  });

  test("symlinked notes dir still resolves under memory root", () => {
    const workspace = ws();
    const root = stateRoot(workspace);
    mkdirSync(path.join(root, "memory"), { recursive: true });
    const outside = path.join(workspace, "outside-note.md");
    writeFileSync(outside, "x", { mode: 0o600 });
    const notes = memoryBankNotesDir(workspace);
    mkdirSync(path.dirname(notes), { recursive: true });
    try {
      symlinkSync(outside, notes);
    } catch {
      return;
    }
    expect(() => assertSafeMemoryBankNotePath(workspace, path.join(notes, "evil.md"))).toThrow(/path-escape/);
  });
});

describe("grow --apply with HZ_CURATOR_APPLY", () => {
  test("dry run prints bank note path and touches nothing", async () => {
    const workspace = ws();
    const stateDir = path.join(workspace, ".hz", "state");
    mkdirSync(stateDir, { recursive: true });
    const proposal = {
      kind: "memory" as const,
      title: "Prefer digestOf",
      body: "Use the canonical JSON helper for stable digests.",
      evidence: ["evt-1"],
      reads: [],
    };
    const curated = curate([proposal], { stateDir, transcriptIds: ["evt-1"] });
    const digest = curated.appended[0]!.digest;
    process.env.HZ_CURATOR_APPLY = "1";
    const lines: string[] = [];
    const code = await runGrowCli(["--apply", digest, "--workspace", workspace], {
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });
    expect(code).toBe(2);
    const text = lines.join("\n");
    expect(text).toContain("memory bank note append");
    expect(text).toContain("memory/notes/");
    const notePath = memoryBankNotePath(workspace, { title: proposal.title, digest });
    expect(existsSync(notePath)).toBe(false);
  });

  test(
    "with --yes appends note under memory/notes and records receipt",
    async () => {
      const workspace = ws();
      const stateDir = path.join(workspace, ".hz", "state");
      mkdirSync(stateDir, { recursive: true });
      const proposal = {
        kind: "memory" as const,
        title: "Prefer digestOf",
        body: "Use the canonical JSON helper for stable digests.",
        evidence: ["evt-1"],
        reads: [],
      };
      const curated = curate([proposal], { stateDir, transcriptIds: ["evt-1"] });
      const digest = curated.appended[0]!.digest;
      process.env.HZ_CURATOR_APPLY = "1";
      const code = await runGrowCli(["--apply", digest, "--yes", "--workspace", workspace], {
        out: () => undefined,
        err: (l) => {
          throw new Error(l);
        },
      });
      expect(code).toBe(0);
      const notePath = memoryBankNotePath(workspace, { title: proposal.title, digest });
      const note = readFileSync(notePath, "utf8");
      expect(note).toContain(proposal.body);
      expect(note).toContain("Prefer digestOf");
      expect(note).toContain(`proposal ${digest}`);
    },
    30000,
  );

  test("skill proposals refused when HZ_CURATOR_APPLY=1", async () => {
    const workspace = ws();
    const stateDir = path.join(workspace, ".hz", "state");
    mkdirSync(stateDir, { recursive: true });
    const proposal = {
      kind: "skill" as const,
      title: "Lint helper",
      body: "Run lint on save.",
      evidence: ["evt-1"],
      reads: ["src/core"],
    };
    const curated = curate([proposal], { stateDir, transcriptIds: ["evt-1"] });
    process.env.HZ_CURATOR_APPLY = "1";
    const errors: string[] = [];
    const code = await runGrowCli(["--apply", curated.appended[0]!.digest, "--yes", "--workspace", workspace], {
      out: () => undefined,
      err: (l) => errors.push(l),
    });
    expect(code).toBe(3);
    expect(errors.join("\n")).toContain("memory bank note apply only");
  });
});
