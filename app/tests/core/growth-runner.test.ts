/**
 * growth-runner.test.ts — the manual growth runner (src/grow.ts; docs/30 §4
 * item 7's scheduling/wiring/application remainder, reduced form).
 *
 * What this pins: a recorded post-mortem becomes exactly one curated proposal
 * (and a second run appends nothing — the curator's dedupe, observed through
 * the CLI); `--apply` without `--yes` prints the intended write and touches
 * nothing; `--apply --yes` proceeds only past a real guard `allow`, writing
 * through the tool effect path (the change lands in the change journal and a
 * `proposal.apply` receipt records it); an `ask` decision is refused with the
 * typed unattended message and writes nothing; `--list` output is stable.
 *
 * Hermetic: temp workspaces and state dirs only, no network. The kernel is the
 * real `KernelClient` (Rust when built, the in-process fallback otherwise) —
 * both share the default policy that makes an outside-workspace write an ask.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { canonicalJson, sha256Hex } from "../../src/contracts";
import { curate, proposalsFilePath, type StoredProposalRow } from "../../src/core/curator";
import { kernelStateDir } from "../../src/core/paths";
import { recordPostmortem } from "../../src/core/postmortem";
import { growSessionId, libraryEntryPath, runGrowCli, type GrowCliIo } from "../../src/grow";
import { lastChange } from "../../src/tools/change-journal";
import { cleanupTemps, readLines, tempDir } from "./helpers";

afterAll(cleanupTemps);

/* -------------------------------- fixtures -------------------------------- */

const NOW = 1_760_000_000_000;
const TASK = "Fix the failing parser test";
const TRANSCRIPT = [
  { seq: 1, role: "system", text: "system rail" },
  { seq: 2, role: "user", text: `${TASK}\nand keep the diff small` },
  { seq: 3, role: "assistant", text: "on it" },
];

async function onePostmortem(stateDir: string, now = NOW): Promise<void> {
  await recordPostmortem({
    stateDir,
    sessionId: "sess-grow",
    terminal: "failed",
    detail: "provider_error",
    transcript: TRANSCRIPT,
    toolCalls: ["read", "edit", "read"],
    failureClass: "provider_error",
    now,
  });
}

/** The CLI's own layout: state inside the workspace, so evidence paths are workspace-relative. */
function fixture(): { workspace: string; stateDir: string } {
  const workspace = tempDir("hz-grow-ws-");
  return { workspace, stateDir: path.join(workspace, ".hz", "state") };
}

function capture(): { lines: string[]; errors: string[]; io: GrowCliIo } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, io: { out: (l) => lines.push(l), err: (l) => errors.push(l) } };
}

/** Run `--from-postmortems` to completion and return the single stored row. */
async function curatedRow(workspace: string, stateDir: string): Promise<StoredProposalRow> {
  const c = capture();
  expect(await runGrowCli(["--from-postmortems"], c.io, { workspace, stateDir })).toBe(0);
  const lines = readLines(proposalsFilePath(stateDir));
  expect(lines.length).toBe(1);
  return JSON.parse(lines[0] as string) as StoredProposalRow;
}

/** A clean memory proposal for tests that need a store without post-mortems. */
const OUTSIDE_PROPOSAL = {
  kind: "memory" as const,
  title: "Prefer the canonical JSON helper for stored rows",
  body: "Hash store rows with the canonical serializer so digests stay byte-stable across runs.",
  evidence: ["fixture.txt"],
  reads: [],
};

/* ----------------------------- --from-postmortems ----------------------------- */

describe("--from-postmortems", () => {
  test("a recorded post-mortem becomes one curated memory proposal", async () => {
    const { workspace, stateDir } = fixture();
    await onePostmortem(stateDir);

    const c = capture();
    expect(await runGrowCli(["--from-postmortems"], c.io, { workspace, stateDir })).toBe(0);
    const row = JSON.parse(readLines(proposalsFilePath(stateDir))[0] as string) as StoredProposalRow;

    expect(row.schemaVersion).toBe(1);
    expect(row.kind).toBe("memory");
    expect(row.origin).toBe("review-fork");
    expect(row.title).toContain("provider_error");
    expect(row.title).toContain(TASK);
    expect(row.body).toContain("Tools exercised: edit=1, read=2.");
    expect(row.evidence.length).toBe(1);
    expect(row.evidence[0]).toMatch(/^\.hz\/state\/postmortems\/\d+-[0-9a-f]{8}\.json$/);
    expect(row.reads).toEqual([".hz/state/postmortems"]);
    expect(row.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(c.lines.join("\n")).toContain("1 appended");
  });

  test("a second run adds nothing — the curator's dedupe makes the CLI idempotent", async () => {
    const { workspace, stateDir } = fixture();
    await onePostmortem(stateDir);
    await curatedRow(workspace, stateDir);
    const before = readFileSync(proposalsFilePath(stateDir), "utf8");

    const c = capture();
    expect(await runGrowCli(["--from-postmortems"], c.io, { workspace, stateDir })).toBe(0);
    expect(readFileSync(proposalsFilePath(stateDir), "utf8")).toBe(before);
    const text = c.lines.join("\n");
    expect(text).toContain("0 appended");
    expect(text).toContain("1 duplicate(s)");
    expect(text).toContain("0 refused");
  });

  test("a record with no task line is skipped with its reason stated", async () => {
    const { workspace, stateDir } = fixture();
    await recordPostmortem({
      stateDir,
      sessionId: "sess-no-task",
      terminal: "failed",
      transcript: [{ seq: 1, role: "assistant", text: "nothing user-visible here" }],
      failureClass: "refusal",
      now: NOW,
    });

    const c = capture();
    expect(await runGrowCli(["--from-postmortems"], c.io, { workspace, stateDir })).toBe(0);
    expect(c.errors.join("\n")).toContain("no-task");
    expect(c.lines.join("\n")).toContain("0 appended");
    expect(existsSync(proposalsFilePath(stateDir))).toBe(false); // nothing was written for a skip
  });

  test("--list is stable and reports PENDING from a live read of the store", async () => {
    const { workspace, stateDir } = fixture();
    await onePostmortem(stateDir);
    const row = await curatedRow(workspace, stateDir);

    const first = capture();
    const second = capture();
    expect(await runGrowCli(["--list"], first.io, { workspace, stateDir })).toBe(0);
    expect(await runGrowCli(["--list"], second.io, { workspace, stateDir })).toBe(0);
    const text = first.lines.join("\n");
    expect(text).toBe(second.lines.join("\n")); // byte-stable across runs
    expect(text).toContain(`PENDING ${row.digest}`);
    expect(text).toContain(row.title);
    expect(text).toContain("1 proposal(s), 0 applied, 1 pending");
  });
});

/* --------------------------------- --apply --------------------------------- */

describe("--apply", () => {
  test("without --yes it prints the proposal and the intended write, exits 2 and touches nothing", async () => {
    const { workspace, stateDir } = fixture();
    await onePostmortem(stateDir);
    const row = await curatedRow(workspace, stateDir);
    const target = libraryEntryPath(stateDir, row);

    const c = capture();
    expect(await runGrowCli(["--apply", row.digest], c.io, { workspace, stateDir })).toBe(2);
    const text = c.lines.join("\n");
    expect(text).toContain(`intended write: ${target}`);
    expect(text).toContain(`proposal ${row.digest}`);
    expect(text).toContain(row.title);
    expect(text).toContain("--- /dev/null"); // the create case, as a diff header
    expect(text).toContain("+++ ");

    expect(existsSync(target)).toBe(false);
    expect(existsSync(path.join(stateDir, "library"))).toBe(false);
    expect(existsSync(path.join(kernelStateDir(workspace), "receipts.jsonl"))).toBe(false);
  });

  test(
    "with --yes at an in-workspace target it writes the entry, the receipt and the journal change",
    async () => {
      const { workspace, stateDir } = fixture();
      await onePostmortem(stateDir);
      const row = await curatedRow(workspace, stateDir);
      const target = libraryEntryPath(stateDir, row);

      const c = capture();
      expect(await runGrowCli(["--apply", row.digest, "--yes"], c.io, { workspace, stateDir })).toBe(0);

      const content = readFileSync(target, "utf8");
      expect(content).toContain(row.title);
      expect(content).toContain(row.body);
      expect(c.lines.join("\n")).toContain("guard=allow (scope workspace)");

      // The receipt: action/tool fixed, argsDigest recomputed here independently,
      // resultDigest over the bytes that landed.
      const receipts = readLines(path.join(kernelStateDir(workspace), "receipts.jsonl")).map((line) => JSON.parse(line));
      const applied = receipts.find((r) => r.action === "proposal.apply");
      expect(applied).toBeDefined();
      expect(applied.tool).toBe("grow");
      expect(applied.argsDigest).toBe(sha256Hex(canonicalJson({ proposalId: row.digest })));
      expect(applied.resultDigest).toBe(sha256Hex(content));

      // The change journal (public export): the same effect path the write tool uses.
      const change = lastChange(growSessionId(workspace));
      expect(change?.path).toBe(target);
      expect(change?.rel).toBe(path.relative(workspace, target));
      expect(change?.before).toBeNull();
      expect(change?.afterSha256).toBe(sha256Hex(content));
      expect(change?.tool).toBe("write");

      // --list reads the receipt back as APPLIED; a re-apply is a no-op.
      const list = capture();
      expect(await runGrowCli(["--list"], list.io, { workspace, stateDir })).toBe(0);
      expect(list.lines.join("\n")).toContain(`APPLIED ${row.digest}`);

      const again = capture();
      expect(await runGrowCli(["--apply", row.digest, "--yes"], again.io, { workspace, stateDir })).toBe(0);
      expect(again.lines.join("\n")).toContain("already applied");
      expect(readLines(path.join(kernelStateDir(workspace), "receipts.jsonl")).length).toBe(receipts.length);
    },
    30000,
  );

  test(
    "with --yes at an outside-workspace target the default ask refuses with the typed message",
    async () => {
      const workspace = tempDir("hz-grow-ws-");
      const stateDir = tempDir("hz-grow-outside-state-"); // deliberately outside the workspace
      const curated = curate([OUTSIDE_PROPOSAL], { stateDir, transcriptIds: [] });
      expect(curated.appended.length).toBe(1);
      const entry = curated.appended[0]!;

      const c = capture();
      expect(await runGrowCli(["--apply", entry.digest, "--yes"], c.io, { workspace, stateDir })).toBe(3);
      expect(c.errors.join("\n")).toContain("unattended apply never self-approves");
      expect(c.errors.join("\n")).toContain("apply via the TUI");
      expect(existsSync(libraryEntryPath(stateDir, entry))).toBe(false);
    },
    30000,
  );

  test("an unknown id is a usage refusal: exit 2, nothing written", async () => {
    const { workspace, stateDir } = fixture();
    await onePostmortem(stateDir);
    await curatedRow(workspace, stateDir);

    const c = capture();
    expect(await runGrowCli(["--apply", "deadbeefdeadbeef", "--yes"], c.io, { workspace, stateDir })).toBe(2);
    expect(c.errors.join("\n")).toContain("no matching proposal");
    expect(existsSync(path.join(stateDir, "library"))).toBe(false);
  });
});
