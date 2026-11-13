/**
 * curator.ts — NF-075 growth loop v1, the editorial standard and the curator.
 *
 * `validateProposal` is the editorial standard as a function (docs/24 §5 NF-075;
 * docs/30 §2 G-2/G-3; acceptance docs/24 §12.2 #67). A proposal is refused with
 * ONE typed reason — first failure wins, and the order is deliberate, so a
 * caller can rely on which check fired:
 *
 *   invalid-proposal / invalid-kind   the shape, then the kind
 *   empty-title  / title-too-long     title <= 120 chars (v1 number; see below)
 *   empty-body   / body-too-long      body  <= 4,000 chars
 *   authority-widening                the conservative token scan (list in source)
 *   do-not-capture                    the do-not-capture block, as markers
 *   missing-evidence                  every evidence entry must reference the transcript or the workspace
 *   unread-path                       read-before-write: a memory/skill body may not cite an unread path
 *
 * Refusing is the designed direction: a false refusal costs a reworded
 * proposal; a false acceptance writes a lesson — or, worse, an authority
 * statement — into a library that later turns are told to trust. The authority
 * scan is deliberately context-free ("never allow X" trips it too) and the
 * do-not-capture markers are deliberately blunt; ADR-010 and docs/11 §7.17(4)
 * put the proposal boundary, not the reviewer, where widening is stopped.
 *
 * Numbers. NF-075 states no numeric description budget. docs/30 §2 G-3 records
 * the upstream's 60-char budget **tied to what the prompt renders**; this slice
 * does not adopt it, because the render path it measures does not exist here yet
 * (a residual, not a silent substitution). The v1 numbers are title <= 120 and
 * body <= 4,000 chars, exported from review.ts beside the prompt that states
 * them.
 *
 * `curate` appends validated proposals to `<stateDir>/proposals.jsonl` (NDJSON,
 * one canonical-JSON row per line) and does NOTHING ELSE. Dedupe is by sha256 of
 * the canonical JSON of exactly {kind, title, body}, so a re-worded evidence
 * list for the same lesson is a no-op. The store is append-only: rows are only
 * ever added, and a store line that does not parse makes `curate` REFUSE
 * (`CuratorError: store-corrupt`) rather than read the history as empty — the
 * owned-spawn ledger's rule, that "unreadable" and "nothing recorded" are
 * different facts. The read half (`loadProposals`) exists for consumers outside
 * the writer — the grow CLI's `--list` and `--apply` — and parses through the
 * same canonical rows under the same refusal rules; it still applies nothing.
 * Never applied: no code path here writes a skill, a memory, a prompt or a
 * session (ADR-010 — proposals are proposals). The store is
 * owner-only (docs/03 D12): the directory is chmod 0700 and the file 0600 on
 * every touch (Unix, umask-proof), so a loose older file is tightened.
 *
 * Canonical JSON. Rows and the dedupe digest use `core/canon.ts`
 * (`canonicalJson` = keys sorted by UTF-8 bytes, compact; `digestOf` =
 * sha256Hex(canonicalJson(value))). That helper imports only `../contracts`, so
 * this module adds no serializer of its own and there is no import cycle
 * (curator -> review -> canon).
 *
 * Curator archive-as-maximum is NOT in this slice: docs/30 §2 G-4 (archive
 * never delete, pre-run snapshots, pins) needs the library this store is the
 * seed of. The v1 curator is append-only by construction — it has no delete,
 * prune, snapshot or pin operation at all — so it cannot lose a stored proposal,
 * and acceptance item #67's "the curator archives (never deletes)" is met only
 * in that weaker, stated sense (a residual, recorded).
 */

import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { appendJsonlSync } from "./jsonl-append";
import * as path from "node:path";
import { canonicalJson, digestOf } from "./canon";
import {
  BODY_MAX_CHARS,
  PROPOSAL_KINDS,
  REVIEW_FORK_ORIGIN,
  TITLE_MAX_CHARS,
  type ProposalKind,
  type ReviewProposalV1,
} from "./review";

/* ---------------------------- refusal vocabulary ---------------------------- */

export type ProposalRefusalReason =
  | "invalid-proposal"
  | "invalid-kind"
  | "empty-title"
  | "title-too-long"
  | "empty-body"
  | "body-too-long"
  | "authority-widening"
  | "do-not-capture"
  | "missing-evidence"
  | "unread-path";

export type ProposalValidation =
  | { ok: true; proposal: ReviewProposalV1; digest: string }
  | { ok: false; reason: ProposalRefusalReason; detail: string };

/** What `validateProposal` may resolve evidence against (ids of the fork's run). */
export interface ProposalEvidenceContext {
  transcriptIds?: readonly string[];
}

function refuse(reason: ProposalRefusalReason, detail: string): ProposalValidation {
  return { ok: false, reason, detail };
}

/* --------------------------- authority-widening --------------------------- */

/**
 * The conservative widening vocabulary. Every token matches at a WORD START and
 * with any suffix, so `allow` catches allow/allows/allowed/allowing/allowlist;
 * `disallow` is not caught (it narrows). The scan is context-free on purpose:
 * "never allow X" trips it too — a reworded proposal is cheaper than a lesson
 * that reads like a permission (docs/11 §7.17(4), ADR-010).
 */
export const AUTHORITY_WIDENING_TOKENS = ["allow", "grant", "policy", "permission", "chmod", "sudo"] as const;

/** `approved` only trips NEAR the anchor word (the task's conservative rule). */
export const AUTHORITY_PROXIMITY_WORD = "approved";
export const AUTHORITY_PROXIMITY_ANCHOR = "always";
/** Word distance (in words, either side) within which `approved` is a hit. */
export const AUTHORITY_PROXIMITY_WINDOW = 10;

/** The family name reported for the approved/near-always hit. */
export const AUTHORITY_PROXIMITY_FAMILY = "approved-near-always";

/** The widening families matched in `text` (empty array = nothing matched). */
export function findAuthorityWidening(text: string): string[] {
  const words = (typeof text === "string" ? text.toLowerCase() : "").match(/[a-z]+/g) ?? [];
  const hits = new Set<string>();
  for (const word of words) {
    for (const token of AUTHORITY_WIDENING_TOKENS) {
      if (word.startsWith(token)) {
        hits.add(token);
        break;
      }
    }
  }
  const approvedAt = words.map((word, index) => ({ word, index })).filter(({ word }) => word.startsWith(AUTHORITY_PROXIMITY_WORD));
  const anchorAt = words.map((word, index) => ({ word, index })).filter(({ word }) => word === AUTHORITY_PROXIMITY_ANCHOR);
  for (const approved of approvedAt) {
    for (const anchor of anchorAt) {
      if (Math.abs(approved.index - anchor.index) <= AUTHORITY_PROXIMITY_WINDOW) hits.add(AUTHORITY_PROXIMITY_FAMILY);
    }
  }
  return [...hits];
}

/* --------------------------- do-not-capture block --------------------------- */

/**
 * The do-not-capture block as v1 markers: unresolved failures and negative tool
 * claims are what the block forbids capturing (docs/30 §2 G-2), because they
 * harden into refusals later. Substring match on lower-cased, whitespace-
 * collapsed text; deliberately blunt — see the module header.
 */
export const DO_NOT_CAPTURE_MARKERS = [
  "does not work",
  "doesn't work",
  "does\u2019t work",
  "never works",
  "is broken",
  "are broken",
  "always fails",
  "unresolved failure",
  "unresolved failures",
  "cannot be used",
  "can not be used",
] as const;

/** The markers matched in `text` (empty array = nothing matched). */
export function findDoNotCapture(text: string): string[] {
  const normalized = (typeof text === "string" ? text.toLowerCase() : "").replace(/\s+/g, " ");
  return DO_NOT_CAPTURE_MARKERS.filter((marker) => normalized.includes(marker));
}

/* ------------------------------- path shapes ------------------------------- */

const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;

/**
 * A value that may be cited as a workspace reference: relative, no `..`, no
 * empty segment, and either multi-segment or a filename with an extension
 * (`src/core/review.ts`, `notes.txt`). Existence is NOT checked here — v1 has
 * no workspace root threaded through this function, so the check is shape-only
 * (a residual, stated).
 */
export function isWorkspacePathShape(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const text = raw.trim();
  if (text === "" || text.startsWith("/") || text.startsWith("~") || text.includes("\\") || text.includes("\0")) return false;
  const trimmed = text.replace(/\/+$/, "");
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return segments.length > 1 || FILE_EXT_RE.test(trimmed);
}

function normalizeReadPath(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let candidate = raw.trim().replace(/\.+$/, "");
  while (candidate.startsWith("./")) candidate = candidate.slice(2);
  candidate = candidate.replace(/\/+$/, "");
  if (candidate === "" || candidate.startsWith("/") || candidate.startsWith("~")) return undefined;
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  return candidate;
}

/**
 * The path-shaped tokens a body/title *claims*: a `./`-prefixed token, a token
 * with a file extension, or a token with at least three segments. A bare
 * `and/or` is prose, not a claim, and is skipped.
 */
const CLAIMED_PATH_RE = /(?<![/\w.-])(?:\.\/)?[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.*-]+)+/g;

export function claimedPathsIn(text: unknown): string[] {
  const source = typeof text === "string" ? text : "";
  const found = new Set<string>();
  for (const match of source.matchAll(CLAIMED_PATH_RE)) {
    const raw = match[0].replace(/\.+$/, "");
    const normalized = normalizeReadPath(raw);
    if (normalized === undefined) continue;
    const segments = normalized.split("/");
    if (segments.length < 3 && !FILE_EXT_RE.test(normalized) && !raw.startsWith("./")) continue;
    found.add(normalized);
  }
  return [...found].sort();
}

/** A reads entry covers a claimed path when it is that path or a directory prefix of it. */
function readCovers(reads: readonly string[], claimed: string): boolean {
  for (const entry of reads) {
    const read = normalizeReadPath(entry);
    if (read === undefined) continue;
    if (read === claimed || claimed.startsWith(`${read}/`)) return true;
  }
  return false;
}

/* ------------------------------ the standard ------------------------------ */

/**
 * The editorial standard. Refuses with one typed reason (first failure wins);
 * on success returns the normalized proposal plus its dedupe digest
 * (sha256 of the canonical JSON of exactly {kind, title, body}).
 */
export function validateProposal(proposal: unknown, transcript: ProposalEvidenceContext = {}): ProposalValidation {
  if (proposal === null || typeof proposal !== "object" || Array.isArray(proposal)) {
    return refuse("invalid-proposal", "a proposal is an object with kind/title/body/evidence/reads");
  }
  const candidate = proposal as Partial<ReviewProposalV1>;
  if (typeof candidate.kind !== "string" || !(PROPOSAL_KINDS as readonly string[]).includes(candidate.kind)) {
    return refuse("invalid-kind", `kind must be one of ${PROPOSAL_KINDS.join(", ")} (got ${JSON.stringify(candidate.kind)})`);
  }
  const kind = candidate.kind as ProposalKind;

  const title = typeof candidate.title === "string" ? candidate.title : "";
  if (title.trim() === "") return refuse("empty-title", "title must be a non-empty string");
  if (title.length > TITLE_MAX_CHARS) {
    return refuse("title-too-long", `title is ${title.length} chars; the budget is ${TITLE_MAX_CHARS}`);
  }

  const body = typeof candidate.body === "string" ? candidate.body : "";
  if (body.trim() === "") return refuse("empty-body", "body must be a non-empty string");
  if (body.length > BODY_MAX_CHARS) {
    return refuse("body-too-long", `body is ${body.length} chars; the budget is ${BODY_MAX_CHARS}`);
  }

  // The widening scan covers the title as well as the body: a title renders into
  // the human review list, so a widening intent in it is refused the same way.
  const scanText = `${title}\n${body}`;
  const widening = findAuthorityWidening(scanText);
  if (widening.length > 0) {
    return refuse(
      "authority-widening",
      `matched ${widening.join(", ")} — the learning loop may propose memory, skills and prompts and nothing else (ADR-010)`,
    );
  }

  const captured = findDoNotCapture(scanText);
  if (captured.length > 0) {
    return refuse(
      "do-not-capture",
      `matched ${captured.join(", ")} — unresolved failures and negative tool claims harden into refusals later`,
    );
  }

  const evidence = Array.isArray(candidate.evidence) ? (candidate.evidence as unknown[]) : [];
  if (evidence.length === 0) {
    return refuse("missing-evidence", "evidence must name at least one transcript event id or workspace-relative path");
  }
  const transcriptIds = new Set(transcript.transcriptIds ?? []);
  for (const entry of evidence) {
    if (typeof entry !== "string" || entry.trim() === "") {
      return refuse("missing-evidence", `every evidence entry must be a non-empty string (got ${JSON.stringify(entry)})`);
    }
    if (transcriptIds.has(entry) || isWorkspacePathShape(entry)) continue;
    return refuse("missing-evidence", `evidence ${JSON.stringify(entry)} references neither the transcript nor the workspace`);
  }

  // Read-before-write. The exemption for `prompt` proposals is exactly the rule
  // the catalog states ("a skill/memory proposal that claims a path it did not
  // list in reads"); the check itself still runs for their evidence.
  const reads = Array.isArray(candidate.reads) ? (candidate.reads as unknown[]).filter((r): r is string => typeof r === "string") : [];
  if (kind !== "prompt") {
    const cited = [...claimedPathsIn(title), ...claimedPathsIn(body)];
    for (const citedPath of cited) {
      if (!readCovers(reads, citedPath)) {
        return refuse("unread-path", `${kind} proposal cites ${JSON.stringify(citedPath)} but reads does not cover it (read-before-write)`);
      }
    }
  }

  const normalized: ReviewProposalV1 = {
    kind,
    title,
    body,
    evidence: evidence as string[],
    reads: reads as string[],
  };
  return { ok: true, proposal: normalized, digest: proposalDigest(normalized) };
}

/** The dedupe identity: sha256 of the canonical JSON of exactly {kind, title, body}. */
export function proposalDigest(proposal: Pick<ReviewProposalV1, "kind" | "title" | "body">): string {
  return digestOf({ kind: proposal.kind, title: proposal.title, body: proposal.body });
}

/* ------------------------------- the curator ------------------------------- */

export const PROPOSALS_FILE = "proposals.jsonl";

/** The absolute store path for a state directory. */
export function proposalsFilePath(stateDir: string): string {
  return path.join(stateDir, PROPOSALS_FILE);
}

/** One line of the store. `origin` is always the review fork's. */
export interface StoredProposalRow {
  schemaVersion: 1;
  kind: ProposalKind;
  title: string;
  body: string;
  evidence: string[];
  reads: string[];
  digest: string;
  origin: typeof REVIEW_FORK_ORIGIN;
  createdAt: string;
}

export interface ProposalStore {
  /** Absolute state directory; the store is `<stateDir>/proposals.jsonl`. */
  stateDir: string;
  /** Event ids the evidence check may resolve against (the fork's transcript). */
  transcriptIds?: readonly string[];
  /** Injected clock for the row's `createdAt` (tests pass a fixed one). */
  now?: () => string;
}

export interface CurateRefusal {
  index: number;
  reason: ProposalRefusalReason;
  detail: string;
}

export interface CurateResult {
  storePath: string;
  /** Rows appended by this call, in input order. */
  appended: Array<{ index: number; digest: string; kind: ProposalKind; title: string }>;
  /** Digests already present (store or this batch); the proposal was a no-op. */
  duplicates: string[];
  /** Proposals the editorial standard refused; nothing was written for them. */
  refused: CurateRefusal[];
}

export type CuratorErrorReason = "invalid-store" | "store-corrupt";

/** Raised by `curate` for a store it may not write: typed, never silent. */
export class CuratorError extends Error {
  readonly reason: CuratorErrorReason;
  readonly detail: string;

  constructor(reason: CuratorErrorReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "CuratorError";
    this.reason = reason;
    this.detail = detail;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const isUnix = process.platform !== "win32";

/**
 * Post-create chmod so the mode is exact regardless of umask. Best-effort: a
 * target that vanished between the write and the chmod is not an error, and on
 * non-Unix the call is a no-op (POSIX modes do not exist there).
 */
function setOwnerOnly(target: string, mode: number): void {
  if (!isUnix) return;
  try {
    chmodSync(target, mode);
  } catch {
    /* best effort */
  }
}

/**
 * Read the store's digests. A missing file is an empty history (healthy). A file
 * whose bytes cannot be read or parsed is a REFUSAL — never an empty history,
 * because appending would then duplicate rows the store already holds.
 */
function readStoreDigests(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
    throw new CuratorError(
      "store-corrupt",
      `proposals store is unreadable (${errorMessage(err)}); refusing to append rather than dedupe against an unknown history`,
    );
  }
  const digests: string[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] as string).trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new CuratorError(
        "store-corrupt",
        `line ${index + 1} is not JSON (${errorMessage(err)}); refusing to append rather than read the history as empty`,
      );
    }
    const digest = (parsed as { digest?: unknown } | null)?.digest;
    if (typeof digest !== "string" || digest === "") {
      throw new CuratorError(
        "store-corrupt",
        `line ${index + 1} carries no digest; refusing to append rather than dedupe against an unknown history`,
      );
    }
    digests.push(digest);
  }
  return digests;
}

/* ------------------------------ the read half ------------------------------ */

/** The parsed store, in file order. */
export interface ProposalLoad {
  storePath: string;
  /** True when the store file does not exist (nothing recorded yet — healthy). */
  missing: boolean;
  proposals: StoredProposalRow[];
}

const STORED_DIGEST_RE = /^[0-9a-f]{64}$/;

function isStoredProposalRow(value: unknown): value is StoredProposalRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<StoredProposalRow>;
  if (row.schemaVersion !== 1) return false;
  if (typeof row.kind !== "string" || !(PROPOSAL_KINDS as readonly string[]).includes(row.kind)) return false;
  if (typeof row.title !== "string" || typeof row.body !== "string") return false;
  if (typeof row.digest !== "string" || !STORED_DIGEST_RE.test(row.digest)) return false;
  if (!Array.isArray(row.evidence) || row.evidence.some((entry) => typeof entry !== "string")) return false;
  if (!Array.isArray(row.reads) || row.reads.some((entry) => typeof entry !== "string")) return false;
  if (typeof row.createdAt !== "string" || row.origin !== REVIEW_FORK_ORIGIN) return false;
  return true;
}

/**
 * Read the store for consumers outside `curate` — the grow CLI's `--list` and
 * `--apply`. The same honesty rule as `readStoreDigests`: a missing file is the
 * one healthy empty answer; a file whose bytes cannot be read, whose lines are
 * not JSON, or whose rows are not v1 proposal rows is a REFUSAL
 * (`store-corrupt`) — never "no proposals", because callers act on this. Pure
 * read: nothing here writes, chmods or applies (ADR-010).
 */
export function loadProposals(stateDir: string): ProposalLoad {
  if (typeof stateDir !== "string" || stateDir.trim() === "" || !path.isAbsolute(stateDir)) {
    throw new CuratorError("invalid-store", `stateDir must be a non-empty absolute path (got ${JSON.stringify(stateDir)})`);
  }
  const file = proposalsFilePath(stateDir);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return { storePath: file, missing: true, proposals: [] };
    }
    throw new CuratorError(
      "store-corrupt",
      `proposals store is unreadable (${errorMessage(err)}); refusing to report an unknown history as empty`,
    );
  }
  const proposals: StoredProposalRow[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] as string).trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new CuratorError("store-corrupt", `line ${index + 1} is not JSON (${errorMessage(err)})`);
    }
    if (!isStoredProposalRow(parsed)) {
      throw new CuratorError("store-corrupt", `line ${index + 1} is not a v1 proposal row; refusing to skip it silently`);
    }
    proposals.push(parsed);
  }
  return { storePath: file, missing: false, proposals };
}

/**
 * Validate every proposal, then append the survivors to
 * `<stateDir>/proposals.jsonl` — one canonical-JSON row per line, the store's
 * existing bytes never touched, and nothing applied anywhere (ADR-010).
 *
 * Refusals never block the rest of the batch; a refused or duplicate proposal
 * writes nothing. The store file is created only when a row is appended.
 */
export function curate(proposals: readonly unknown[], store: ProposalStore): CurateResult {
  if (
    store === null ||
    typeof store !== "object" ||
    typeof store.stateDir !== "string" ||
    store.stateDir.trim() === "" ||
    !path.isAbsolute(store.stateDir)
  ) {
    throw new CuratorError("invalid-store", `stateDir must be a non-empty absolute path (got ${JSON.stringify(store?.stateDir)})`);
  }
  const file = proposalsFilePath(store.stateDir);
  // Docs/03 D12: any curate call touches the store, so a pre-existing
  // loose-mode file is tightened here — before the read, so even a refusal
  // (store-corrupt) leaves the bytes owner-only (a missing file is not an
  // error: nothing to tighten until a row is appended).
  setOwnerOnly(file, 0o600);
  const seen = new Set(readStoreDigests(file));
  const transcript: ProposalEvidenceContext = { transcriptIds: store.transcriptIds ?? [] };
  const now = typeof store.now === "function" ? store.now : () => new Date().toISOString();

  const result: CurateResult = { storePath: file, appended: [], duplicates: [], refused: [] };
  const lines: string[] = [];
  const list = Array.isArray(proposals) ? proposals : [];
  list.forEach((candidate, index) => {
    const verdict = validateProposal(candidate, transcript);
    if (verdict.ok === false) {
      result.refused.push({ index, reason: verdict.reason, detail: verdict.detail });
      return;
    }
    if (seen.has(verdict.digest)) {
      result.duplicates.push(verdict.digest);
      return;
    }
    seen.add(verdict.digest);
    const row: StoredProposalRow = {
      schemaVersion: 1,
      kind: verdict.proposal.kind,
      title: verdict.proposal.title,
      body: verdict.proposal.body,
      evidence: verdict.proposal.evidence,
      reads: verdict.proposal.reads,
      digest: verdict.digest,
      origin: REVIEW_FORK_ORIGIN,
      createdAt: now(),
    };
    lines.push(canonicalJson(row));
    result.appended.push({ index, digest: verdict.digest, kind: row.kind, title: row.title });
  });

  if (lines.length > 0) {
    mkdirSync(path.dirname(file), { recursive: true });
    // The directory is owner-only too (docs/03 D12).
    setOwnerOnly(path.dirname(file), 0o700);
    // One append of whole lines: a crash cannot interleave two curators' rows
    // beyond what O_APPEND already prevents, and prior bytes are never rewritten.
    // fsync by default (docs/33 §6.5).
    appendJsonlSync(file, lines.map((line) => `${line}\n`).join(""));
    setOwnerOnly(file, 0o600);
  }
  return result;
}
