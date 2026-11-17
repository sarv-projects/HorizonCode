/**
 * curator-archive.ts — archive-as-maximum for the curator (backlog G-4).
 *
 * WHY. The curator proposes; it never applies (ADR-010). But a proposal library
 * that can forget is a library that can be rewritten. G-4 asks for the strong
 * form — the archive is the MAXIMUM set of everything ever proposed, with a
 * pre-run snapshot and named pins — not merely the weak "we have no delete
 * button" property the v1 append-only store provided (docs/28 ruling 27).
 *
 * Design (all pure, in-memory, zero filesystem writes — not even to stateDir):
 *  - Append-only. `appendProposals` returns a NEW archive; the input is never
 *    mutated. There is deliberately NO delete, prune, clear or overwrite
 *    operation exported. Rows are deduped by proposal digest on append, so a
 *    re-run cannot add a second copy of the same lesson.
 *  - Immutable. The archive, its proposal array, every row and its pin record
 *    are Object.freeze'd. Pin names are validated before use.
 *  - Pre-run snapshot. Every archived row carries the digest of the exact
 *    batch bytes queued for that run plus the timestamp the snapshot was
 *    taken — recorded before curation, so it cannot be rewritten after the
 *    fact by a run that changed its mind.
 *  - Named pins. `pin` attaches a stable name to a digest; `resolvePin` finds
 *    the row again. Re-pinning a name to a different digest is refused
 *    (a pin is an immutable label, not a mutable pointer).
 *
 * This is the library the store is the seed of: curator.ts wires a small
 * helper (`archiveProposalBatch`) to it. Nothing here writes a skill, memory,
 * prompt, session or workspace file.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { canonicalJson, sha256Hex } from "./canon";

/** The immutable content+time record taken before a run touches anything. */
export interface PreRunSnapshot {
  /** sha256 of the canonical JSON of the exact batch queued for the run. */
  contentDigest: string;
  /** ISO timestamp from the injected clock (tests pass a fixed one). */
  takenAt: string;
}

/** One archived proposal (a frozen row). */
export interface ArchivedProposal {
  /** Monotonic 1-based position in the archive. */
  seq: number;
  /** Dedupe identity: sha256 of canonical JSON of {kind,title,body}. */
  digest: string;
  kind: string;
  title: string;
  /** The snapshot that was current when this proposal was archived. */
  snapshot: PreRunSnapshot;
}

export interface CuratorArchive {
  readonly seq: number;
  readonly proposals: readonly ArchivedProposal[];
  /** name -> proposal digest (frozen record; no Map mutation surface). */
  readonly pins: Readonly<Record<string, string>>;
}

export type ArchiveErrorReason = "invalid-pin" | "duplicate-pin" | "unknown-pin";

/** Raised by `pin` for a name/digest that would corrupt the label namespace. */
export class ArchiveError extends Error {
  readonly reason: ArchiveErrorReason;
  readonly detail: string;

  constructor(reason: ArchiveErrorReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ArchiveError";
    this.reason = reason;
    this.detail = detail;
  }
}

const PIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Snapshot the exact batch bytes with an injected clock. Pure; no writes. */
export function takePreRunSnapshot(content: string, now: () => string = () => new Date().toISOString()): PreRunSnapshot {
  const text = typeof content === "string" ? content : "";
  const takenAt = now();
  return Object.freeze({ contentDigest: sha256Hex(text), takenAt: typeof takenAt === "string" ? takenAt : String(takenAt) });
}

/** Snapshot a batch of proposals by its canonical JSON (stable under re-keying). */
export function snapshotForProposals(proposals: readonly unknown[], now?: () => string): PreRunSnapshot {
  return takePreRunSnapshot(canonicalJson(Array.isArray(proposals) ? proposals : []), now);
}

/** The empty archive (frozen). */
export function emptyArchive(): CuratorArchive {
  return Object.freeze({ seq: 0, proposals: Object.freeze([]), pins: Object.freeze(Object.create(null) as Record<string, string>) });
}

/**
 * Append proposal rows to an archive under one pre-run snapshot. Returns a NEW
 * frozen archive; the input is untouched. Rows already present by digest are
 * skipped (an append never deletes or duplicates). No filesystem access.
 */
export function appendProposals(
  archive: CuratorArchive,
  inputs: readonly { digest: string; kind: string; title: string }[],
  snapshot: PreRunSnapshot,
): CuratorArchive {
  if (archive === null || typeof archive !== "object" || !Array.isArray(archive.proposals)) {
    throw new ArchiveError("invalid-pin", "appendProposals requires an archive");
  }
  const seen = new Set(archive.proposals.map((row) => row.digest));
  const added: ArchivedProposal[] = [];
  let seq = archive.seq;
  for (const input of Array.isArray(inputs) ? inputs : []) {
    if (input === null || typeof input !== "object" || typeof input.digest !== "string" || input.digest === "") continue;
    if (seen.has(input.digest)) continue;
    seen.add(input.digest);
    seq += 1;
    added.push(
      Object.freeze({
        seq,
        digest: input.digest,
        kind: typeof input.kind === "string" ? input.kind : "",
        title: typeof input.title === "string" ? input.title : "",
        snapshot,
      }) as ArchivedProposal,
    );
  }
  return Object.freeze({
    seq,
    proposals: Object.freeze([...archive.proposals, ...added]),
    pins: archive.pins,
  });
}

/**
 * Attach a named pin to an existing proposal digest. Refuses an invalid name,
 * an unknown digest, or a name already bound to a different digest. Idempotent
 * for the same name+digest. Returns a NEW frozen archive; no mutation.
 */
export function pin(archive: CuratorArchive, name: string, digest: string): CuratorArchive {
  if (typeof name !== "string" || !PIN_NAME_RE.test(name)) {
    throw new ArchiveError("invalid-pin", `pin name must match ${PIN_NAME_RE} (got ${JSON.stringify(name)})`);
  }
  if (typeof digest !== "string" || !archive.proposals.some((row) => row.digest === digest)) {
    throw new ArchiveError("unknown-pin", `no archived proposal with digest ${JSON.stringify(digest)}`);
  }
  const existing = archive.pins[name];
  if (existing !== undefined && existing !== digest) {
    throw new ArchiveError("duplicate-pin", `pin ${JSON.stringify(name)} already points at ${existing}`);
  }
  if (existing === digest) return archive;
  const pins: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(archive.pins)) pins[key] = archive.pins[key] as string;
  pins[name] = digest;
  return Object.freeze({ seq: archive.seq, proposals: archive.proposals, pins: Object.freeze(pins) });
}

/** Resolve a named pin to its archived row, or `undefined` when unbound. */
export function resolvePin(archive: CuratorArchive, name: string): ArchivedProposal | undefined {
  if (archive === null || typeof archive !== "object" || typeof name !== "string") return undefined;
  const digest = archive.pins[name];
  if (digest === undefined) return undefined;
  return archive.proposals.find((row) => row.digest === digest);
}

/* -------------------------------------------------------------------------- */
/* Persistence (G-4 follow-up)                                                */
/* -------------------------------------------------------------------------- */
/*
 * The pure archive above is the in-memory model. The functions below make it
 * DURABLE under a workspace state dir without changing any of its semantics:
 *  - one canonical-JSON snapshot file `<stateDir>/curator-archive.json`;
 *  - written atomically (0600 temp in a 0700 dir, fsync, rename, parent fsync);
 *  - loaded fresh on every `curate` call (a new process sees the same archive);
 *  - bounded READ path: a file larger than MAX_ARCHIVE_BYTES is a typed refusal
 *    (never silently truncated), and `archiveReadView` bounds the returned rows
 *    without mutating the stored archive — history is never rewritten or pruned.
 * No delete/prune/overwrite API is exported: the archive stays the maximum set.
 */

/** Persisted archive file name, under the workspace state dir. */
export const ARCHIVE_FILE = "curator-archive.json";
export const ARCHIVE_SCHEMA_VERSION = 1;
/** Bounded read: a persisted archive larger than this is a typed refusal. */
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
/** Bounded read view: the newest N rows (the file keeps every row). */
export const MAX_ARCHIVE_VIEW_ROWS = 200;

export type ArchiveStoreErrorReason = "invalid-archive-dir" | "archive-corrupt" | "archive-write-failed";

/** A typed refusal from the persistence layer — never a silent empty archive. */
export class ArchiveStoreError extends Error {
  readonly reason: ArchiveStoreErrorReason;
  readonly detail: string;

  constructor(reason: ArchiveStoreErrorReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ArchiveStoreError";
    this.reason = reason;
    this.detail = detail;
  }
}

const isUnix = process.platform !== "win32";
const HEX64 = /^[0-9a-f]{64}$/;

function storeMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Absolute path of the persisted archive for a state directory. */
export function curatorArchivePath(stateDir: string): string {
  return path.join(stateDir, ARCHIVE_FILE);
}

function requireStateDir(stateDir: string): string {
  if (typeof stateDir !== "string" || stateDir.trim() === "" || !path.isAbsolute(stateDir)) {
    throw new ArchiveStoreError(
      "invalid-archive-dir",
      `stateDir must be a non-empty absolute path (got ${JSON.stringify(stateDir)})`,
    );
  }
  return stateDir;
}

/** Serialize an archive to stable canonical JSON (one trailing newline). */
export function serializeArchive(archive: CuratorArchive): string {
  if (archive === null || typeof archive !== "object" || !Array.isArray(archive.proposals)) {
    throw new ArchiveStoreError("archive-corrupt", "serializeArchive requires an archive");
  }
  const pins: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of Object.keys(archive.pins)) pins[name] = archive.pins[name] as string;
  const record = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    seq: archive.seq,
    proposals: archive.proposals.map((row) => ({
      seq: row.seq,
      digest: row.digest,
      kind: row.kind,
      title: row.title,
      snapshot: { contentDigest: row.snapshot.contentDigest, takenAt: row.snapshot.takenAt },
    })),
    pins,
  };
  return `${canonicalJson(record)}\n`;
}

function isSnapshot(value: unknown): value is PreRunSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<PreRunSnapshot>;
  return typeof snapshot.contentDigest === "string" && HEX64.test(snapshot.contentDigest) && typeof snapshot.takenAt === "string";
}

/** Parse + validate a persisted archive. Any malformed shape is a typed refusal. */
export function parseArchive(text: string): CuratorArchive {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new ArchiveStoreError("archive-corrupt", `not JSON (${storeMessage(err)})`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ArchiveStoreError("archive-corrupt", "root is not an archive record");
  }
  const record = value as {
    schemaVersion?: unknown;
    seq?: unknown;
    proposals?: unknown;
    pins?: unknown;
  };
  if (record.schemaVersion !== ARCHIVE_SCHEMA_VERSION) {
    throw new ArchiveStoreError("archive-corrupt", `unsupported schemaVersion ${JSON.stringify(record.schemaVersion)}`);
  }
  if (typeof record.seq !== "number" || !Number.isInteger(record.seq) || record.seq < 0) {
    throw new ArchiveStoreError("archive-corrupt", "seq is not a non-negative integer");
  }
  if (!Array.isArray(record.proposals)) {
    throw new ArchiveStoreError("archive-corrupt", "proposals is not an array");
  }
  const proposals: ArchivedProposal[] = [];
  for (let index = 0; index < record.proposals.length; index += 1) {
    const raw = record.proposals[index];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ArchiveStoreError("archive-corrupt", `proposals[${index}] is not a row`);
    }
    const row = raw as Partial<ArchivedProposal>;
    if (
      typeof row.seq !== "number" ||
      !Number.isInteger(row.seq) ||
      row.seq !== index + 1 ||
      typeof row.digest !== "string" ||
      !HEX64.test(row.digest) ||
      typeof row.kind !== "string" ||
      typeof row.title !== "string" ||
      !isSnapshot(row.snapshot)
    ) {
      throw new ArchiveStoreError("archive-corrupt", `proposals[${index}] is not a v1 archived row`);
    }
    proposals.push(
      Object.freeze({
        seq: row.seq,
        digest: row.digest,
        kind: row.kind,
        title: row.title,
        snapshot: Object.freeze({ contentDigest: row.snapshot.contentDigest, takenAt: row.snapshot.takenAt }),
      }) as ArchivedProposal,
    );
  }
  if (record.seq !== proposals.length) {
    throw new ArchiveStoreError("archive-corrupt", `seq ${record.seq} disagrees with ${proposals.length} rows`);
  }
  if (record.pins === null || typeof record.pins !== "object" || Array.isArray(record.pins)) {
    throw new ArchiveStoreError("archive-corrupt", "pins is not a record");
  }
  const digests = new Set(proposals.map((row) => row.digest));
  const pins: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of Object.keys(record.pins as Record<string, unknown>)) {
    const digest = (record.pins as Record<string, unknown>)[name];
    if (!PIN_NAME_RE.test(name) || typeof digest !== "string" || !HEX64.test(digest) || !digests.has(digest)) {
      throw new ArchiveStoreError("archive-corrupt", `pins[${JSON.stringify(name)}] is not a valid pin`);
    }
    pins[name] = digest;
  }
  return Object.freeze({
    seq: record.seq,
    proposals: Object.freeze(proposals),
    pins: Object.freeze(pins),
  }) as CuratorArchive;
}

/**
 * Load the archive from `<stateDir>/curator-archive.json`. A missing file is a
 * healthy empty archive; an unreadable, oversized or malformed file is a typed
 * refusal (never "no archive" — appending against an unknown history would
 * rewrite it). This is called on every `curate`, so a new process sees the same
 * archive without any in-memory cache.
 */
export function loadCuratorArchive(stateDir: string): CuratorArchive {
  const dir = requireStateDir(stateDir);
  const file = curatorArchivePath(dir);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return emptyArchive();
    throw new ArchiveStoreError("archive-corrupt", `archive is unreadable (${storeMessage(err)})`);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_ARCHIVE_BYTES) {
    throw new ArchiveStoreError(
      "archive-corrupt",
      `archive exceeds the bounded read limit of ${MAX_ARCHIVE_BYTES} bytes; refusing rather than truncating history`,
    );
  }
  return parseArchive(text);
}

/** Best-effort fsync of a file descriptor opened for a just-written file. */
function fsyncFile(file: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    fsyncSync(fd);
  } catch {
    /* some platforms/filesystems refuse fsync */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Best-effort fsync of the parent directory so the rename survives a crash. */
function fsyncParentDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    /* best effort */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Persist an archive atomically: 0700 dir, 0600 temp file, fsync, rename over
 * the target, parent fsync. The prior bytes are replaced in one rename, never
 * truncated; a crash leaves either the old archive or the whole new one.
 */
export function saveCuratorArchive(stateDir: string, archive: CuratorArchive): string {
  const dir = requireStateDir(stateDir);
  mkdirSync(dir, { recursive: true });
  if (isUnix) {
    try {
      chmodSync(dir, statSync(dir).mode & 0o700);
    } catch {
      /* best effort */
    }
  }
  const file = curatorArchivePath(dir);
  const content = serializeArchive(archive);
  const tmp = path.join(dir, `.${ARCHIVE_FILE}.hz-tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(tmp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fsyncFile(tmp);
    if (isUnix) chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    if (isUnix) chmodSync(file, 0o600);
    fsyncParentDir(dir);
    return file;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw new ArchiveStoreError("archive-write-failed", `cannot persist archive to ${file} (${storeMessage(err)})`);
  }
}

export interface ArchiveReadView {
  /** Total rows in the stored archive (nothing is ever deleted). */
  totalArchived: number;
  /** Newest `MAX_ARCHIVE_VIEW_ROWS` rows, in seq order. */
  rows: readonly ArchivedProposal[];
  pins: Readonly<Record<string, string>>;
  /** True when the view is bounded below the full row count. */
  truncated: boolean;
}

/**
 * A bounded read view over an archive. Pure: it never mutates or rewrites the
 * archive or its persisted file — no history is lost when the view is capped.
 */
export function archiveReadView(archive: CuratorArchive, maxRows: number = MAX_ARCHIVE_VIEW_ROWS): ArchiveReadView {
  const limit = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : MAX_ARCHIVE_VIEW_ROWS;
  const rows = archive.proposals.slice(Math.max(0, archive.proposals.length - limit));
  return {
    totalArchived: archive.proposals.length,
    rows,
    pins: archive.pins,
    truncated: rows.length < archive.proposals.length,
  };
}
