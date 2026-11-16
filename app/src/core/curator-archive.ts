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
