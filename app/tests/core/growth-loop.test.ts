/**
 * growth-loop.test.ts — NF-075 reduced form v1: the review fork's cache parity
 * and read-only spec, the editorial standard, and the append-only curator.
 *
 * Acceptance docs/24 §12.2 #67, for the parts this slice implements: the review
 * fork reuses the parent's cached prefix byte-for-byte; a lesson violating the
 * do-not-capture block is rejected; the store is append-only. NOT in this slice
 * (and therefore not asserted here): post-turn scheduling, loop wiring, any
 * provider call, any application of a proposal, and the curator's
 * archive/snapshot/pin half — see the two module headers and the docs/28
 * status-map proposal in the change description.
 *
 * The dedupe digest is recomputed here two independent ways: from a locally
 * written canonical serializer over sha256Hex (contracts.ts), and in a FRESH
 * bun process importing the shipped helper — "byte-stable across runs" is a
 * claim about processes, not about one in-memory call.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sha256Hex } from "../../src/contracts";
import { canonicalJson } from "../../src/core/canon";
import {
  BODY_MAX_CHARS,
  buildReviewFork,
  cacheParity,
  ReviewForkError,
  TITLE_MAX_CHARS,
  type ReviewForkSpec,
  type ReviewProposalV1,
  type ReviewTranscriptEvent,
} from "../../src/core/review";
import {
  claimedPathsIn,
  curate,
  CuratorError,
  findAuthorityWidening,
  findDoNotCapture,
  PROPOSALS_FILE,
  proposalDigest,
  proposalsFilePath,
  type ProposalStore,
  type StoredProposalRow,
  validateProposal,
} from "../../src/core/curator";

/* -------------------------------- fixtures -------------------------------- */

/** One parent prefix, as the parent's compile step would have sent it. */
const PARENT_PREFIX = 'SYSTEM: horizoncode v0.1\nTOOLS: [read,grep,glob,shell]\nCONFIG: {provider:"mock"}\n';

const EVENTS: ReviewTranscriptEvent[] = [
  { id: "evt-1", type: "tool.result" },
  { id: "evt-2", type: "message.end" },
];

const TRANSCRIPT_IDS = EVENTS.map((event) => event.id);

function parentPrefixRecord(bytes = PARENT_PREFIX) {
  return { bytes, sha256: sha256Hex(bytes) };
}

/** A clean memory proposal: no widening tokens, no negative tool claims, read covered. */
function validProposal(overrides: Partial<ReviewProposalV1> = {}): ReviewProposalV1 {
  return {
    kind: "memory",
    title: "Prefer the canonical JSON helper for stored rows",
    body: "Hash store rows with src/core/canon.ts (digestOf) so digests stay byte-stable across runs.",
    evidence: ["evt-1"],
    reads: ["src/core"],
    ...overrides,
  };
}

/** A clean skill proposal; its body cites a path covered by its directory read. */
function skillProposal(overrides: Partial<ReviewProposalV1> = {}): ReviewProposalV1 {
  return {
    kind: "skill",
    title: "Add a ladder-fixture skill",
    body: "Point the skill at the byte-identical fixtures in app/tests/tools/edit-ladder.test.ts.",
    evidence: ["evt-2"],
    reads: ["app/tests/tools"],
    ...overrides,
  };
}

let workspace: string;
let state: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "hz-growth-ws-"));
  state = mkdtempSync(path.join(os.tmpdir(), "hz-growth-state-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

function forkInput(overrides: Record<string, unknown> = {}) {
  return {
    parentPrefix: parentPrefixRecord(),
    transcript: EVENTS,
    workspace,
    stateDir: state,
    ...overrides,
  } as Parameters<typeof buildReviewFork>[0];
}

function buildFork(overrides: Record<string, unknown> = {}): ReviewForkSpec {
  return buildReviewFork(forkInput(overrides));
}

function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error("expected the call to throw, but it returned");
}

function storeFixture(overrides: Partial<ProposalStore> = {}): ProposalStore {
  return { stateDir: state, transcriptIds: TRANSCRIPT_IDS, now: () => "2026-01-02T03:04:05.006Z", ...overrides };
}

function storeLines(): string[] {
  return readFileSync(proposalsFilePath(state), "utf8").split("\n").filter((line) => line !== "");
}

function storeRows(): StoredProposalRow[] {
  return storeLines().map((line) => JSON.parse(line) as StoredProposalRow);
}

/** A canonical serializer written here, not imported: sorted keys, compact. */
function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalStringify).join(",") + "]";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalStringify(record[key])).join(",") + "}";
}

/* ------------------------- review fork: cache parity ------------------------- */

describe("review fork — cache parity (NF-075(a))", () => {
  test("cacheParity: identical bytes share a digest; a one-byte change breaks both halves", () => {
    const same = cacheParity(PARENT_PREFIX, PARENT_PREFIX);
    expect(same.parentSha256).toBe(sha256Hex(PARENT_PREFIX));
    expect(same.forkSha256).toBe(same.parentSha256);
    expect(same.identical).toBe(true);

    const drifted = cacheParity(PARENT_PREFIX, PARENT_PREFIX + "\n");
    expect(drifted.identical).toBe(false);
    expect(drifted.parentSha256).not.toBe(drifted.forkSha256);
  });

  test("a prefix record that does not match the bytes is refused, typed", () => {
    const stale = { bytes: PARENT_PREFIX + "\n", sha256: sha256Hex(PARENT_PREFIX) }; // bytes drifted under a stale record
    const err = thrownBy(() => buildFork({ parentPrefix: stale }));
    expect(err).toBeInstanceOf(ReviewForkError);
    expect((err as ReviewForkError).reason).toBe("prefix-parity-mismatch");
    expect(err.message).toContain("full-price");
  });

  test("a matching record yields a spec whose system prefix IS the parent's bytes", () => {
    const spec = buildFork();
    expect(spec.origin).toBe("review-fork");
    expect(spec.systemPrefix).toBe(PARENT_PREFIX);
    expect(spec.cacheParity.parentSha256).toBe(sha256Hex(PARENT_PREFIX));
    expect(spec.cacheParity.forkSha256).toBe(spec.cacheParity.parentSha256);
    expect(spec.cacheParity.identical).toBe(true);
  });

  test("the review instruction is the tail, never an addition to the prefix", () => {
    const spec = buildFork();
    expect(spec.systemPrefix).not.toContain("review fork");
    expect(spec.prompt).toContain("EDITORIAL STANDARD");
    expect(spec.prompt).toContain(String(TITLE_MAX_CHARS));
    expect(spec.prompt).toContain(String(BODY_MAX_CHARS));
  });

  test("invalid scope is refused: relative paths, an empty prefix, an id-less event", () => {
    expect((thrownBy(() => buildFork({ workspace: "relative/ws" })) as ReviewForkError).reason).toBe("invalid-scope");
    expect((thrownBy(() => buildFork({ stateDir: "./state" })) as ReviewForkError).reason).toBe("invalid-scope");
    expect((thrownBy(() => buildFork({ parentPrefix: { bytes: "", sha256: sha256Hex("") } })) as ReviewForkError).reason).toBe(
      "invalid-scope",
    );
    const idless = [{ type: "tool.result" }] as unknown as ReviewTranscriptEvent[];
    expect((thrownBy(() => buildFork({ transcript: idless })) as ReviewForkError).reason).toBe("invalid-scope");
  });
});

/* --------------------------- review fork: read-only --------------------------- */

describe("review fork — read-only by construction", () => {
  test("the tool subset is closed and every entry is read-only", () => {
    const spec = buildFork();
    expect(spec.readOnly).toBe(true);
    expect(spec.persistenceIsolated).toBe(true);
    expect(spec.tools.map((tool) => tool.name)).toEqual(["read", "grep", "glob"]);
    for (const tool of spec.tools) {
      expect(tool.effectClass).toBe("read-only");
      expect(tool.guardKind).toBe("fs.read");
    }
    for (const mutating of ["write", "edit", "shell", "agent", "code_mode"]) {
      expect(spec.tools.map((tool) => tool.name)).not.toContain(mutating);
    }
  });

  test("the spec is data, not a running loop: no functions, and it round-trips as JSON", () => {
    const spec = buildFork();
    for (const value of Object.values(spec)) expect(typeof value).not.toBe("function");
    const round = JSON.parse(JSON.stringify(spec)) as ReviewForkSpec;
    expect(round.origin).toBe("review-fork");
    expect(round.systemPrefix).toBe(PARENT_PREFIX);
  });

  test("the transcript is frozen into the spec and its ids are exposed for evidence", () => {
    const spec = buildFork();
    expect(spec.transcriptIds).toEqual(["evt-1", "evt-2"]);
    EVENTS[0]!.id = "evt-mutated"; // mutating the caller's array must not reach the spec
    try {
      expect(spec.transcriptIds).toEqual(["evt-1", "evt-2"]);
      expect(spec.transcript[0]!.id).toBe("evt-1");
    } finally {
      EVENTS[0]!.id = "evt-1";
    }
  });
});

/* --------------------------- the editorial standard --------------------------- */

describe("editorial standard — validateProposal", () => {
  test("a clean memory proposal passes and reports its dedupe digest", () => {
    const verdict = validateProposal(validProposal(), { transcriptIds: TRANSCRIPT_IDS });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.proposal.kind).toBe("memory");
    expect(verdict.digest).toBe(proposalDigest(validProposal()));
    expect(verdict.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("empty title and empty body are refused", () => {
    const noTitle = validateProposal(validProposal({ title: "   " }), { transcriptIds: TRANSCRIPT_IDS });
    expect(noTitle.ok).toBe(false);
    if (!noTitle.ok) expect(noTitle.reason).toBe("empty-title");
    const noBody = validateProposal(validProposal({ body: "" }), { transcriptIds: TRANSCRIPT_IDS });
    expect(noBody.ok).toBe(false);
    if (!noBody.ok) expect(noBody.reason).toBe("empty-body");
  });

  test("oversized title and body are refused against the budget constants", () => {
    const longTitle = validateProposal(validProposal({ title: "t".repeat(TITLE_MAX_CHARS + 1) }), { transcriptIds: TRANSCRIPT_IDS });
    expect(longTitle.ok).toBe(false);
    if (!longTitle.ok) {
      expect(longTitle.reason).toBe("title-too-long");
      expect(longTitle.detail).toContain(String(TITLE_MAX_CHARS));
    }
    const atLimit = validateProposal(validProposal({ title: "t".repeat(TITLE_MAX_CHARS) }), { transcriptIds: TRANSCRIPT_IDS });
    expect(atLimit.ok).toBe(true);
    const longBody = validateProposal(validProposal({ body: "b".repeat(BODY_MAX_CHARS + 1) }), { transcriptIds: TRANSCRIPT_IDS });
    expect(longBody.ok).toBe(false);
    if (!longBody.ok) {
      expect(longBody.reason).toBe("body-too-long");
      expect(longBody.detail).toContain(String(BODY_MAX_CHARS));
    }
  });

  test("missing evidence is refused: none, non-strings, unknown ids, absolute paths", () => {
    const cases: Array<[string, unknown]> = [
      ["empty", []],
      ["non-string", [42]],
      ["unknown id", ["evt-nope"]],
      ["absolute path", ["/etc/passwd"]],
      ["parent-directory escape", ["../escape/file.ts"]],
    ];
    for (const [label, evidence] of cases) {
      const verdict = validateProposal(validProposal({ evidence: evidence as string[] }), { transcriptIds: TRANSCRIPT_IDS });
      expect(verdict.ok, `evidence case: ${label}`).toBe(false);
      if (!verdict.ok) expect(verdict.reason, `evidence case: ${label}`).toBe("missing-evidence");
    }
  });

  test("workspace-shaped evidence passes on shape — existence is not checked in v1", () => {
    const verdict = validateProposal(validProposal({ evidence: ["src/core/review.ts"] }), { transcriptIds: TRANSCRIPT_IDS });
    expect(verdict.ok).toBe(true);
  });

  test("read-before-write: a skill body citing an unread path is refused", () => {
    const verdict = validateProposal(skillProposal({ reads: [] }), { transcriptIds: TRANSCRIPT_IDS });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("unread-path");
      expect(verdict.detail).toContain("read-before-write");
    }
  });

  test("read-before-write: a directory read covers the paths beneath it", () => {
    const verdict = validateProposal(skillProposal({ reads: ["app/tests/tools"] }), { transcriptIds: TRANSCRIPT_IDS });
    expect(verdict.ok).toBe(true);
    const sibling = validateProposal(skillProposal({ body: "Point the skill at src/core/curator.ts.", reads: ["app/tests/tools"] }), {
      transcriptIds: TRANSCRIPT_IDS,
    });
    expect(sibling.ok).toBe(false);
    if (!sibling.ok) expect(sibling.reason).toBe("unread-path");
  });

  test("read-before-write applies to memory and skill, not to prompt proposals", () => {
    const prompt = validateProposal(validProposal({ kind: "prompt", body: "Tighten the step prompt around src/core/review.ts.", reads: [] }), {
      transcriptIds: TRANSCRIPT_IDS,
    });
    expect(prompt.ok).toBe(true);
  });

  test("authority-widening: every rejected token family trips the scan", () => {
    const families: Array<[string, string]> = [
      ["allow", "Allow the shell tool for this workspace."],
      ["grant", "Grant the review fork write access."],
      ["policy", "Relax the policy so edits stop asking."],
      ["permission", "Widen the permission set for writes."],
      ["chmod", "Run chmod +x on the helper script."],
      ["sudo", "Document the sudo rules used here."],
      ["approved-near-always", "This is always approved by the maintainer."],
    ];
    for (const [family, body] of families) {
      const verdict = validateProposal(validProposal({ body }), { transcriptIds: TRANSCRIPT_IDS });
      expect(verdict.ok, `family: ${family}`).toBe(false);
      if (!verdict.ok) {
        expect(verdict.reason, `family: ${family}`).toBe("authority-widening");
        expect(verdict.detail, `family: ${family}`).toContain(family);
      }
    }
  });

  test("authority-widening: word-anchored, and `approved` only trips near `always`", () => {
    expect(findAuthorityWidening("Everything was ALLOWed     always.")).toEqual(["allow"]);
    expect(findAuthorityWidening("This is always approved by the maintainer.")).toEqual(["approved-near-always"]);
    expect(findAuthorityWidening("Approved upstream; no change is needed here.")).toEqual([]);
    expect(findAuthorityWidening("This disallows nothing we rely on.")).toEqual([]);
    expect(validateProposal(validProposal({ body: "Approved upstream; no change is needed here." }), { transcriptIds: TRANSCRIPT_IDS }).ok).toBe(
      true,
    );
    expect(validateProposal(validProposal({ body: "This disallows nothing we rely on." }), { transcriptIds: TRANSCRIPT_IDS }).ok).toBe(true);
  });

  test("do-not-capture: a negative tool claim is refused; a resolved lesson passes", () => {
    const negative = validateProposal(validProposal({ body: "The glob tool is broken; avoid it for large trees." }), {
      transcriptIds: TRANSCRIPT_IDS,
    });
    expect(negative.ok).toBe(false);
    if (!negative.ok) {
      expect(negative.reason).toBe("do-not-capture");
      expect(negative.detail).toContain("is broken");
    }
    expect(findDoNotCapture("It does NOT   work on huge trees.")).toEqual(["does not work"]);
    const resolved = validateProposal(
      validProposal({ body: "Retry the glob with a leading ** when a pattern matches nothing; the transcript shows the fix." }),
      { transcriptIds: TRANSCRIPT_IDS },
    );
    expect(resolved.ok).toBe(true);
  });

  test("invalid shape and unknown kinds are refused", () => {
    const notAnObject = validateProposal("a lesson, as prose", { transcriptIds: TRANSCRIPT_IDS });
    expect(notAnObject.ok).toBe(false);
    if (!notAnObject.ok) expect(notAnObject.reason).toBe("invalid-proposal");
    const badKind = validateProposal({ ...validProposal(), kind: "code" }, { transcriptIds: TRANSCRIPT_IDS });
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.reason).toBe("invalid-kind");
  });

  test("claimedPathsIn: prose like `and/or` is not a claim; file-shaped tokens are", () => {
    expect(claimedPathsIn("Use either/or and/or neither, in prose.")).toEqual([]);
    expect(claimedPathsIn("See ./notes.txt for the rest.")).toEqual(["notes.txt"]);
    expect(claimedPathsIn("Cite src/core/canon.ts, which is a file.")).toEqual(["src/core/canon.ts"]);
  });
});

/* -------------------------------- the curator -------------------------------- */

describe("curator — curate", () => {
  test("a valid proposal round-trips the store as one canonical NDJSON row with origin: review-fork", () => {
    const proposal = validProposal();
    const result = curate([proposal], storeFixture());
    expect(result.appended.length).toBe(1);
    expect(result.refused).toEqual([]);
    expect(result.duplicates).toEqual([]);

    const lines = storeLines();
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]!) as StoredProposalRow;
    expect(row).toEqual({
      schemaVersion: 1,
      kind: "memory",
      title: proposal.title,
      body: proposal.body,
      evidence: ["evt-1"],
      reads: ["src/core"],
      digest: proposalDigest(proposal),
      origin: "review-fork",
      createdAt: "2026-01-02T03:04:05.006Z",
    });
    expect(canonicalJson(row)).toBe(lines[0]!); // the line IS canonical JSON (sorted keys, compact)
  });

  test("the store is append-only: a second curate preserves the earlier bytes exactly", () => {
    curate([validProposal()], storeFixture());
    const before = readFileSync(proposalsFilePath(state), "utf8");
    curate([skillProposal()], storeFixture());
    const after = readFileSync(proposalsFilePath(state), "utf8");
    expect(after.startsWith(before)).toBe(true);
    const lines = storeLines();
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const row = JSON.parse(line) as StoredProposalRow;
      expect(row.origin).toBe("review-fork");
      expect(row.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(canonicalJson(row)).toBe(line); // every stored line is canonical, byte-for-byte
    }
  });

  test("dedupe: a second identical proposal is a no-op; evidence and reads are not the identity", () => {
    const first = curate([validProposal()], storeFixture());
    expect(first.appended.length).toBe(1);
    const second = curate([validProposal()], storeFixture());
    expect(second.appended.length).toBe(0);
    expect(second.duplicates).toEqual([first.appended[0]!.digest]);
    const rewordedEvidence = curate([validProposal({ evidence: ["src/core/review.ts"], reads: ["src/core"] })], storeFixture());
    expect(rewordedEvidence.appended.length).toBe(0);
    expect(rewordedEvidence.duplicates.length).toBe(1);
    const withinBatch = curate([validProposal(), validProposal()], storeFixture());
    expect(withinBatch.appended.length).toBe(0);
    expect(withinBatch.duplicates.length).toBe(2);
    expect(storeLines().length).toBe(1);
  });

  test("a refused proposal is reported and never written; the store file is not created", () => {
    const result = curate([validProposal({ title: "t".repeat(TITLE_MAX_CHARS + 1) })], storeFixture());
    expect(result.appended).toEqual([]);
    expect(result.refused.map((entry) => entry.reason)).toEqual(["title-too-long"]);
    expect(existsSync(proposalsFilePath(state))).toBe(false);
  });

  test("curate writes exactly one file, in the state dir, and never touches the workspace", () => {
    writeFileSync(path.join(workspace, "README.md"), "the workspace\n", "utf8");
    const result = curate([validProposal(), skillProposal()], storeFixture());
    expect(result.appended.length).toBe(2);
    expect(readdirSync(state).sort()).toEqual([PROPOSALS_FILE]);
    expect(readdirSync(workspace)).toEqual(["README.md"]);
    expect(readFileSync(path.join(workspace, "README.md"), "utf8")).toBe("the workspace\n");
    expect(proposalsFilePath(state).startsWith(workspace + path.sep)).toBe(false);
  });

  test("a store whose history cannot be read refuses to append (store-corrupt), bytes untouched", () => {
    const file = proposalsFilePath(state);
    writeFileSync(file, '{"kind":"memory","title":"truncated"', "utf8");
    const err = thrownBy(() => curate([validProposal()], storeFixture()));
    expect(err).toBeInstanceOf(CuratorError);
    expect((err as CuratorError).reason).toBe("store-corrupt");
    expect(err.message).toContain("refusing to append rather than");
    expect(readFileSync(file, "utf8")).toBe('{"kind":"memory","title":"truncated"');
    expect(readdirSync(state)).toEqual([PROPOSALS_FILE]);
  });

  test("an invalid store (relative stateDir) is refused", () => {
    const err = thrownBy(() => curate([validProposal()], { stateDir: "relative/state" }));
    expect(err).toBeInstanceOf(CuratorError);
    expect((err as CuratorError).reason).toBe("invalid-store");
  });

  test("the dedupe digest is byte-stable: recomputed independently and in a fresh process", () => {
    const proposal = validProposal();
    const verdict = validateProposal(proposal, { transcriptIds: TRANSCRIPT_IDS });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    const identity = { kind: proposal.kind, title: proposal.title, body: proposal.body };
    expect(verdict.digest).toBe(sha256Hex(canonicalStringify(identity))); // independent serializer, same bytes

    curate([proposal], storeFixture());
    expect(storeRows()[0]!.digest).toBe(verdict.digest);

    const canonPath = path.join(import.meta.dir, "..", "..", "src", "core", "canon.ts");
    const code = `import(${JSON.stringify(canonPath)}).then((m) => { process.stdout.write(m.digestOf(${JSON.stringify(identity)})) })`;
    const child = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe(verdict.digest); // a fresh process computes the same digest
  });
});
