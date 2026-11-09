/**
 * grow.ts — the manual growth runner (NF-075; docs/30 §4 item 7's
 * "scheduling, wiring, application" remainder, reduced form).
 *
 * What this is. `core/review.ts` builds a review-fork SPEC and `core/curator.ts`
 * is the editorial standard plus the append-only proposals store; both
 * deliberately apply nothing (ADR-010). This CLI is the missing manual half:
 * one cron-able entry that turns recorded post-mortems into curated proposals,
 * and one explicitly opted-in entry that materializes a single proposal as a
 * library file under human command.
 *
 *   bun run grow --list              proposals in the store, with status
 *   bun run grow --from-postmortems  curate the recorded post-mortems (idempotent)
 *   bun run grow --apply <id>        print the proposal + intended write (exit 2)
 *   bun run grow --apply <id> --yes  guard-checked write + receipt
 *
 * SCHEDULING is documented, not a timer. `--from-postmortems` is deterministic
 * and idempotent — the curator's dedupe by sha256({kind,title,body}) makes a
 * second run append zero rows — so it is the safe cron entry:
 *
 *   # every day at 08:00, review the failures recorded under the repo's state dir
 *   0 8 * * *  cd /path/to/repo/app && bun run grow --from-postmortems --workspace /path/to/repo
 *
 * `--apply` is deliberately not cron-able: it is opt-in per proposal with
 * `--yes`, and an unattended run that meets an `ask` decision refuses rather
 * than self-approving (below). Nothing else schedules anything: the review fork
 * itself still has no background launcher (provider calls are not in this
 * slice), and that residual is named, not papered over.
 *
 * --apply, exactly:
 *   1. resolve the proposal by id. The store has no separate id column, so the
 *      id IS the row's dedupe digest: the full 64-hex digest, or a unique
 *      prefix of at least 8 hex characters.
 *   2. without `--yes`, print the proposal and the intended write — the target
 *      path plus a small unified diff against the current file — and exit 2.
 *   3. with `--yes`, run a real `guard.check` for `fs.write` on the resolved
 *      target, under the SAME scope rule the tools use (`scopeFor`: inside the
 *      workspace -> "workspace", anything else -> "outside").
 *   4. only `allow` proceeds. `ask` refuses with the typed message below —
 *      unattended apply never self-approves — and `deny` refuses naming the
 *      kernel's reason.
 *   5. the write mirrors `tools/write.ts`'s effect path: `writeAtomic` (temp
 *      file + rename, effect-time descriptor verification against the kernel
 *      state dir), then `noteRead`, then `recordChange` into the session change
 *      journal (imported public exports only; change-journal.ts is owned
 *      elsewhere and never edited here).
 *   6. one receipt is issued through the kernel: action "proposal.apply", tool
 *      "grow", argsDigest = sha256(canonicalJson({proposalId: id})), resultDigest
 *      = sha256(content). That receipt is the durable record of the application,
 *      and `--list` reads it back to report APPLIED. A write that lands but
 *      cannot be receipted is reported as an incomplete audit trail and exits
 *      non-zero.
 *
 * The library. Applying materializes a proposal as Markdown under
 * `<stateDir>/library/<kind>/<slug>-<digest8>.md` — the library the curator
 * store is the seed of (docs/30 §2 G-4). Reduced form, stated: nothing consumes
 * the library yet (no offering/selection path, and the skills loader still
 * reads `<state-root>/skills`, so an applied skill proposal is not auto-listed
 * as an active skill); the file plus the receipt are the whole effect.
 *
 * --from-postmortems. One `memory` proposal per recorded post-mortem that has
 * a task line: the title names the failure class and the task, the body carries
 * the record's facts (terminal/detail, failure class, transcript range and
 * digest, failure signature, tool counts) and the evidence cites the
 * post-mortem file itself, workspace-relative. The task line is omitted when it
 * cites workspace paths — the generator will not make a read-before-write claim
 * the curator would (rightly) refuse. Records without a task line are skipped
 * with that reason stated; a state directory outside the workspace makes the
 * evidence path unrepresentable, so those records are skipped too (the normal
 * CLI layout always keeps state inside the workspace; `core/paths.ts` owns
 * that decision). No provider is called: the lesson text is the record plus a
 * fixed starting instruction, not model prose.
 *
 * The diff. `core/plan.ts` exists but was unmerged when this CLI was written,
 * so this module does not depend on it: `simpleUnifiedDiff` below is a
 * deliberately small prefix/suffix-trim formatter (one hunk, delete block then
 * insert block, three context lines) for display only. It is not a patch
 * format and is never fed back into anything.
 *
 * Exit codes (docs/14 §3.2 vocabulary): 0 success; 1 a proposal was refused by
 * the editorial standard, or the write/receipt failed after the guard allowed
 * it; 2 usage error, a dry run without --yes, or a corrupt store refusal; 3
 * fail-closed (an ask decision refused unattended; an unreadable receipts
 * store, so "already applied" cannot be proven either way); 4 the guard
 * denied.
 *
 * Audit trail. The CLI prints a run record in the eval runner's logging shape —
 * a header line, per-item lines, a `summary:` line — rather than inventing a
 * new persisted run-record schema; the durable record is the kernel receipt.
 */

import { readFileSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import type { GuardAction, GuardDecision, Receipt, ToolContext } from "./contracts";
import { canonicalJson, sha256Hex } from "./contracts";
import {
  claimedPathsIn,
  curate,
  loadProposals,
  type StoredProposalRow,
} from "./core/curator";
import { KernelClient } from "./core/kernel";
import { scopeFor } from "./core/loop";
import { kernelStateDir, workspaceStateDir } from "./core/paths";
import { loadPostmortems, postmortemPath, type PostmortemRecord } from "./core/postmortem";
import { TITLE_MAX_CHARS, type ReviewProposalV1 } from "./core/review";
import { isRefused, writeAtomic } from "./tools/atomic-write";
import { recordChange } from "./tools/change-journal";
import { noteRead } from "./tools/read-ledger";

/* ------------------------------ vocabulary ------------------------------ */

/** The receipt action one applied proposal carries. */
export const GROW_APPLY_ACTION = "proposal.apply";
/** The receipt tool name one applied proposal carries. */
export const GROW_TOOL = "grow";
/** The subdirectory of the state dir that holds applied proposals. */
export const LIBRARY_DIR = "library";
/** The shortest id prefix `--apply` accepts (a shorter one is a usage error). */
export const MIN_PROPOSAL_ID_PREFIX = 8;

const DEFAULT_IO: GrowCliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

const USAGE = "usage: bun run src/grow.ts (--list | --from-postmortems | --apply <id> [--yes]) [--workspace <dir>]";

/** The flags this CLI understands; anything else is a usage error. */
const KNOWN_FLAGS = new Set(["--list", "--from-postmortems", "--apply", "--yes", "--workspace"]);

export interface GrowCliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface GrowCliOptions {
  /** Workspace root override (default: `--workspace`, then the cwd). */
  workspace?: string;
  /** State directory override (default: the workspace's resolved state dir). */
  stateDir?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One display line: no embedded newlines, trimmed. */
function oneLine(text: unknown): string {
  return String(text).replace(/[\r\n]+/g, " ").trim();
}

/** The value of `--flag`, or `undefined` when absent (an empty string when bare). */
function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? "" : value;
}

/* ------------------------------ identities ------------------------------ */

/**
 * The session/journal key for one workspace. The change journal is keyed by
 * session id and grow has no session store, so this is a deterministic
 * synthetic id: the same workspace always maps to the same journal bucket.
 */
export function growSessionId(workspace: string): string {
  return `${GROW_TOOL}:${sha256Hex(path.resolve(workspace)).slice(0, 16)}`;
}

/**
 * The receipt's args digest for one proposal: sha256 of the canonical JSON of
 * exactly `{ proposalId: id }`. Defined here once, so the receipt written by
 * `--apply` and the status read by `--list` can never disagree.
 */
export function proposalArgsDigest(id: string): string {
  return sha256Hex(canonicalJson({ proposalId: id }));
}

/* ------------------------------- the store ------------------------------- */

export type ProposalLookup =
  | { ok: true; row: StoredProposalRow }
  | { ok: false; reason: "no-match" | "ambiguous"; candidates: string[] };

/**
 * Resolve `--apply <id>`: an exact digest, or a unique prefix of at least
 * `MIN_PROPOSAL_ID_PREFIX` characters. Ambiguity is refused, never guessed.
 */
export function findProposal(rows: readonly StoredProposalRow[], id: string): ProposalLookup {
  const wanted = typeof id === "string" ? id.trim().toLowerCase() : "";
  if (wanted === "") return { ok: false, reason: "no-match", candidates: [] };
  const exact = rows.filter((row) => row.digest === wanted);
  if (exact.length === 1) return { ok: true, row: exact[0] as StoredProposalRow };
  if (exact.length > 1) return { ok: false, reason: "ambiguous", candidates: exact.map((row) => row.digest) };
  if (wanted.length < MIN_PROPOSAL_ID_PREFIX) return { ok: false, reason: "no-match", candidates: [] };
  const prefixed = rows.filter((row) => row.digest.startsWith(wanted));
  if (prefixed.length === 1) return { ok: true, row: prefixed[0] as StoredProposalRow };
  if (prefixed.length > 1) return { ok: false, reason: "ambiguous", candidates: prefixed.map((row) => row.digest) };
  return { ok: false, reason: "no-match", candidates: [] };
}

/* ------------------------------- the library ------------------------------- */

/** A filesystem-safe slug from a title: lowercase alphanumerics, `-` between. */
function slugOf(title: string): string {
  const slug = (typeof title === "string" ? title : "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug === "" ? "proposal" : slug;
}

/** `<stateDir>/library/<kind>/<slug>-<digest8>.md` — deterministic per row. */
export function libraryEntryPath(stateDir: string, row: Pick<StoredProposalRow, "kind" | "title" | "digest">): string {
  return path.join(stateDir, LIBRARY_DIR, row.kind, `${slugOf(row.title)}-${row.digest.slice(0, 8)}.md`);
}

/** The Markdown an applied proposal lands as. Deterministic in the row. */
export function libraryEntryContent(row: Pick<StoredProposalRow, "title" | "body" | "digest" | "createdAt">): string {
  return (
    `# ${row.title}\n\n${row.body}\n\n` +
    `<!-- applied from proposal ${row.digest} (origin review-fork), recorded ${row.createdAt} -->\n`
  );
}

/* --------------------------- the receipts status --------------------------- */

interface ApplyReceipts {
  readable: boolean;
  reason?: string;
  /** argsDigest -> the receipt that recorded the application. */
  applied: Map<string, { seq: number; id: string }>;
}

/**
 * Read the kernel's receipt chain for the applied-proposal records. A missing
 * file is a healthy empty history; an unreadable or unparseable file is
 * REPORTED (`readable: false`) and never read as empty — a status decision
 * must not turn a damaged audit trail into "not applied".
 */
function readApplyReceipts(kernelDir: string): ApplyReceipts {
  const file = path.join(kernelDir, "receipts.jsonl");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return { readable: true, applied: new Map() };
    }
    return { readable: false, reason: errorMessage(err), applied: new Map() };
  }
  const applied = new Map<string, { seq: number; id: string }>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] as string).trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      return { readable: false, reason: `line ${index + 1} is not JSON (${errorMessage(err)})`, applied: new Map() };
    }
    const record = parsed as Partial<{ action: unknown; tool: unknown; argsDigest: unknown; seq: unknown; id: unknown }> | null;
    if (record === null || typeof record !== "object") {
      return { readable: false, reason: `line ${index + 1} is not a receipt`, applied: new Map() };
    }
    if (record.action !== GROW_APPLY_ACTION || record.tool !== GROW_TOOL) continue;
    if (typeof record.argsDigest !== "string" || record.argsDigest === "") {
      return { readable: false, reason: `line ${index + 1} has no argsDigest`, applied: new Map() };
    }
    applied.set(record.argsDigest, {
      seq: typeof record.seq === "number" ? record.seq : 0,
      id: typeof record.id === "string" ? record.id : "",
    });
  }
  return { readable: true, applied };
}

/* --------------------------- post-mortem proposals --------------------------- */

export interface PostmortemProposal {
  proposal: ReviewProposalV1;
  /** The post-mortem id the proposal was derived from (for reporting). */
  source: string;
}

export interface PostmortemProposals {
  proposals: PostmortemProposal[];
  skipped: Array<{ id: string; reason: "no-task" | "state-outside-workspace" }>;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * One proposal from one post-mortem, or a named skip. Pure and deterministic:
 * the same record always yields the same {kind,title,body}, which is exactly
 * what the curator's dedupe digest needs to make a second run a no-op.
 */
export function proposalFromPostmortem(
  pm: PostmortemRecord,
  ctx: { workspace: string; stateDir: string },
): PostmortemProposal | { skipped: "no-task" | "state-outside-workspace" } {
  const task = typeof pm.task === "string" ? pm.task.replace(/\s+/g, " ").trim() : "";
  if (task === "") return { skipped: "no-task" };

  const file = postmortemPath(ctx.stateDir, pm.id);
  const relFile = path.relative(ctx.workspace, file);
  const relDir = path.relative(ctx.workspace, path.dirname(file));
  const outside =
    relFile === "" || relFile.startsWith("..") || path.isAbsolute(relFile) || relDir === "" || relDir.startsWith("..") || path.isAbsolute(relDir);
  if (outside) return { skipped: "state-outside-workspace" };

  const prefix = `Post-mortem lesson (${pm.failureClass}): `;
  const title =
    claimedPathsIn(task).length > 0
      ? `${prefix}(task line cites paths this run did not read; omitted)`
      : `${prefix}${clip(task, Math.max(0, TITLE_MAX_CHARS - prefix.length))}`;

  const tools =
    Object.keys(pm.toolCalls).length > 0
      ? Object.entries(pm.toolCalls)
          .map(([name, count]) => `${name}=${count}`)
          .join(", ")
      : "none";
  const body = [
    `Terminal ${pm.terminal}${pm.detail !== null ? ` (detail ${pm.detail})` : ""}; failure class ${pm.failureClass}.`,
    `Transcript range: seq ${pm.transcript.firstSeq ?? "-"}..${pm.transcript.lastSeq ?? "-"} (${pm.transcript.count} event(s)); ` +
      `text sha256 ${pm.transcript.textDigest}.`,
    `Failure signature sha256 ${pm.failureDigest}.`,
    `Tools exercised: ${tools}.`,
    `Source record: ${relFile}.`,
    "Lesson: start from the transcript window and the tool calls named here; keep the fix small and re-run the check that failed.",
  ].join("\n");

  return {
    proposal: { kind: "memory", title, body, evidence: [relFile], reads: [relDir] },
    source: pm.id,
  };
}

/** The batch form; the CLI curates the proposals and reports the skips. */
export function proposalsFromPostmortems(
  postmortems: readonly PostmortemRecord[],
  ctx: { workspace: string; stateDir: string },
): PostmortemProposals {
  const proposals: PostmortemProposal[] = [];
  const skipped: PostmortemProposals["skipped"] = [];
  for (const pm of postmortems) {
    const built = proposalFromPostmortem(pm, ctx);
    if ("skipped" in built) skipped.push({ id: pm.id, reason: built.skipped });
    else proposals.push(built);
  }
  return { proposals, skipped };
}

/* -------------------------------- the diff -------------------------------- */

/** Split into lines the way the formatter numbers them (trailing newline is not a line). */
function splitLines(text: string): string[] {
  const normalized = (typeof text === "string" ? text : "").replace(/\r\n?/g, "\n");
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * A display-only unified diff: trim the common prefix and suffix, then one
 * hunk that deletes the old middle and inserts the new one, with up to three
 * context lines on each side. `""` when the texts are line-identical. The line
 * cap always says how many lines were dropped. Deliberately NOT a patch
 * format — see the module header for why it does not use `core/plan.ts`.
 */
export function simpleUnifiedDiff(before: string | null, after: string, label: string, maxLines = 120): string {
  const oldLines = splitLines(before ?? "");
  const newLines = splitLines(after);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  if (endOld === start && endNew === start) return "";

  const CONTEXT = 3;
  const ctxBefore = Math.min(CONTEXT, start);
  const ctxAfter = Math.min(CONTEXT, oldLines.length - endOld, newLines.length - endNew);
  const oldStart = start - ctxBefore;
  const newStart = oldStart;
  const oldCount = endOld + ctxAfter - oldStart;
  const newCount = endNew + ctxAfter - newStart;
  const out: string[] = [
    `--- ${before === null ? "/dev/null" : label}`,
    `+++ ${label}`,
    `@@ -${oldCount > 0 ? oldStart + 1 : oldStart},${oldCount} +${newCount > 0 ? newStart + 1 : newStart},${newCount} @@`,
  ];
  for (let i = 0; i < ctxBefore; i += 1) out.push(` ${oldLines[start - ctxBefore + i]}`);
  for (let i = start; i < endOld; i += 1) out.push(`-${oldLines[i]}`);
  for (let i = start; i < endNew; i += 1) out.push(`+${newLines[i]}`);
  for (let i = 0; i < ctxAfter; i += 1) out.push(` ${oldLines[endOld + i]}`);

  if (out.length > maxLines) {
    const kept = Math.max(0, maxLines - 1);
    const dropped = out.length - kept;
    return out.slice(0, kept).join("\n") + (kept > 0 ? "\n" : "") + `... ${dropped} more lines\n`;
  }
  return out.join("\n") + "\n";
}

/* ------------------------------ the CLI commands ------------------------------ */

function printCuratorRefusal(io: GrowCliIo, err: unknown): void {
  io.err(`refused: ${errorMessage(err)}`);
}

function runList(io: GrowCliIo, workspace: string, stateDir: string): number {
  let load: ReturnType<typeof loadProposals>;
  try {
    load = loadProposals(stateDir);
  } catch (err) {
    printCuratorRefusal(io, err);
    return 2;
  }

  const receipts = readApplyReceipts(kernelStateDir(workspace));
  if (!receipts.readable) {
    io.err(`warning: the receipts store is unreadable (${receipts.reason ?? "unknown"}); every status below is UNKNOWN`);
  }

  io.out(`grow list: ${load.proposals.length} proposal(s) · store ${load.storePath}`);
  let applied = 0;
  let pending = 0;
  let unknown = 0;
  for (const row of load.proposals) {
    const status = !receipts.readable
      ? "UNKNOWN"
      : receipts.applied.has(proposalArgsDigest(row.digest))
        ? "APPLIED"
        : "PENDING";
    if (status === "APPLIED") applied += 1;
    else if (status === "PENDING") pending += 1;
    else unknown += 1;
    io.out(`${status} ${row.digest} · ${row.kind} · "${oneLine(row.title)}" · created ${row.createdAt}`);
  }
  io.out(
    `summary: ${load.proposals.length} proposal(s), ${applied} applied, ${pending} pending` +
      (unknown > 0 ? `, ${unknown} unknown` : ""),
  );
  return 0;
}

async function runFromPostmortems(io: GrowCliIo, workspace: string, stateDir: string): Promise<number> {
  let load: Awaited<ReturnType<typeof loadPostmortems>>;
  try {
    load = await loadPostmortems(stateDir);
  } catch (err) {
    io.err(`refused: ${errorMessage(err)}`);
    return 2;
  }
  if (load.corrupt) {
    const files = load.quarantine.map((entry) => entry.file).join(", ");
    // The module's mandate: a corrupt store is a refusal state, never an empty
    // history that would silently produce zero proposals.
    io.err(`${stateDir}: at least one post-mortem file is corrupt (${files}) — refusing, not treating it as an empty set`);
    return 2;
  }

  const built = proposalsFromPostmortems(load.postmortems, { workspace, stateDir });
  for (const skip of built.skipped) io.err(`skipped ${skip.id}: ${skip.reason}`);

  let result: ReturnType<typeof curate>;
  try {
    result = curate(
      built.proposals.map((entry) => entry.proposal),
      { stateDir, transcriptIds: [] },
    );
  } catch (err) {
    printCuratorRefusal(io, err);
    return 2;
  }

  io.out(`grow --from-postmortems: ${load.postmortems.length} post-mortem(s) · store ${result.storePath}`);
  for (const entry of result.appended) {
    io.out(`appended ${entry.digest.slice(0, 12)} · ${entry.kind} · "${oneLine(entry.title)}"`);
  }
  for (const digest of result.duplicates) io.out(`duplicate ${digest.slice(0, 12)} (already recorded)`);
  for (const refusal of result.refused) {
    const source = built.proposals[refusal.index]?.source ?? `proposal ${refusal.index}`;
    io.err(`refused ${source}: ${refusal.reason} — ${refusal.detail}`);
  }
  io.out(
    `summary: ${load.postmortems.length} post-mortem(s), ${result.appended.length} appended, ` +
      `${result.duplicates.length} duplicate(s), ${result.refused.length} refused, ${built.skipped.length} skipped`,
  );
  return result.refused.length > 0 ? 1 : 0;
}

/** What the target file currently holds, for the diff and the journal preimage. */
interface ExistingText {
  text: string | null;
  /** Exists but its bytes are not restorable UTF-8 text (binary / unreadable). */
  unreadable: boolean;
}

async function readExistingText(file: string): Promise<ExistingText> {
  let buf: Buffer;
  try {
    buf = await readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return { text: null, unreadable: false };
    return { text: null, unreadable: true };
  }
  const losslessUtf8 = Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
  if (buf.includes(0) || !losslessUtf8) return { text: null, unreadable: true };
  return { text: buf.toString("utf8"), unreadable: false };
}

/** The minimal tool context the write effect path needs. */
function growToolContext(kernel: KernelClient, workspace: string): ToolContext {
  return {
    cwd: workspace,
    workspace,
    sessionId: growSessionId(workspace),
    signal: new AbortController().signal,
    guard: (action) => kernel.checkGuard(action, scopeFor(action, workspace)),
    // Unattended by construction: an apply that reached an approval prompt must
    // not answer it. The ask path is refused before this context is ever used.
    approve: async () => false,
    receipt: (rec) => kernel.issueReceipt(rec),
  };
}

async function runApply(io: GrowCliIo, workspace: string, stateDir: string, idArg: string, yes: boolean): Promise<number> {
  let load: ReturnType<typeof loadProposals>;
  try {
    load = loadProposals(stateDir);
  } catch (err) {
    printCuratorRefusal(io, err);
    return 2;
  }
  const found = findProposal(load.proposals, idArg);
  if (found.ok === false) {
    if (found.reason === "ambiguous") {
      io.err(`--apply ${idArg}: ambiguous; it matches ${found.candidates.length} proposals: ${found.candidates.join(", ")}`);
    } else {
      io.err(`--apply ${idArg}: no matching proposal in ${load.storePath}`);
    }
    return 2;
  }
  const row = found.row;
  const id = row.digest;
  const target = libraryEntryPath(stateDir, row);
  const content = libraryEntryContent(row);
  const rel = path.relative(workspace, target) || target;

  if (!yes) {
    io.out(`grow --apply ${id} (dry run; pass --yes to write)`);
    io.out(`proposal ${id} · ${row.kind} · "${oneLine(row.title)}" · created ${row.createdAt}`);
    io.out("body:");
    for (const line of row.body.split("\n")) io.out(`  ${line}`);
    io.out(`evidence: ${row.evidence.join(", ")}`);
    io.out(`reads: ${row.reads.length > 0 ? row.reads.join(", ") : "(none)"}`);
    io.out(`intended write: ${target}`);
    const existing = await readExistingText(target);
    if (existing.unreadable) {
      io.out("the target exists and its bytes are not restorable text; --yes would refuse it");
    } else {
      const diff = simpleUnifiedDiff(existing.text, content, rel);
      if (diff === "") io.out("the target already holds exactly this content");
      else io.out(diff.replace(/\n$/, ""));
    }
    return 2;
  }

  const receipts = readApplyReceipts(kernelStateDir(workspace));
  if (!receipts.readable) {
    io.err(
      `refused: the receipts store is unreadable (${receipts.reason ?? "unknown"}); ` +
        `cannot prove this proposal was not already applied`,
    );
    return 3;
  }
  const appliedReceipt = receipts.applied.get(proposalArgsDigest(id));
  if (appliedReceipt !== undefined) {
    io.out(`already applied: proposal ${id} carries receipt #${appliedReceipt.seq} (${appliedReceipt.id})`);
    return 0;
  }

  const existing = await readExistingText(target);
  if (existing.unreadable) {
    io.err(
      `refused: ${target} exists and its bytes are not restorable UTF-8 text; ` +
        `refusing to replace bytes the proposal did not produce`,
    );
    return 3;
  }

  const kernel = new KernelClient({ workspace });
  try {
    await kernel.start();
    const action: GuardAction = { kind: "fs.write", target };
    const scope = scopeFor(action, workspace);
    let decision: GuardDecision;
    try {
      decision = await kernel.checkGuard(action, scope);
    } catch (err) {
      io.err(`refused: the guard could not decide (${errorMessage(err)})`);
      return 3;
    }
    if (decision.decision === "ask") {
      io.err("refused: unattended apply never self-approves; run under a policy that allows it or apply via the TUI");
      return 3;
    }
    if (decision.decision === "deny") {
      io.err(`refused: denied by policy: ${decision.reason !== undefined && decision.reason !== "" ? decision.reason : "no reason given"}`);
      return 4;
    }

    await mkdir(path.dirname(target), { recursive: true });
    const ctx = growToolContext(kernel, workspace);
    const outcome = await writeAtomic(target, content, ctx);
    if (isRefused(outcome)) {
      io.err(`write failed: ${outcome.refusal}`);
      return 1;
    }

    recordChange(ctx.sessionId, {
      path: target,
      rel,
      before: existing.text,
      ...(existing.unreadable ? { beforeUnreadable: true } : {}),
      afterSha256: sha256Hex(content),
      at: Date.now(),
      tool: "write",
    });
    noteRead(ctx, target);

    let receipt: Receipt;
    try {
      receipt = await kernel.issueReceipt({
        action: GROW_APPLY_ACTION,
        tool: GROW_TOOL,
        argsDigest: proposalArgsDigest(id),
        resultDigest: sha256Hex(content),
      });
    } catch (err) {
      io.err(
        `the write landed but the receipt could not be issued (${errorMessage(err)}); the audit trail is incomplete`,
      );
      return 1;
    }

    io.out(`grow --apply ${id} · guard=allow (scope ${scope}) · kernel=${kernel.mode}`);
    io.out(`applied ${rel} (${Buffer.byteLength(content, "utf8")} bytes) · receipt #${receipt.seq} (${receipt.id})`);
    io.out(`summary: proposal ${id} applied`);
    return 0;
  } finally {
    await kernel.close().catch(() => undefined);
  }
}

export async function runGrowCli(argv: readonly string[], io: GrowCliIo = DEFAULT_IO, opts: GrowCliOptions = {}): Promise<number> {
  const applyId = argValue(argv, "--apply");
  const list = argv.includes("--list");
  const fromPostmortems = argv.includes("--from-postmortems");
  const modes = [list, fromPostmortems, applyId !== undefined].filter(Boolean).length;
  if (modes !== 1) {
    io.err(`exactly one of --list, --from-postmortems or --apply <id> is required\n${USAGE}`);
    return 2;
  }
  if (applyId !== undefined && applyId === "") {
    io.err(`--apply needs a proposal id (the store row digest, or a unique prefix)\n${USAGE}`);
    return 2;
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");
    if (!arg.startsWith("--")) {
      io.err(`unexpected argument ${arg}\n${USAGE}`);
      return 2;
    }
    if (!KNOWN_FLAGS.has(arg)) {
      io.err(`unknown option ${arg}\n${USAGE}`);
      return 2;
    }
    // `--workspace <dir>` and `--apply <id>` carry a value; skip it here so the
    // value is never mistaken for a positional argument.
    if (arg === "--workspace" || arg === "--apply") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        io.err(`${arg} needs a value\n${USAGE}`);
        return 2;
      }
      i += 1;
    }
  }

  const workspaceArg = argValue(argv, "--workspace");
  const workspace = path.resolve(workspaceArg !== undefined && workspaceArg !== "" ? workspaceArg : (opts.workspace ?? process.cwd()));
  let stats;
  try {
    stats = await stat(workspace);
  } catch (err) {
    io.err(`not a folder: ${workspace} (${errorMessage(err)})`);
    return 2;
  }
  if (!stats.isDirectory()) {
    io.err(`not a folder: ${workspace}`);
    return 2;
  }
  const stateDir = path.resolve(opts.stateDir ?? workspaceStateDir(workspace));

  if (list) return runList(io, workspace, stateDir);
  if (fromPostmortems) return runFromPostmortems(io, workspace, stateDir);
  return runApply(io, workspace, stateDir, applyId as string, argv.includes("--yes"));
}

if (import.meta.main) {
  process.exitCode = await runGrowCli(process.argv.slice(2));
}
