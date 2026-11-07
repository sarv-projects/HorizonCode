/**
 * review.ts — NF-075 growth loop v1, the review-fork half (reduced form).
 *
 * What this is. A review fork is a second run over the parent's own finished
 * turn whose only job is to emit structured PROPOSALS (memory, skill, prompt).
 * NF-075 (docs/24 §5) requires two properties of it, and this module makes both
 * checkable as data before any run exists:
 *
 *  - cache parity. The fork's system prefix is the parent's compiled prefix
 *    BYTE-FOR-BYTE — same system prompt, same tool order — so it reuses the
 *    parent's prompt cache (docs/30 §2 G-1 records the upstream's ~26 % cost
 *    cut). The parent's compile step records a sha256 of what it sent;
 *    `buildReviewFork` recomputes the digest over the bytes it was handed and
 *    REFUSES with `prefix-parity-mismatch` when the record and the bytes
 *    disagree. A fork that would cold-miss the cache is a full-price call,
 *    which is the failure NF-075 exists to prevent.
 *  - read-only by construction. The fork may name only read-only tools
 *    (`REVIEW_FORK_TOOLS`: read, grep, glob — each `fs.read`), it declares
 *    `persistenceIsolated: true` (no session-DB writes, frozen tool snapshot —
 *    the upstream mechanism is `_persist_disabled` / `_session_db = None`), and
 *    every record it emits carries `origin: "review-fork"`.
 *
 * The review instruction (`prompt`) is the TAIL of the fork's request, never
 * part of the prefix: the prefix must stay byte-identical, because volatility
 * in the prefix is a bug, not a tuning choice (ADR-009; NF-005). The prompt
 * carries the editorial standard — structured proposals only, the
 * do-not-capture block, read-before-write, the description budget — but is not
 * itself the enforcement: curator.ts refuses what the standard forbids and is
 * the single place those rules have teeth.
 *
 * The proposal shape (`ReviewProposalV1`).
 *   { kind: "memory" | "skill" | "prompt", title, body,
 *     evidence: [<transcript event id or workspace-relative path>],
 *     reads:    [<workspace-relative path the proposal claims to have read>] }
 *
 * Numbers. NF-075 states no numeric description budget. docs/30 §2 G-3 records
 * the upstream's 60-char budget for a rendered description line; this slice does
 * NOT adopt that number (it budgets a prompt-render surface that does not exist
 * yet). The v1 numbers are title <= 120 chars and body <= 4,000 chars — carried
 * here as constants, enforced in curator.ts, and stated in the prompt.
 *
 * REDUCED FORM, stated. This module builds and validates a review-run SPEC; it
 * does not run a review. NOT in this slice: post-turn background scheduling,
 * wiring the fork into the loop, any provider call, and any application of a
 * proposal whatsoever. `curate()` appends to a proposals file and nothing else
 * (ADR-010: the learning loop proposes; a human or a later, explicitly scoped
 * wiring step disposes).
 *
 * Sources: docs/24 §5 NF-075 and its acceptance item §12.2 #67; docs/30 §2
 * G-1…G-4 and §4 item 7; docs/11 §7.17(4) and ADR-010 (no self-widening
 * authority); docs/24 §10(4) (the learning loop is fenced).
 */

import * as path from "node:path";
import { sha256Hex } from "./canon";

/** The origin stamped on every review-fork record (spec and curated rows). */
export const REVIEW_FORK_ORIGIN = "review-fork" as const;

/* ------------------------------ the proposal ------------------------------ */

export type ProposalKind = "memory" | "skill" | "prompt";
export const PROPOSAL_KINDS: readonly ProposalKind[] = ["memory", "skill", "prompt"];

/** The v1 description budget: title <= 120 chars, body <= 4,000 chars. */
export const TITLE_MAX_CHARS = 120;
export const BODY_MAX_CHARS = 4_000;

/** One proposal as the review prompt asks for it (enforced in curator.ts). */
export interface ReviewProposalV1 {
  kind: ProposalKind;
  title: string;
  body: string;
  /** Transcript event ids or workspace-relative file paths. */
  evidence: string[];
  /** Workspace-relative paths the proposal claims to have read. */
  reads: string[];
}

/**
 * The field contract the prompt renders for the model. It is deliberately a
 * readable description, not a generated JSON Schema — the machine-visible
 * contract is `ReviewProposalV1`, and the enforced rules live in curator.ts
 * (`validateProposal`), so there is exactly one place a rule can drift from.
 */
export const REVIEW_PROPOSAL_SCHEMA = {
  kind: PROPOSAL_KINDS.join(' | '),
  title: `string, <= ${TITLE_MAX_CHARS} chars`,
  body: `string, <= ${BODY_MAX_CHARS} chars`,
  evidence: "string[] — transcript event ids or workspace-relative paths; never empty",
  reads: "string[] — every workspace-relative path the proposal claims it read",
} as const;

/* --------------------------- the parent's prefix --------------------------- */

/**
 * The parent's compiled system prefix, as the parent's compile step recorded
 * it. `sha256` is the digest of the bytes the parent actually sent; the fork
 * recomputes it and refuses on disagreement.
 */
export interface ParentPrefixRecord {
  bytes: string;
  sha256: string;
}

export interface CacheParity {
  parentSha256: string;
  forkSha256: string;
  identical: boolean;
}

/** sha256 over both prefixes, compared byte-for-byte (identical needs both). */
export function cacheParity(parentBytes: string, forkBytes: string): CacheParity {
  const parentSha256 = sha256Hex(parentBytes);
  const forkSha256 = sha256Hex(forkBytes);
  return { parentSha256, forkSha256, identical: parentSha256 === forkSha256 && parentBytes === forkBytes };
}

/* ------------------------------ the tool subset ------------------------------ */

/**
 * The tools the fork may name: read-only kinds only, each an `fs.read`
 * admission in the parent's own guard vocabulary. The list is closed — a fork
 * that could name `write`, `edit` or `shell` would not be read-only by
 * construction.
 */
export interface ReviewForkTool {
  name: string;
  guardKind: "fs.read";
  effectClass: "read-only";
}

export const REVIEW_FORK_TOOLS: readonly ReviewForkTool[] = Object.freeze([
  Object.freeze({ name: "read", guardKind: "fs.read" as const, effectClass: "read-only" as const }),
  Object.freeze({ name: "grep", guardKind: "fs.read" as const, effectClass: "read-only" as const }),
  Object.freeze({ name: "glob", guardKind: "fs.read" as const, effectClass: "read-only" as const }),
]);

/* ------------------------------ the typed error ------------------------------ */

export type ReviewForkRefusalReason = "prefix-parity-mismatch" | "invalid-scope";

/** Raised by `buildReviewFork`; `reason` is the stable, machine-readable code. */
export class ReviewForkError extends Error {
  readonly reason: ReviewForkRefusalReason;
  readonly detail: string;

  constructor(reason: ReviewForkRefusalReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ReviewForkError";
    this.reason = reason;
    this.detail = detail;
  }
}

/* ------------------------------- the input ------------------------------- */

/** One parent-transcript event, bounded to what the review prompt may cite. */
export interface ReviewTranscriptEvent {
  /** The event id as it appears in the parent's log (`evt_...`). */
  id: string;
  /** Optional event type, for the prompt's context only. */
  type?: string;
  /** Optional bounded text, for the prompt's context only; never authority. */
  summary?: string;
}

export interface BuildReviewForkInput {
  /** The parent's compiled system prefix plus the digest it recorded. */
  parentPrefix: ParentPrefixRecord;
  /** The parent run's events (frozen into the spec; never re-read). */
  transcript: readonly ReviewTranscriptEvent[];
  /** Absolute workspace root, for evidence and read paths. */
  workspace: string;
  /** Absolute state directory; the curator's store lives at <stateDir>/proposals.jsonl. */
  stateDir: string;
}

/* ------------------------------- the output ------------------------------- */

/**
 * The review-run SPEC — data, never a running loop. Anything that would launch,
 * schedule or pay for the fork is deliberately absent.
 */
export interface ReviewForkSpec {
  origin: typeof REVIEW_FORK_ORIGIN;
  readOnly: true;
  persistenceIsolated: true;
  /** The parent's compiled prefix, byte-for-byte (the TAIL carries the prompt). */
  systemPrefix: string;
  cacheParity: CacheParity;
  /** The review instruction; a request-tail message, never a prefix addition. */
  prompt: string;
  /** The closed, read-only tool subset the fork may name. */
  tools: readonly ReviewForkTool[];
  /** A frozen copy of the parent's events, for grounding proposals only. */
  transcript: readonly ReviewTranscriptEvent[];
  /** The ids the curator's evidence check may resolve against. */
  transcriptIds: readonly string[];
  workspace: string;
  stateDir: string;
}

function requireAbsolute(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || !path.isAbsolute(value)) {
    throw new ReviewForkError("invalid-scope", `${field} must be a non-empty absolute path (got ${JSON.stringify(value)})`);
  }
  return value;
}

function freezeTranscript(transcript: unknown): ReviewTranscriptEvent[] {
  const list = Array.isArray(transcript) ? transcript : [];
  return list.map((event, index) => {
    const record = event as Partial<ReviewTranscriptEvent> | null;
    if (record === null || typeof record !== "object" || typeof record.id !== "string" || record.id === "") {
      throw new ReviewForkError("invalid-scope", `transcript[${index}].id must be a non-empty string`);
    }
    const copy: ReviewTranscriptEvent = { id: record.id };
    if (typeof record.type === "string") copy.type = record.type;
    if (typeof record.summary === "string") copy.summary = record.summary;
    return copy;
  });
}

/**
 * Build the review-run spec for one finished parent turn.
 *
 * Refusals (typed, one reason each):
 *  - `prefix-parity-mismatch` — sha256(parentPrefix.bytes) !== the recorded
 *    parentPrefix.sha256, so the fork would not share the parent's prefix
 *    cache. The bytes are NOT repaired or re-rendered here; the caller is told
 *    and stops.
 *  - `invalid-scope` — workspace/stateDir not absolute, empty prefix bytes, or
 *    a transcript event without a string id.
 */
export function buildReviewFork(input: BuildReviewForkInput): ReviewForkSpec {
  if (input === null || typeof input !== "object") {
    throw new ReviewForkError("invalid-scope", "buildReviewFork requires an input object");
  }
  const workspace = requireAbsolute(input.workspace, "workspace");
  const stateDir = requireAbsolute(input.stateDir, "stateDir");
  const record = input.parentPrefix;
  if (record === null || typeof record !== "object" || typeof record.bytes !== "string" || record.bytes === "") {
    throw new ReviewForkError("invalid-scope", "parentPrefix.bytes must be a non-empty string");
  }

  // The fork reuses the parent's prefix byte-for-byte: the spec's systemPrefix
  // IS the parent's bytes (same string, same length, same hash) and nothing is
  // prepended, re-sorted or appended. The review instruction rides the tail.
  const systemPrefix = record.bytes;
  const parity = cacheParity(record.bytes, systemPrefix);
  if (!parity.identical || record.sha256 !== parity.parentSha256) {
    throw new ReviewForkError(
      "prefix-parity-mismatch",
      `parent prefix record ${JSON.stringify(record.sha256)} does not match sha256 of the bytes handed to the fork ` +
        `(${parity.parentSha256}); refusing a cold-prefix review fork rather than paying a full-price call`,
    );
  }

  const transcript = freezeTranscript(input.transcript);
  const spec: ReviewForkSpec = {
    origin: REVIEW_FORK_ORIGIN,
    readOnly: true,
    persistenceIsolated: true,
    systemPrefix,
    cacheParity: parity,
    prompt: reviewPrompt(),
    tools: REVIEW_FORK_TOOLS,
    transcript,
    transcriptIds: transcript.map((event) => event.id),
    workspace,
    stateDir,
  };
  return Object.freeze(spec);
}

/* ------------------------------- the prompt ------------------------------- */

/**
 * The review instruction. It rides the request TAIL (appended after the cached
 * prefix) and asks for structured proposals ONLY; the enforcement of every rule
 * it states lives in curator.ts.
 */
export function reviewPrompt(): string {
  const tools = REVIEW_FORK_TOOLS.map((tool) => tool.name).join(", ");
  return [
    "You are the background review fork of the turn that just finished.",
    "You inherit the parent's compiled system prefix byte-for-byte, so your context is warm.",
    `You are read-only by construction (only ${tools} are available) and persistence-isolated: this run writes nothing to the session.`,
    "",
    "Emit ONLY a JSON array of proposals, and nothing else. Emit [] when the turn taught nothing worth keeping.",
    "Each proposal is exactly:",
    '  {"kind": "memory" | "skill" | "prompt", "title": string, "body": string, "evidence": [string], "reads": [string]}',
    `  kind: one of ${PROPOSAL_KINDS.join(", ")}. title: <= ${TITLE_MAX_CHARS} chars. body: <= ${BODY_MAX_CHARS} chars.`,
    "  evidence: transcript event ids or workspace-relative file paths; a proposal with no evidence is discarded.",
    "  reads: every workspace-relative path your proposal claims to have read.",
    "",
    "EDITORIAL STANDARD — a proposal that breaks any of these is refused at the proposal boundary:",
    "  - read-before-write: never cite a path you did not read, and list every path you read in `reads`.",
    "  - do-not-capture block: do NOT capture unresolved failures as lessons, and do NOT record negative",
    "    claims about tools; those harden into refusals later. Capture only what the transcript shows was resolved.",
    "  - authority: never propose a change to policy, permissions, grants or approvals, and never use words",
    "    such as allow/grant/policy/permission/chmod/sudo. You may propose memory, skills and prompts — nothing else.",
    "  - description budget: keep the title within what the library will actually render, and the body focused",
    "    on one lesson.",
    "Your output is a proposal, never an application: nothing you emit is applied, and no proposal widens authority.",
  ].join("\n");
}
