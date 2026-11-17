/**
 * artifact-uri.ts — B-7: a stable, content-addressed `hz://artifact/<id>` pointer
 * for spilled tool output, resolved safely by the `read` tool.
 *
 * The artifact id IS the sha256 of the spilled bytes, so it is stable across
 * processes and identical to the spill filename — no new store, no manifest,
 * no runtime dependency. The raw `<spill dir>/<hash>.txt` path keeps working;
 * the URI is offered ALONGSIDE it as a friendlier, relocation-proof handle.
 *
 * Containment and traversal are fail-closed: only a bare 64-hex id is accepted,
 * the resolved path must stay under the spill root, and callers enforce a size
 * cap before reading. Pure module: no I/O beyond path arithmetic.
 */

import * as path from "node:path";

export const ARTIFACT_URI_PREFIX = "hz://artifact/";
const HEX64 = /^[0-9a-f]{64}$/i;

/** Maximum bytes of artifact content `read` will load (matches the read tool's file cap). */
export const ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;

export interface ParsedArtifactUri {
  /** Lower-cased 64-char hex sha256. */
  id: string;
}

/**
 * Parse `hz://artifact/<64-hex>`. Rejects traversal (`..`), separators, query
 * strings, fragments, wrong-length or non-hex ids, and any extra characters —
 * the regex is the whole contract, so an id can never escape its directory.
 */
export function parseArtifactUri(value: unknown): ParsedArtifactUri | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^hz:\/\/artifact\/([0-9a-f]{64})$/i.exec(value);
  if (match === null) return undefined;
  const id = (match[1] as string).toLowerCase();
  if (!HEX64.test(id)) return undefined;
  return { id };
}

/** True when `value` is an artifact URI (valid or not — for dispatch decisions). */
export function isArtifactUri(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(ARTIFACT_URI_PREFIX);
}

/** Build the URI from a content sha256 (accepts upper case, normalizes to lower). */
export function artifactUriForHash(hash: unknown): string | undefined {
  if (typeof hash !== "string" || !HEX64.test(hash)) return undefined;
  return `${ARTIFACT_URI_PREFIX}${hash.toLowerCase()}`;
}

/** Path containment: `target` must be `root` itself or beneath it. */
export function isContained(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Pure: resolve a valid artifact URI to `<spillDir>/<id>.txt`, refusing anything
 * that would escape `spillDir`. Does not touch the filesystem.
 */
export function resolveArtifactPath(spillDir: string, uri: string): string | undefined {
  const parsed = parseArtifactUri(uri);
  if (parsed === undefined) return undefined;
  const root = path.resolve(spillDir);
  const target = path.join(root, `${parsed.id}.txt`);
  return isContained(root, target) ? target : undefined;
}
