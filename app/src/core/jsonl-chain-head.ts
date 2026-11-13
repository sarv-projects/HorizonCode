/**
 * Sync `.head` anchors for append-only JSONL chains (ruling **296** reduced).
 */

import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { canonicalJson } from "./canon";

export function writeJsonlHeadSync(file: string, seq: number, hash: string): void {
  const tmp = `${file}.head.tmp`;
  writeFileSync(tmp, `${canonicalJson({ seq, hash })}\n`, "utf8");
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best-effort */
  }
  renameSync(tmp, `${file}.head`);
  try {
    chmodSync(`${file}.head`, 0o600);
  } catch {
    /* best-effort */
  }
}
