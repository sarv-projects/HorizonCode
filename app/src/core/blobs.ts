/**
 * blobs.ts — content-addressed session blob bodies (F7 reduced slice).
 *
 * Stores bytes under `<state>/blobs/<ab>/<cd>/<sha256>` (docs/12 §4.1, S-54/S-57):
 * two-level shard fan-out, dedup by hash, atomic temp-write + rename, owner-only
 * modes. No SQLite refs, pins, or GC yet — call sites hold the hash or path in
 * their own record (e.g. a truncation marker when `HZ_BLOB_SPILL=1`).
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import * as path from "node:path";
import { blobsDir } from "./paths";

const SHA256_HEX = /^[0-9a-f]{64}$/i;
const isUnix = process.platform !== "win32";

function setOwnerOnly(target: string, mode: number): void {
  if (!isUnix) return;
  try {
    chmodSync(target, mode);
  } catch {
    /* best effort */
  }
}

/** True when tool-output spill should land in the blob CAS instead of `spills/`. */
export function blobSpillEnabled(): boolean {
  return process.env.HZ_BLOB_SPILL === "1";
}

/** Parse a 64-char hex sha256 into two-level shard directory names. */
export function blobShardSegments(hash: string): { ab: string; cd: string; normalized: string } | undefined {
  const normalized = hash.toLowerCase();
  if (!SHA256_HEX.test(normalized)) return undefined;
  return { ab: normalized.slice(0, 2), cd: normalized.slice(2, 4), normalized };
}

/** Absolute path to a blob body under a blob-store root. */
export function blobBodyPath(root: string, hash: string): string | undefined {
  const segs = blobShardSegments(hash);
  if (segs === undefined) return undefined;
  return path.join(root, segs.ab, segs.cd, segs.normalized);
}

export interface PutBlobResult {
  hash: string;
  path: string;
  /** False when an existing file already held the same bytes. */
  created: boolean;
}

function sha256Of(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Store `body` under `root`, keyed by its sha256. Existing content with the
 * same hash is left untouched (dedup). A corrupt file (hash mismatch) is
 * removed and rewritten (S-57).
 */
export function putBlob(root: string, body: Buffer | string): PutBlobResult {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const hash = sha256Of(buf);
  const target = blobBodyPath(root, hash);
  if (target === undefined) throw new Error(`invalid blob hash: ${hash}`);

  if (existsSync(target)) {
    const onDisk = readFileSync(target);
    if (sha256Of(onDisk) === hash) return { hash, path: target, created: false };
    unlinkSync(target);
  }

  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true });
  setOwnerOnly(dir, 0o700);

  const tmp = path.join(dir, `.${hash.slice(0, 12)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, buf);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
  setOwnerOnly(target, 0o600);
  return { hash, path: target, created: true };
}

export type GetBlobResult = { ok: true; body: Buffer } | { ok: false; reason: "missing" | "hash_mismatch" };

/** Read a blob by hash; verifies on-disk bytes match the key (S-57). */
export function getBlob(root: string, hash: string): GetBlobResult {
  const target = blobBodyPath(root, hash);
  if (target === undefined || !existsSync(target)) return { ok: false, reason: "missing" };
  const body = readFileSync(target);
  const segs = blobShardSegments(hash);
  if (segs === undefined) return { ok: false, reason: "missing" };
  if (sha256Of(body) !== segs.normalized) return { ok: false, reason: "hash_mismatch" };
  return { ok: true, body };
}

export function putBlobForWorkspace(workspace: string, body: Buffer | string): PutBlobResult {
  return putBlob(blobsDir(workspace), body);
}

export function getBlobForWorkspace(workspace: string, hash: string): GetBlobResult {
  return getBlob(blobsDir(workspace), hash);
}

/** Workspace-relative blob path for human-facing truncation markers. */
export function displayBlobBodyPath(workspace: string, hash: string): string | undefined {
  const absolute = blobBodyPath(blobsDir(workspace), hash);
  if (absolute === undefined) return undefined;
  const relative = path.relative(path.resolve(workspace), absolute);
  return relative === "" || relative.startsWith("..") ? absolute : relative;
}
