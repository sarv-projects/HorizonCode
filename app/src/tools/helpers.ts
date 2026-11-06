/** Shared helpers for the HorizonCode tool set. */

import path from "node:path";

/** Truncate text to `max` characters, appending an explicit marker when cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + "\n[truncated]";
}

/** Resolve a caller-supplied path against the tool context cwd. */
export function resolvePath(cwd: string, p: string): string {
  return path.resolve(cwd, p);
}

/** True when a NUL byte appears in the head of the buffer (binary file). */
export function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Display path: relative to `base` when inside it, absolute otherwise. */
export function relPath(base: string, p: string): string {
  const rel = path.relative(base, p);
  if (rel === "") return path.basename(p) || ".";
  return rel.startsWith("..") || path.isAbsolute(rel) ? p : rel;
}
