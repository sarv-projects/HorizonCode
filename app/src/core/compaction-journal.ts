/**
 * Durable CompactionRecordV1 chain (ruling **296** reduced).
 *
 * Appends to `<kernel state>/compactions.jsonl` with a `.head` anchor on each
 * host compaction (history window, hold-swap, emergency context-window shrink).
 */

import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { canonicalJson, sha256Hex } from "./canon";
import { appendJsonlSync } from "./jsonl-append";
import { writeJsonlHeadSync } from "./jsonl-chain-head";
import { anchorKeyFromEnv } from "./kernel";
import { kernelStateDir } from "./paths";

export const COMPACTIONS_LEDGER_FILE = "compactions.jsonl";

export type CompactionTrigger = "history-window" | "hold-swap" | "emergency-context-window";

export interface CompactionRecordV1 {
  v: 1;
  id: string;
  seq: number;
  ts: string;
  sessionId?: string;
  trigger: CompactionTrigger;
  tokensBefore: number;
  tokensAfter: number;
  dropped: number;
  kept: number;
  window: number;
  summaryDigest: string;
  /** Reduced strategy tag; full doc 10 strategy set still open. */
  strategySet: string[];
  prevHash: string | null;
  hash: string;
}

const COMPACTION_PREIMAGE_FIELDS = [
  "v",
  "id",
  "seq",
  "ts",
  "sessionId",
  "trigger",
  "tokensBefore",
  "tokensAfter",
  "dropped",
  "kept",
  "window",
  "summaryDigest",
  "strategySet",
  "prevHash",
] as const;

function compactionPreimage(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of COMPACTION_PREIMAGE_FIELDS) {
    const val = record[field];
    if (field === "sessionId" && (val === undefined || val === null)) continue;
    out[field] = val === undefined ? null : val;
  }
  return out;
}

export function hashCompactionRecord(record: Omit<CompactionRecordV1, "hash">): string {
  return sha256Hex(canonicalJson(compactionPreimage(record as unknown as Record<string, unknown>)));
}

export function compactionAnchorDigest(
  record: CompactionRecordV1,
  env: Record<string, string | undefined> = process.env,
): string {
  const canonical = canonicalJson(compactionPreimage(record as unknown as Record<string, unknown>));
  const anchorKey = anchorKeyFromEnv(env);
  if (anchorKey === undefined) return record.hash;
  return createHmac("sha256", anchorKey).update(canonical, "utf8").digest("hex");
}

export function compactionsLedgerPath(workspace: string): string {
  return path.join(kernelStateDir(workspace), COMPACTIONS_LEDGER_FILE);
}

function readCompactionTailHash(file: string): { seq: number; prevHash: string | null } {
  if (!existsSync(file)) return { seq: 0, prevHash: null };
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { seq: 0, prevHash: null };
  const lastLine = lines[lines.length - 1]!;
  try {
    const row = JSON.parse(lastLine) as CompactionRecordV1;
    if (row.v === 1 && typeof row.seq === "number" && typeof row.hash === "string") {
      return { seq: row.seq, prevHash: row.hash };
    }
  } catch {
    /* legacy row — chain from line count only */
  }
  return { seq: lines.length, prevHash: null };
}

export interface AppendCompactionRecordInput {
  sessionId?: string;
  trigger: CompactionTrigger;
  tokensBefore: number;
  tokensAfter: number;
  dropped: number;
  kept: number;
  window: number;
  summaryDigest: string;
}

/** Append one CompactionRecordV1 and refresh `.head` (non-fatal on failure). */
export function appendCompactionRecord(workspace: string, input: AppendCompactionRecordInput): CompactionRecordV1 | undefined {
  try {
    const file = compactionsLedgerPath(workspace);
    mkdirSync(path.dirname(file), { recursive: true });
    const tail = readCompactionTailHash(file);
    const seq = tail.seq + 1;
    const base: Omit<CompactionRecordV1, "hash"> = {
      v: 1,
      id: randomUUID(),
      seq,
      ts: new Date().toISOString(),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      trigger: input.trigger,
      tokensBefore: input.tokensBefore,
      tokensAfter: input.tokensAfter,
      dropped: input.dropped,
      kept: input.kept,
      window: input.window,
      summaryDigest: input.summaryDigest,
      strategySet: input.trigger === "hold-swap" ? ["digest", "hold-swap"] : ["digest", "verbatim-tail"],
      prevHash: tail.prevHash,
    };
    const record: CompactionRecordV1 = { ...base, hash: hashCompactionRecord(base) };
    appendJsonlSync(file, `${JSON.stringify(record)}\n`);
    writeJsonlHeadSync(file, record.seq, compactionAnchorDigest(record));
    return record;
  } catch {
    return undefined;
  }
}
