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

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import * as path from "node:path";
import { canonicalJson, sha256Hex } from "./canon";
import { withFileLockSync } from "./file-lock";
import { appendJsonlSync } from "./jsonl-append";

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
 * DURABLE under a workspace state dir without changing any of its semantics.
 * The file `<stateDir>/curator-archive.json` is an NDJSON append log (one
 * immutable artifact line per snapshot/pin/refusal) written with durable
 * O_APPEND; legacy v1 canonical-JSON snapshot files are read as a base and
 * never rewritten. Writes are serialized by a cross-process lock. The read path
 * is bounded: a file larger than MAX_ARCHIVE_BYTES is a typed refusal (never a
 * silent truncation), and `archiveReadView` bounds returned rows without
 * mutating the stored log — history is never rewritten or pruned.
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

/**
 * Absolute path of the persisted archive for a state directory. The file is
 * NDJSON (despite the historical `.json` name kept for v1 migration).
 */
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
  return loadArchiveLog(stateDir).archive;
}

/**
 * Persist the DELTA of `archive` that is not already on disk: new rows become
 * immutable snapshot lines, new pins become pin lines. Earlier bytes are never
 * rewritten — there is no temp+rename of the whole file any more. Returns the
 * (unchanged) archive file path for the caller's report.
 *
 * `options.refusals` and `options.snapshot` let `curate` also record editorial
 * refusals and always persist its pre-run snapshot, even for a batch with no
 * new rows.
 */
export function saveCuratorArchive(
  stateDir: string,
  archive: CuratorArchive,
  options: { refusals?: readonly ArchiveRefusal[]; snapshot?: PreRunSnapshot } = {},
): string {
  appendArchiveArtifacts(stateDir, {
    rows: archive.proposals,
    pins: archive.pins,
    ...(options.snapshot !== undefined ? { snapshots: [options.snapshot] } : {}),
    ...(options.refusals !== undefined ? { refusals: options.refusals } : {}),
  });
  return curatorArchivePath(stateDir);
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

/* -------------------------------------------------------------------------- */
/* NDJSON append log (G-4 residual — physically append-only)                    */
/* -------------------------------------------------------------------------- */
/*
 * The v1 snapshot replace above was append-only only LOGICALLY: every run
 * rewrote the whole file with a temp+rename. This section makes the archive a
 * real append log. The archive file is NDJSON: one IMMUTABLE line per artifact:
 *   - "snapshot": a pre-run snapshot plus the rows archived under it (one run),
 *   - "pin":      a named pin binding,
 *   - "refusal":  a shape-valid but editorially refused proposal.
 * Each line carries a content address (`id` = sha256 of canonical JSON of the
 * line) and a `prev` hash chain (jsonl-chain-head style). Replay verifies seq
 * contiguity, chain linkage and id integrity — a single corrupt or forged line
 * fails the whole load closed. Legacy v1 canonical-JSON snapshot files are read
 * as a base (line 0) and NEVER rewritten; new lines simply append after them.
 * Nothing here can delete, prune or overwrite an earlier line, and all writes
 * are serialized by a cross-process advisory lock (core/file-lock.ts).
 */

/** Version stamped on every NDJSON log line (the legacy snapshot is v1). */
export const ARCHIVE_LOG_VERSION = 2;
export type ArchiveLogLineType = "snapshot" | "pin" | "refusal";

/** A shape-valid proposal the editorial standard refused (maximum set). */
export interface ArchiveRefusal {
  /** Content-addressed id of the refused artifact (sha256 of its canonical JSON). */
  digest: string;
  reason: string;
  detail: string;
}

/** A row carried by a snapshot line; `seq` is derived deterministically on replay. */
interface ArchiveRowInput {
  digest: string;
  kind: string;
  title: string;
}

type LogPayload =
  | { type: "snapshot"; snapshot: PreRunSnapshot; rows: ArchiveRowInput[] }
  | { type: "pin"; name: string; digest: string }
  | { type: "refusal"; digest: string; reason: string; detail: string };

export type ArchiveLogLine = LogPayload & {
  v: number;
  seq: number;
  /** sha256 of canonical JSON of this line without `id` (content address). */
  id: string;
  /** sha256 `id` of the preceding log line; all-zero for the first line. */
  prev: string;
};

const GENESIS_HASH = "0".repeat(64);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function corrupt(file: string, what: string): ArchiveStoreError {
  return new ArchiveStoreError("archive-corrupt", `${file}: ${what}`);
}

function lineId(line: Omit<ArchiveLogLine, "id">): string {
  return sha256Hex(canonicalJson(line));
}

function parseRowInput(raw: unknown, file: string, where: string): ArchiveRowInput {
  if (
    !isRecord(raw) ||
    typeof raw.digest !== "string" ||
    !HEX64.test(raw.digest) ||
    typeof raw.kind !== "string" ||
    typeof raw.title !== "string"
  ) {
    throw corrupt(file, `${where} is not a v2 archive row`);
  }
  return { digest: raw.digest, kind: raw.kind, title: raw.title };
}

/** Parse + validate one NDJSON log line: shape, seq order, chain link and id. */
export function parseArchiveLogLine(text: string, file: string, expectedSeq: number, prev: string): ArchiveLogLine {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw corrupt(file, `log line ${expectedSeq} is not JSON (${storeMessage(err)})`);
  }
  if (!isRecord(value)) throw corrupt(file, `log line ${expectedSeq} is not an object`);
  if (value.v !== ARCHIVE_LOG_VERSION) {
    throw corrupt(file, `log line ${expectedSeq} has unsupported v ${JSON.stringify(value.v)}`);
  }
  if (value.seq !== expectedSeq) {
    throw corrupt(file, `log line ${expectedSeq} has seq ${JSON.stringify(value.seq)} (ordering/gap)`);
  }
  if (typeof value.prev !== "string" || !HEX64.test(value.prev) || value.prev !== prev) {
    throw corrupt(file, `log line ${expectedSeq} has a broken hash-chain link`);
  }

  let payload: LogPayload;
  if (value.type === "snapshot") {
    if (!isSnapshot(value.snapshot) || !Array.isArray(value.rows)) {
      throw corrupt(file, `log line ${expectedSeq} has an invalid snapshot payload`);
    }
    payload = {
      type: "snapshot",
      snapshot: { contentDigest: value.snapshot.contentDigest, takenAt: value.snapshot.takenAt },
      rows: value.rows.map((row, i) => parseRowInput(row, file, `log line ${expectedSeq} rows[${i}]`)),
    };
  } else if (value.type === "pin") {
    if (
      typeof value.name !== "string" ||
      !PIN_NAME_RE.test(value.name) ||
      typeof value.digest !== "string" ||
      !HEX64.test(value.digest)
    ) {
      throw corrupt(file, `log line ${expectedSeq} has an invalid pin payload`);
    }
    payload = { type: "pin", name: value.name, digest: value.digest };
  } else if (value.type === "refusal") {
    if (
      typeof value.digest !== "string" ||
      !HEX64.test(value.digest) ||
      typeof value.reason !== "string" ||
      typeof value.detail !== "string"
    ) {
      throw corrupt(file, `log line ${expectedSeq} has an invalid refusal payload`);
    }
    payload = { type: "refusal", digest: value.digest, reason: value.reason, detail: value.detail };
  } else {
    throw corrupt(file, `log line ${expectedSeq} has unknown type ${JSON.stringify(value.type)}`);
  }

  const { id, v: _v, seq: _seq, prev: _prev, ...rest } = value;
  const withoutId = { ...rest, v: ARCHIVE_LOG_VERSION, seq: expectedSeq, prev };
  if (typeof id !== "string" || id !== lineId(withoutId as Omit<ArchiveLogLine, "id">)) {
    throw corrupt(file, `log line ${expectedSeq} has a bad content address (tampered)`);
  }
  return Object.freeze({ ...withoutId, id }) as ArchiveLogLine;
}

function isLegacySnapshot(value: unknown): boolean {
  return isRecord(value) && value.schemaVersion === ARCHIVE_SCHEMA_VERSION && Array.isArray(value.proposals) && isRecord(value.pins as unknown);
}

export interface ArchiveLogView {
  /** The reconstructed maximum archive (legacy base + every append line). */
  archive: CuratorArchive;
  /** Every recorded editorial refusal, in log order. */
  refusals: readonly ArchiveRefusal[];
  /** Every v2 log line, in order. */
  lines: readonly ArchiveLogLine[];
  /** True when a legacy v1 snapshot file was the base (never rewritten). */
  legacyBase: boolean;
}

/** Parse a whole archive file (legacy base + NDJSON lines) into a view. */
export function parseArchiveLog(text: string, file: string): ArchiveLogView {
  let archive = emptyArchive();
  const refusals: ArchiveRefusal[] = [];
  const lines: ArchiveLogLine[] = [];
  let legacyBase = false;
  let seq = 1;
  let prev = GENESIS_HASH;
  const physical = text.split("\n");
  for (let i = 0; i < physical.length; i += 1) {
    const trimmed = physical[i]!.trim();
    if (trimmed === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (err) {
      throw corrupt(file, `line ${i + 1} is not JSON (${storeMessage(err)})`);
    }
    if (!legacyBase && lines.length === 0 && isLegacySnapshot(value)) {
      // Legacy v1 full-snapshot file: read as the base, NEVER rewritten.
      archive = parseArchive(trimmed);
      legacyBase = true;
      continue;
    }
    const line = parseArchiveLogLine(trimmed, file, seq, prev);
    if (line.type === "snapshot") {
      archive = appendProposals(archive, line.rows, line.snapshot);
    } else if (line.type === "pin") {
      try {
        archive = pin(archive, line.name, line.digest);
      } catch (err) {
        throw corrupt(file, `log line ${seq} pin is invalid (${storeMessage(err)})`);
      }
    } else {
      refusals.push({ digest: line.digest, reason: line.reason, detail: line.detail });
    }
    lines.push(line);
    seq += 1;
    prev = line.id;
  }
  return { archive, refusals, lines, legacyBase };
}

/** Load the full append log from disk. Missing file is a healthy empty log. */
export function loadArchiveLog(stateDir: string): ArchiveLogView {
  const dir = requireStateDir(stateDir);
  const file = curatorArchivePath(dir);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return { archive: emptyArchive(), refusals: [], lines: [], legacyBase: false };
    }
    throw new ArchiveStoreError("archive-corrupt", `archive is unreadable (${storeMessage(err)})`);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_ARCHIVE_BYTES) {
    throw new ArchiveStoreError(
      "archive-corrupt",
      `archive exceeds the bounded read limit of ${MAX_ARCHIVE_BYTES} bytes; refusing rather than truncating history`,
    );
  }
  return parseArchiveLog(text, file);
}

/**
 * Cross-process lock path for the archive, in the state dir. The lock file is
 * created O_EXCL and removed on release, so it leaves no residual file (the
 * state dir still holds only the archive and the proposals store).
 */
export function archiveLockPath(stateDir: string): string {
  return path.join(stateDir, `${ARCHIVE_FILE}.lock`);
}

export interface ArchiveAppendDelta {
  /** New archived rows (already deduped by digest by the caller is optional). */
  rows?: readonly ArchivedProposal[];
  /** Desired pins; only absent names are appended, a different digest is refused. */
  pins?: Readonly<Record<string, string>>;
  /** Editorial refusals to record as immutable lines. */
  refusals?: readonly ArchiveRefusal[];
  /** Pre-run snapshots to persist even when a run adds no rows. */
  snapshots?: readonly PreRunSnapshot[];
}

export interface ArchiveAppendResult {
  path: string;
  appendedLines: number;
  archive: CuratorArchive;
  refusals: readonly ArchiveRefusal[];
}

/**
 * Append the new artifacts of `delta` to the NDJSON log, serialized by a
 * cross-process lock so two concurrent curators cannot race a read-modify-write.
 * Every line is content-addressed and hash-chained; earlier lines are never
 * deleted, rewritten or reordered. The write is a single `appendJsonlSync`
 * (durable O_APPEND + fsync), so a crash leaves either the prior log or the log
 * plus all of this batch's lines — never a half line.
 */
export function appendArchiveArtifacts(stateDir: string, delta: ArchiveAppendDelta): ArchiveAppendResult {
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
  const lock = archiveLockPath(dir);
  return withFileLockSync(lock, () => {
    const before = loadArchiveLog(dir);
    const existingDigests = new Set(before.archive.proposals.map((row) => row.digest));
    const newRows = (delta.rows ?? []).filter(
      (row) => row !== null && typeof row === "object" && typeof row.digest === "string" && HEX64.test(row.digest) && !existingDigests.has(row.digest),
    );

    const groups = new Map<string, { snapshot: PreRunSnapshot; rows: ArchiveRowInput[] }>();
    const keyOf = (snapshot: PreRunSnapshot): string => `${snapshot.contentDigest}\n${snapshot.takenAt}`;
    const addSnapshot = (snapshot: PreRunSnapshot | undefined): void => {
      if (!isSnapshot(snapshot)) return;
      const key = keyOf(snapshot);
      if (!groups.has(key)) {
        groups.set(key, { snapshot: { contentDigest: snapshot.contentDigest, takenAt: snapshot.takenAt }, rows: [] });
      }
    };
    for (const snapshot of delta.snapshots ?? []) addSnapshot(snapshot);
    for (const row of newRows) {
      addSnapshot(row.snapshot);
      groups.get(keyOf(row.snapshot))!.rows.push({ digest: row.digest, kind: row.kind, title: row.title });
    }

    const newPins: LogPayload[] = [];
    for (const name of Object.keys(delta.pins ?? {})) {
      const digest = (delta.pins as Readonly<Record<string, string>>)[name] as string;
      const existing = before.archive.pins[name];
      if (existing === digest) continue;
      if (existing !== undefined) {
        throw new ArchiveStoreError("archive-corrupt", `pin ${JSON.stringify(name)} already bound to ${existing}; refusing to rebind`);
      }
      if (!PIN_NAME_RE.test(name) || typeof digest !== "string" || !HEX64.test(digest)) {
        throw new ArchiveStoreError("archive-corrupt", `invalid pin ${JSON.stringify(name)}=${JSON.stringify(digest)}`);
      }
      newPins.push({ type: "pin", name, digest });
    }

    const refusalKey = (refusal: ArchiveRefusal): string =>
      sha256Hex(canonicalJson({ type: "refusal", digest: refusal.digest, reason: refusal.reason, detail: refusal.detail }));
    const seenRefusals = new Set(before.refusals.map(refusalKey));
    const newRefusals: LogPayload[] = [];
    for (const refusal of delta.refusals ?? []) {
      if (
        refusal === null ||
        typeof refusal !== "object" ||
        typeof refusal.digest !== "string" ||
        !HEX64.test(refusal.digest) ||
        typeof refusal.reason !== "string" ||
        typeof refusal.detail !== "string"
      ) {
        continue;
      }
      const key = refusalKey(refusal);
      if (seenRefusals.has(key)) continue;
      seenRefusals.add(key);
      newRefusals.push({ type: "refusal", digest: refusal.digest, reason: refusal.reason, detail: refusal.detail });
    }

    const payloads: LogPayload[] = [];
    for (const group of groups.values()) {
      payloads.push({ type: "snapshot", snapshot: group.snapshot, rows: group.rows });
    }
    payloads.push(...newPins, ...newRefusals);
    if (payloads.length === 0) {
      return { path: file, appendedLines: 0, archive: before.archive, refusals: before.refusals };
    }

    const parts: string[] = [];
    let seq = before.lines.length + 1;
    let prev = before.lines.length > 0 ? before.lines[before.lines.length - 1]!.id : GENESIS_HASH;
    for (const payload of payloads) {
      const withoutId = { v: ARCHIVE_LOG_VERSION, seq, prev, ...payload } as Omit<ArchiveLogLine, "id">;
      const id = lineId(withoutId);
      parts.push(`${canonicalJson({ ...withoutId, id })}\n`);
      seq += 1;
      prev = id;
    }
    try {
      appendJsonlSync(file, parts.join(""));
      if (isUnix) {
        try {
          chmodSync(file, 0o600);
        } catch {
          /* best effort */
        }
      }
    } catch (err) {
      throw new ArchiveStoreError("archive-write-failed", `cannot append archive artifacts to ${file} (${storeMessage(err)})`);
    }
    const after = loadArchiveLog(dir);
    return { path: file, appendedLines: payloads.length, archive: after.archive, refusals: after.refusals };
  });
}
