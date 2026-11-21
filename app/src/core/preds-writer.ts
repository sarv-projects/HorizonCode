/**
 * J-1 reduced (docs/30): SWE-bench-shaped `preds.json` writer with zero harness
 * dependency (ADAPT mini-swe-agent `update_preds_file`).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { GuardAction } from "../contracts";
import { KernelClient } from "./kernel";
import { guardEffectivelyAllows } from "./guard-g1-wire";

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

/**
 * Under-admission (rulings 579–580): Guard `fs.write` on a CLI output path
 * (`--preds-out`, `--metrics-out`, `--write-approval`). Returns an error string
 * on deny/ask/guard failure; undefined when allowed.
 */
export async function admitPredsOutWrite(
  predsOut: string,
  workspace: string = process.cwd(),
): Promise<string | undefined> {
  const target = path.resolve(predsOut);
  const action: GuardAction = { kind: "fs.write", target };
  const root = path.resolve(workspace);
  const scope = target === root || target.startsWith(root + path.sep) ? "workspace" : "outside";
  const kernel = new KernelClient({ workspace });
  await kernel.start();
  try {
    let decision;
    try {
      decision = await kernel.checkGuard(action, scope);
    } catch (err) {
      return `preds write refused: the guard could not decide (${err instanceof Error ? err.message : String(err)})`;
    }
    if (decision.decision === "deny") {
      return `preds write denied — ${decision.reason !== undefined && decision.reason !== "" ? decision.reason : "fs.write"}`;
    }
    if (decision.decision === "ask" && !guardEffectivelyAllows(decision)) {
      return "preds fs.write requires approval (not available in this command); allow the path in policy";
    }
    return undefined;
  } finally {
    await kernel.close().catch(() => undefined);
  }
}

/**
 * Explicit CLI output flags (`--metrics-out`, `--preds-out`, `--write-approval`,
 * ratchet decision logs): Ask cannot be resolved non-interactively, and the
 * flag itself is the operator consent for that path. Deny still refuses.
 * Use for outside-cwd temp paths under a trusted kernel (default outside=ask).
 */
export async function admitExplicitCliOutWrite(
  file: string,
  workspace: string = process.cwd(),
): Promise<string | undefined> {
  const refused = await admitPredsOutWrite(file, workspace);
  if (refused === undefined) return undefined;
  if (/requires approval/i.test(refused)) return undefined;
  return refused;
}
