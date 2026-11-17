/**
 * review-fork-journal.ts — crash-durable settlement journal for detached review
 * forks (G-1 residual, rulings 488/522).
 *
 * Problem. `spawnDetachedReviewFork` reserves spend in the PARENT before it
 * spawns the worker; the worker settles on normal completion. If the worker
 * crashes (or the parent dies and restarts) between reserve and settle, the
 * reservation was held with no durable record of what happened to it. This
 * module supplies that record: an append-only JSONL journal under workspace
 * state, with a content-addressed job id and explicit `reserved` / `settled` /
 * `failed` transitions.
 *
 * Honesty. Recovery settles an OPEN reservation at its RESERVED amount — it
 * does NOT capture live-provider cost or reconcile an invoice. The most a
 * crashed fork can be charged is the conservative worst-case estimate that was
 * reserved before the call. No shell-net egress enforcement is claimed.
 *
 * Safety properties:
 *  - 0700 dir / 0600 file, O_APPEND + fsync (reuses jsonl-append.ts).
 *  - Fails CLOSED on a corrupt journal: any malformed line makes `readJournal`
 *    throw before any settlement is attempted.
 *  - Recovery is an EXPLICIT, opt-in exported function (`recoverReviewForkJournal`);
 *    nothing calls it automatically, so default behavior is unchanged.
 *  - Exactly-once: a cross-process lock + terminal-state guard means replaying
 *    recovery (or recovering twice) never settles the same reservation twice.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { canonicalJson, digestOf } from "./canon";
import { withFileLockSync } from "./file-lock";
import { appendJsonlSync } from "./jsonl-append";
import { chmodPrivateFile, ensurePrivateDir } from "./paths";

/** Journal layout under the state directory (callers pass `workspaceStateDir(workspace)`). */
export const REVIEW_FORK_JOURNAL_DIR = "review-fork-journal";
export const REVIEW_FORK_JOURNAL_FILE = "journal.jsonl";
export const REVIEW_FORK_JOURNAL_LOCK = "journal.lock";
export const REVIEW_FORK_JOURNAL_VERSION = 1 as const;

export type ReviewForkTransition = "reserved" | "settled" | "failed";
const TRANSITIONS: ReadonlySet<string> = new Set<ReviewForkTransition>(["reserved", "settled", "failed"]);

/** One append-only journal row. */
export interface ReviewForkJournalEvent {
  v: typeof REVIEW_FORK_JOURNAL_VERSION;
  /** Content-addressed id (see `reviewForkJobId`). */
  jobId: string;
  transition: ReviewForkTransition;
  at: string;
  reservationId: string;
  /** The amount reserved before the fork was dispatched. */
  reserveUsd: number;
  /** Present on `settled`: the amount actually charged to spend. */
  actualUsd?: number;
  /** Present on `failed`: why the reservation could not be settled. */
  reason?: string;
  note?: string;
}

/** Typed, fail-closed corruption signal. */
export class ReviewForkJournalError extends Error {
  readonly code = "corrupt" as const;
  constructor(message: string) {
    super(message);
    this.name = "ReviewForkJournalError";
  }
}

/** The minimal spend surface recovery needs (structurally satisfied by ReviewForkSpend / SpendLedger). */
export interface JournalSpend {
  settle(id: string, actualUsd: number, note?: string): unknown;
  release(id: string): unknown;
}

/** Stable content whose hash is the job id — binds the journal row to one reservation. */
export interface ReviewForkJobContent {
  reservationId: string;
  workspace: string;
  stateDir: string;
  model: string;
  providerName: string;
  reserveUsd: number;
  /** sha256 of the fork's parent prefix, so two distinct forks never collide. */
  systemPrefixSha256: string;
}

/** A content-addressed id: identical content -> identical id, no randomness. */
export function reviewForkJobId(content: ReviewForkJobContent): string {
  return `rfj-${digestOf(content)}`;
}

/** The directory and file paths, owner-only directory created on demand. */
export function reviewForkJournalDir(stateDir: string): string {
  return path.join(stateDir, REVIEW_FORK_JOURNAL_DIR);
}
export function reviewForkJournalPath(stateDir: string): string {
  return path.join(reviewForkJournalDir(stateDir), REVIEW_FORK_JOURNAL_FILE);
}

function nowIso(): string {
  return new Date().toISOString();
}
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Append one canonical-JSON row, fsync'd, owner-only (no rewrite of prior rows). */
export function appendJournalEvent(stateDir: string, event: ReviewForkJournalEvent): void {
  const file = reviewForkJournalPath(stateDir);
  ensurePrivateDir(path.dirname(file));
  appendJsonlSync(file, `${canonicalJson(event)}\n`);
  chmodPrivateFile(file);
}

/** The reference a caller needs to close a job later (no need to re-read the journal). */
export interface JournalJobRef {
  jobId: string;
  reservationId: string;
  reserveUsd: number;
}

/** Open a job: compute its content-addressed id and append the `reserved` transition. */
export function openReviewForkJob(
  stateDir: string,
  content: ReviewForkJobContent,
  now: () => string = nowIso,
): JournalJobRef {
  const ref: JournalJobRef = {
    jobId: reviewForkJobId(content),
    reservationId: content.reservationId,
    reserveUsd: content.reserveUsd,
  };
  appendJournalEvent(stateDir, {
    v: REVIEW_FORK_JOURNAL_VERSION,
    jobId: ref.jobId,
    transition: "reserved",
    at: now(),
    reservationId: ref.reservationId,
    reserveUsd: ref.reserveUsd,
  });
  return ref;
}

export type ReviewForkJobOutcome =
  | { kind: "settled"; actualUsd: number; note?: string }
  | { kind: "failed"; reason: string };

/** Close a job with a terminal transition (`settled` or `failed`). */
export function closeReviewForkJob(
  stateDir: string,
  ref: JournalJobRef,
  outcome: ReviewForkJobOutcome,
  now: () => string = nowIso,
): ReviewForkJournalEvent {
  const event: ReviewForkJournalEvent =
    outcome.kind === "settled"
      ? {
          v: REVIEW_FORK_JOURNAL_VERSION,
          jobId: ref.jobId,
          transition: "settled",
          at: now(),
          reservationId: ref.reservationId,
          reserveUsd: ref.reserveUsd,
          actualUsd: outcome.actualUsd,
          note: outcome.note ?? "worker reported settle; no live-provider cost capture",
        }
      : {
          v: REVIEW_FORK_JOURNAL_VERSION,
          jobId: ref.jobId,
          transition: "failed",
          at: now(),
          reservationId: ref.reservationId,
          reserveUsd: ref.reserveUsd,
          reason: outcome.reason,
        };
  appendJournalEvent(stateDir, event);
  return event;
}

function isJournalEvent(value: unknown): value is ReviewForkJournalEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const e = value as Partial<ReviewForkJournalEvent>;
  if (e.v !== REVIEW_FORK_JOURNAL_VERSION) return false;
  if (typeof e.jobId !== "string" || e.jobId === "") return false;
  if (typeof e.transition !== "string" || !TRANSITIONS.has(e.transition)) return false;
  if (typeof e.at !== "string") return false;
  if (typeof e.reservationId !== "string" || e.reservationId === "") return false;
  if (typeof e.reserveUsd !== "number" || !Number.isFinite(e.reserveUsd) || e.reserveUsd <= 0) return false;
  if (e.actualUsd !== undefined && (typeof e.actualUsd !== "number" || !Number.isFinite(e.actualUsd) || e.actualUsd < 0)) {
    return false;
  }
  if (e.reason !== undefined && typeof e.reason !== "string") return false;
  if (e.note !== undefined && typeof e.note !== "string") return false;
  return true;
}

/**
 * Read and VALIDATE the whole journal. A missing journal is an empty result.
 * Any non-empty line that is not a valid event throws `ReviewForkJournalError`
 * BEFORE the caller can act on any row — corrupt state is a refusal, never a
 * guess (a clean-looking empty state could authorize an unbounded charge).
 */
export function readJournal(stateDir: string): ReviewForkJournalEvent[] {
  const file = reviewForkJournalPath(stateDir);
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new ReviewForkJournalError(`review-fork journal unreadable: ${file} (${errorMessage(err)})`);
  }
  const events: ReviewForkJournalEvent[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === "") continue; // tolerate blank lines / trailing newline
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (err) {
      throw new ReviewForkJournalError(`review-fork journal line ${i + 1} is not JSON: ${errorMessage(err)}`);
    }
    if (!isJournalEvent(value)) {
      throw new ReviewForkJournalError(`review-fork journal line ${i + 1} has an invalid schema`);
    }
    events.push(value);
  }
  return events;
}

export interface JournalRecoveryResult {
  /** Open jobs moved to a terminal transition this run. */
  recovered: number;
  /** Jobs already terminal (or with no `reserved` row) — left alone. */
  skipped: number;
  /** Open jobs whose settle threw (recorded as `failed`). */
  failed: number;
  jobIds: string[];
}

/**
 * Reconcile every open reservation to a terminal state EXACTLY once.
 *
 * Opt-in / explicit: call this after a parent restart or before resuming work
 * (it is never invoked on the normal turn path). For each job with a `reserved`
 * row but no terminal row, it settles the spend reservation at the reserved
 * amount (conservative — no live-provider capture) and appends a `settled` row;
 * if settle throws, it appends `failed`. A cross-process lock plus the terminal
 * guard make replay idempotent: a second call is a no-op. A corrupt journal
 * throws before any settlement (fail-closed).
 */
export function recoverReviewForkJournal(
  stateDir: string,
  spend: JournalSpend,
  opts: { now?: () => string; note?: string } = {},
): JournalRecoveryResult {
  const now = opts.now ?? nowIso;
  ensurePrivateDir(reviewForkJournalDir(stateDir));
  const lockPath = path.join(reviewForkJournalDir(stateDir), REVIEW_FORK_JOURNAL_LOCK);
  return withFileLockSync(lockPath, () => {
    // Throws on corruption before a single settle is attempted.
    const events = readJournal(stateDir);
    const byJob = new Map<string, { reserved?: ReviewForkJournalEvent; terminal?: ReviewForkJournalEvent }>();
    for (const event of events) {
      let state = byJob.get(event.jobId);
      if (state === undefined) {
        state = {};
        byJob.set(event.jobId, state);
      }
      if (event.transition === "reserved") {
        if (state.reserved === undefined) state.reserved = event;
      } else if (state.terminal === undefined) {
        state.terminal = event;
      }
    }

    const result: JournalRecoveryResult = { recovered: 0, skipped: 0, failed: 0, jobIds: [] };
    for (const [jobId, state] of byJob) {
      // No reservation to reconcile, or already terminal: never settle twice.
      if (state.reserved === undefined || state.terminal !== undefined) {
        result.skipped += 1;
        continue;
      }
      const reservation = state.reserved;
      const ref: JournalJobRef = {
        jobId,
        reservationId: reservation.reservationId,
        reserveUsd: reservation.reserveUsd,
      };
      try {
        spend.settle(reservation.reservationId, reservation.reserveUsd, opts.note ?? `review-fork recovery ${jobId}`);
        closeReviewForkJob(
          stateDir,
          ref,
          {
            kind: "settled",
            actualUsd: reservation.reserveUsd,
            note: "recovery: conservative reservation charge; no live-provider cost capture",
          },
          now,
        );
        result.recovered += 1;
      } catch (err) {
        closeReviewForkJob(stateDir, ref, { kind: "failed", reason: errorMessage(err) }, now);
        result.failed += 1;
      }
      result.jobIds.push(jobId);
    }
    return result;
  });
}
