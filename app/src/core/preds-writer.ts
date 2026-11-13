/**
 * J-1 reduced (docs/30): SWE-bench-shaped `preds.json` writer with zero harness
 * dependency (ADAPT mini-swe-agent `update_preds_file`).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export interface PredsRecordV1 {
  model_name_or_path: string;
  instance_id: string;
  model_patch: string;
  exit_status?: string;
  horizon?: {
    terminal: string;
    sessionId?: string;
    durationMs?: number;
  };
}

export type PredsFileV1 = Record<string, PredsRecordV1>;

function tmpPath(file: string): string {
  return `${file}.tmp-${randomBytes(4).toString("hex")}`;
}

export function loadPredsFile(file: string): PredsFileV1 {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as PredsFileV1;
  } catch {
    return {};
  }
}

/** Atomic read-modify-write one instance record (best-effort lock: write to temp + rename). */
export function upsertPredsRecord(file: string, record: PredsRecordV1): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const map = loadPredsFile(file);
  map[record.instance_id] = record;
  const tmp = tmpPath(file);
  writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}
