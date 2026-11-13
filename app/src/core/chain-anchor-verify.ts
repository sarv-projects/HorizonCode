/**
 * chain-anchor-verify.ts — sync `.head` anchor checks (ruling **294** reduced).
 *
 * Mirrors `LocalKernel.checkAnchor` for read-only CLI verify paths.
 * Evidence gate / keyed interop refusal surfaces as `refusal` (fail closed).
 */

import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { EventEnvelope, Receipt } from "../contracts";
import { hashEnvelope, hashReceipt } from "../contracts";
import { canonicalJson, sha256Hex } from "./canon";
import { acceptLegacyAnchorsFromEnv, anchorKeyFromEnv } from "./kernel";
import {
  type CompactionRecordV1,
  compactionAnchorDigest,
  hashCompactionRecord,
} from "./compaction-journal";
import { kernelStateDir } from "./paths";
import { receiptsPath, sessionEventsPath } from "./session-kernel-reconcile";

export type ChainHead = { seq: number; hash: string } | "corrupt" | undefined;

export interface ChainAnchorVerdict {
  ok: boolean;
  label: string;
  count: number;
  brokenAt?: number;
  refusal?: string;
  /** Present when `.head` absent on a non-empty chain (legacy unkeyed). */
  anchorAbsent?: boolean;
  skipped?: boolean;
}

const EVENT_PREIMAGE_FIELDS = ["id", "seq", "ts", "stream", "type", "actor", "payload", "prevHash"] as const;
const RECEIPT_PREIMAGE_FIELDS = [
  "id",
  "seq",
  "ts",
  "action",
  "tool",
  "argsDigest",
  "resultDigest",
  "prevHash",
] as const;

function preimageOf(record: unknown, fields: readonly string[]): Record<string, unknown> {
  const source = (record ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = source[field] === undefined ? null : source[field];
  return out;
}

function receiptPreimageOf(record: unknown): Record<string, unknown> {
  const out = preimageOf(record, RECEIPT_PREIMAGE_FIELDS);
  const leaseId = (record as Record<string, unknown> | null | undefined)?.leaseId;
  if (leaseId !== undefined && leaseId !== null) out.leaseId = leaseId;
  return out;
}

function anchorDigest(
  kind: "event" | "receipt" | "compaction",
  record: unknown,
  env: Record<string, string | undefined>,
): string {
  if (kind === "compaction") {
    return compactionAnchorDigest(record as CompactionRecordV1, env);
  }
  const preimage =
    kind === "event"
      ? preimageOf(record, EVENT_PREIMAGE_FIELDS)
      : receiptPreimageOf(record);
  const canonical = canonicalJson(preimage);
  const anchorKey = anchorKeyFromEnv(env);
  if (anchorKey === undefined) return sha256Hex(canonical);
  return createHmac("sha256", anchorKey).update(canonical, "utf8").digest("hex");
}

function legacyRefusal(detail: string): string {
  return `HZ_PRECONDITION_FAILED: legacy (unkeyed) anchor: ${detail} — HZ_ANCHOR_KEY is configured; set HZ_ACCEPT_LEGACY_ANCHORS=1 to accept it`;
}

export function readHeadSync(file: string): ChainHead {
  const headFile = `${file}.head`;
  if (!existsSync(headFile)) return undefined;
  let text: string;
  try {
    text = readFileSync(headFile, "utf8");
  } catch (err) {
    return "corrupt";
  }
  try {
    const parsed = JSON.parse(text.trim()) as { seq?: unknown; hash?: unknown };
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.seq === "number" &&
      typeof parsed.hash === "string"
    ) {
      return { seq: parsed.seq, hash: parsed.hash };
    }
  } catch {
    /* corrupt */
  }
  return "corrupt";
}

export function checkChainAnchorSync(opts: {
  head: ChainHead;
  count: number;
  last: { hash: string; record: Record<string, unknown> } | undefined;
  kind: "event" | "receipt" | "compaction";
  label: string;
  env?: Record<string, string | undefined>;
}): { ok: boolean; brokenAt?: number; refusal?: string; anchorAbsent?: boolean } {
  const env = opts.env ?? process.env;
  const head = opts.head;
  const count = opts.count;
  const last = opts.last;
  const anchorKey = anchorKeyFromEnv(env);
  const acceptLegacy = acceptLegacyAnchorsFromEnv(env);

  if (head === undefined) {
    if (anchorKey !== undefined && count > 0) {
      return { ok: false, refusal: legacyRefusal(`chain ${opts.label} has ${count} record(s) but no anchor`) };
    }
    return count > 0 ? { ok: true, anchorAbsent: true } : { ok: true };
  }
  if (head === "corrupt") return { ok: false, brokenAt: count + 1 };
  if (head.seq > count) return { ok: false, brokenAt: count + 1 };
  if (head.seq < count) return { ok: false, brokenAt: head.seq + 1 };
  if (count === 0) return { ok: true };
  if (last === undefined) return { ok: false, brokenAt: count };

  if (anchorKey !== undefined) {
    if (anchorDigest(opts.kind, last.record, env) === head.hash) return { ok: true };
    if (last.hash === head.hash) {
      if (acceptLegacy) return { ok: true };
      return { ok: false, refusal: legacyRefusal(`chain ${opts.label} is anchored with an unkeyed anchor`) };
    }
    return { ok: false, brokenAt: count };
  }
  if (head.hash !== last.hash) return { ok: false, brokenAt: count };
  return { ok: true };
}

function verifyReceiptHashWalk(
  file: string,
): { ok: boolean; count: number; brokenAt?: number; last?: { hash: string; record: Record<string, unknown> } } {
  if (!existsSync(file)) return { ok: true, count: 0 };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { ok: false, count: 0, brokenAt: 1 };
  }
  let count = 0;
  let prevHash: string | null = null;
  let last: { hash: string; record: Record<string, unknown> } | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const expected = count + 1;
    let receipt: Receipt;
    try {
      receipt = JSON.parse(trimmed) as Receipt;
    } catch {
      return { ok: false, count, brokenAt: expected };
    }
    if (
      receipt === null ||
      typeof receipt !== "object" ||
      typeof receipt.seq !== "number" ||
      typeof receipt.hash !== "string"
    ) {
      return { ok: false, count, brokenAt: expected };
    }
    if (receipt.seq !== expected) {
      return { ok: false, count, brokenAt: receipt.seq > 0 ? receipt.seq : expected };
    }
    if (receipt.prevHash !== prevHash) return { ok: false, count, brokenAt: receipt.seq };
    const { hash, effectId: _e, postimageDigest: _pd, postimagePath: _pp, childEffectIds: _c, ...rest } = receipt as Receipt & {
      childEffectIds?: string[];
    };
    if (hashReceipt(rest) !== hash) return { ok: false, count, brokenAt: receipt.seq };
    prevHash = hash;
    last = { hash, record: receipt as unknown as Record<string, unknown> };
    count = expected;
  }
  return { ok: true, count, last };
}

function verifyEventHashWalk(
  file: string,
): { ok: boolean; count: number; brokenAt?: number; last?: { hash: string; record: Record<string, unknown> } } {
  if (!existsSync(file)) return { ok: true, count: 0 };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { ok: false, count: 0, brokenAt: 1 };
  }
  let count = 0;
  let prevHash: string | null = null;
  let last: { hash: string; record: Record<string, unknown> } | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const expected = count + 1;
    let ev: EventEnvelope;
    try {
      ev = JSON.parse(trimmed) as EventEnvelope;
    } catch {
      return { ok: false, count, brokenAt: expected };
    }
    if (ev === null || typeof ev !== "object" || typeof ev.seq !== "number" || typeof ev.hash !== "string") {
      return { ok: false, count, brokenAt: expected };
    }
    if (ev.seq !== expected) return { ok: false, count, brokenAt: ev.seq > 0 ? ev.seq : expected };
    if (ev.prevHash !== prevHash) return { ok: false, count, brokenAt: ev.seq };
    const { hash, ...rest } = ev;
    if (hashEnvelope(rest) !== hash) return { ok: false, count, brokenAt: ev.seq };
    prevHash = hash;
    last = { hash, record: ev as unknown as Record<string, unknown> };
    count = expected;
  }
  return { ok: true, count, last };
}

/** Optional compaction-related chains when persisted (design: doc 10 R116 / doc 12). */
export const OPTIONAL_COMPACTION_CHAIN_CANDIDATES = [
  "compactions.jsonl",
  "events/compactions.jsonl",
] as const;

export function optionalCompactionChainPaths(workspace: string): string[] {
  const base = kernelStateDir(workspace);
  return OPTIONAL_COMPACTION_CHAIN_CANDIDATES.map((rel) => `${base}/${rel}`).filter((p) => existsSync(p));
}

function verifyCompactionHashWalk(
  file: string,
): { ok: boolean; count: number; brokenAt?: number; last?: { hash: string; record: Record<string, unknown> }; v1: boolean } {
  if (!existsSync(file)) return { ok: true, count: 0, v1: false };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { ok: false, count: 0, brokenAt: 1, v1: false };
  }
  let count = 0;
  let prevHash: string | null = null;
  let last: { hash: string; record: Record<string, unknown> } | undefined;
  let sawV1 = false;
  let legacyOnly = true;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const expected = count + 1;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return { ok: false, count, brokenAt: expected, v1: sawV1 };
    }
    if (row.v === 1 && typeof row.seq === "number" && typeof row.hash === "string") {
      legacyOnly = false;
      sawV1 = true;
      const rec = row as unknown as CompactionRecordV1;
      if (rec.seq !== expected) {
        return { ok: false, count, brokenAt: rec.seq > 0 ? rec.seq : expected, v1: true };
      }
      if (rec.prevHash !== prevHash) return { ok: false, count, brokenAt: rec.seq, v1: true };
      const { hash, ...rest } = rec;
      if (hashCompactionRecord(rest as Omit<CompactionRecordV1, "hash">) !== hash) {
        return { ok: false, count, brokenAt: rec.seq, v1: true };
      }
      prevHash = hash;
      last = { hash, record: row };
      count = expected;
      continue;
    }
    if (legacyOnly) {
      count += 1;
      last = { hash: "", record: row };
      continue;
    }
    return { ok: false, count, brokenAt: expected, v1: true };
  }
  return { ok: true, count, last, v1: sawV1 };
}

/** Compaction chain: hash walk for CompactionRecordV1 when present; legacy line-count `.head` otherwise. */
export function verifyCompactionAnchorSync(file: string, env?: Record<string, string | undefined>): ChainAnchorVerdict {
  const label = file.endsWith("compactions.jsonl") ? "compactions.jsonl" : file;
  if (!existsSync(file)) {
    return { ok: true, label, count: 0, skipped: true };
  }
  const walk = verifyCompactionHashWalk(file);
  if (!walk.ok) {
    return { ok: false, label, count: walk.count, brokenAt: walk.brokenAt };
  }
  if (!walk.v1) {
    const head = readHeadSync(file);
    const count = walk.count;
    const anchorKey = anchorKeyFromEnv(env ?? process.env);
    if (head === undefined) {
      if (anchorKey !== undefined && count > 0) {
        return {
          ok: false,
          label,
          count,
          refusal: legacyRefusal(`chain ${label} has ${count} record(s) but no anchor`),
        };
      }
      return { ok: true, label, count, anchorAbsent: count > 0 };
    }
    if (head === "corrupt") return { ok: false, label, count, brokenAt: count + 1 };
    if (head.seq !== count) {
      return { ok: false, label, count, brokenAt: head.seq < count ? head.seq + 1 : count + 1 };
    }
    return { ok: true, label, count };
  }
  const check = checkChainAnchorSync({
    head: readHeadSync(file),
    count: walk.count,
    last: walk.last,
    kind: "compaction",
    label: file,
    env,
  });
  if (check.refusal) return { ok: false, label, count: walk.count, refusal: check.refusal };
  if (!check.ok) return { ok: false, label, count: walk.count, brokenAt: check.brokenAt };
  return { ok: true, label, count: walk.count, anchorAbsent: check.anchorAbsent };
}

export function verifyReceiptAnchorSync(
  workspace: string,
  env?: Record<string, string | undefined>,
): ChainAnchorVerdict {
  const file = receiptsPath(workspace);
  const label = "receipts.jsonl";
  const walk = verifyReceiptHashWalk(file);
  if (!walk.ok) {
    return { ok: false, label, count: walk.count, brokenAt: walk.brokenAt };
  }
  const check = checkChainAnchorSync({
    head: readHeadSync(file),
    count: walk.count,
    last: walk.last,
    kind: "receipt",
    label: file,
    env,
  });
  if (check.refusal) return { ok: false, label, count: walk.count, refusal: check.refusal };
  if (!check.ok) return { ok: false, label, count: walk.count, brokenAt: check.brokenAt };
  return { ok: true, label, count: walk.count, anchorAbsent: check.anchorAbsent };
}

export function verifySessionEventAnchorSync(
  workspace: string,
  sessionId: string,
  env?: Record<string, string | undefined>,
): ChainAnchorVerdict {
  const file = sessionEventsPath(workspace, sessionId);
  const label = `session events (${sessionId})`;
  if (!existsSync(file)) {
    return { ok: true, label, count: 0, skipped: true };
  }
  const walk = verifyEventHashWalk(file);
  if (!walk.ok) {
    return { ok: false, label, count: walk.count, brokenAt: walk.brokenAt };
  }
  const check = checkChainAnchorSync({
    head: readHeadSync(file),
    count: walk.count,
    last: walk.last,
    kind: "event",
    label: file,
    env,
  });
  if (check.refusal) return { ok: false, label, count: walk.count, refusal: check.refusal };
  if (!check.ok) return { ok: false, label, count: walk.count, brokenAt: check.brokenAt };
  return { ok: true, label, count: walk.count, anchorAbsent: check.anchorAbsent };
}

export function formatChainAnchorSummary(v: ChainAnchorVerdict): string[] {
  if (v.skipped) return [`${v.label}: (absent — skipped)`];
  if (v.refusal) return [`${v.label}: refused`, `  ${v.refusal}`];
  if (!v.ok) {
    return [
      `${v.label}: anchor broken`,
      `  brokenAt seq ${v.brokenAt ?? "?"}`,
      `  record count ${v.count}`,
    ];
  }
  if (v.anchorAbsent && v.count > 0) {
    return [`${v.label}: ok (${v.count} record(s); legacy — no .head)`];
  }
  return [`${v.label}: ok (${v.count} record(s); anchor checked when present)`];
}
