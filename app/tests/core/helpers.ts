/**
 * helpers.ts — shared support for the app/tests/core suite.
 *
 * Everything here is deliberately independent of the implementation under test:
 * hashes are recomputed from the field lists that contracts.ts freezes, files are
 * parsed with plain JSON.parse, and the Rust kernel is driven over raw NDJSON.
 * Tests are hermetic: temp dirs live under os.tmpdir() and every environment
 * change is saved and restored by the caller.
 */

import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EventEnvelope, EventSeed, Receipt } from "../../src/contracts";
import { canonicalJson, sha256Hex } from "../../src/contracts";

/* ------------------------------ environment ------------------------------ */

/** Repo root, derived from this file's location (app/tests/core -> repo root). */
export const repoRoot = path.resolve(import.meta.dir, "../../..");

/** The release build of the Rust kernel; absent on a machine without cargo. */
export const rustKernelPath = path.join(repoRoot, "kernel", "target", "release", "hz-kernel");
export const hasRustKernel = existsSync(rustKernelPath);

/** Version declared by kernel/Cargo.toml — the kernel's own answer to ping. */
export function cargoKernelVersion(): string | undefined {
  try {
    const toml = readFileSync(path.join(repoRoot, "kernel", "Cargo.toml"), "utf8");
    return /^version\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  } catch {
    return undefined;
  }
}

/** Environment variables this suite ever touches, saved and restored verbatim. */
export const ENV_KEYS = [
  "HOME",
  "HZ_KERNEL_BIN",
  "HZ_STATE_DIR",
  "HZ_PROVIDER",
  "HZ_MODEL",
  "HZ_BASE_URL",
  "HZ_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

export type EnvSnapshot = Array<readonly [string, string | undefined]>;

export function snapshotEnv(): EnvSnapshot {
  return ENV_KEYS.map((key) => [key, process.env[key]] as const);
}

export function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Set (or unset, with undefined) several variables at once. */
export function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/* -------------------------------- temp dirs -------------------------------- */

const temps: string[] = [];

/** A fresh directory under os.tmpdir(); removed by cleanupTemps(). */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

export function cleanupTemps(): void {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort: temp files must never fail a test run */
    }
  }
}

/* --------------------------------- files --------------------------------- */

/** Non-empty lines of a text file; [] when it does not exist. */
export function readLines(file: string): string[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    return [];
  }
}

/** Parse a JSONL file written by either kernel. */
export function readJsonl<T>(file: string): T[] {
  return readLines(file).map((line) => JSON.parse(line) as T);
}

/** Where the kernel keeps the events of `stream` (contracts.ts: ':' -> "__"). */
export function eventFilePath(stateDir: string, stream: string): string {
  return path.join(stateDir, "events", stream.split(":").join("__") + ".jsonl");
}

export function receiptsFilePath(stateDir: string): string {
  return path.join(stateDir, "receipts.jsonl");
}

/* -------------------------- hashing (the contract) -------------------------- */

/** The fields contracts.ts says the event hash covers (all but `hash`). */
export const ENVELOPE_FIELDS = ["id", "seq", "ts", "stream", "type", "actor", "payload", "prevHash"] as const;
export const ENVELOPE_KEYS = [...ENVELOPE_FIELDS, "hash"];
export const RECEIPT_FIELDS = ["id", "seq", "ts", "action", "tool", "argsDigest", "resultDigest", "prevHash"] as const;

/** Build the hash input explicitly, so an extra envelope field cannot sneak in. */
export function eventPreimage(event: EventEnvelope): Record<string, unknown> {
  const record = event as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of ENVELOPE_FIELDS) out[field] = record[field];
  return out;
}

export function receiptPreimage(receipt: Receipt): Record<string, unknown> {
  const record = receipt as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of RECEIPT_FIELDS) out[field] = record[field];
  if (record.leaseId !== undefined && record.leaseId !== null) out.leaseId = record.leaseId;
  return out;
}

/** sha256Hex(canonicalJson(...)) recomputed from contracts.ts — never the kernel's word. */
export function recomputeEventHash(event: EventEnvelope): string {
  return sha256Hex(canonicalJson(eventPreimage(event)));
}

export function recomputeReceiptHash(receipt: Receipt): string {
  return sha256Hex(canonicalJson(receiptPreimage(receipt)));
}

const HEX64 = /^[0-9a-f]{64}$/;

/* ----------------------------- chain assertions ----------------------------- */

/** seq continuity, prevHash links and independently recomputed hashes. */
export function assertEventChain(events: EventEnvelope[], label = "event chain"): void {
  expect(events.length, `${label}: some events`).toBeGreaterThan(0);
  let prevHash: string | null = null;
  events.forEach((event, index) => {
    const at = `${label}: event ${index + 1}`;
    expect(event.seq, at).toBe(index + 1);
    expect(event.prevHash, `${at}: prevHash link`).toBe(prevHash);
    expect(Object.keys(event).sort(), `${at}: envelope fields`).toEqual([...ENVELOPE_KEYS].sort());
    expect(event.hash, `${at}: hash shape`).toMatch(HEX64);
    expect(recomputeEventHash(event), `${at}: recomputed hash`).toBe(event.hash);
    prevHash = event.hash;
  });
}

export function assertReceiptChain(receipts: Receipt[], label = "receipt chain"): void {
  expect(receipts.length, `${label}: some receipts`).toBeGreaterThan(0);
  let prevHash: string | null = null;
  receipts.forEach((receipt, index) => {
    const at = `${label}: receipt ${index + 1}`;
    expect(receipt.seq, at).toBe(index + 1);
    expect(receipt.prevHash, `${at}: prevHash link`).toBe(prevHash);
    expect(receipt.hash, `${at}: hash shape`).toMatch(HEX64);
    expect(recomputeReceiptHash(receipt), `${at}: recomputed hash`).toBe(receipt.hash);
    prevHash = receipt.hash;
  });
}

/* ------------------------------ event seeds ------------------------------ */

/** A fully deterministic seed: same bytes in, same hash out, for either kernel. */
export function seedFor(stream: string, type: string, payload: unknown, id = "evt-1"): EventSeed {
  return {
    id,
    ts: "2026-01-02T03:04:05.006Z",
    stream,
    type,
    actor: { kind: "agent", id: "hzcode-test" },
    payload,
  };
}

/* ---------------------------- raw kernel driver ---------------------------- */

export interface KernelReply {
  id: number | null;
  result?: unknown;
  error?: { message?: string };
}

export interface KernelRun {
  status: number | null;
  signal: string | null;
  replies: KernelReply[];
  stderr: string;
}

/**
 * Drive the Rust kernel as the runtime does: NDJSON requests on stdin, one
 * response line each. The process exits at EOF, so a whole conversation can be
 * piped in at once.
 */
export function runKernelNdjson(
  requests: Array<{ id: number; method: string; params: unknown }>,
  stateDir: string,
  binary: string = rustKernelPath,
): KernelRun {
  const input = requests.map((request) => JSON.stringify(request) + "\n").join("");
  const proc = spawnSync(binary, ["--state-dir", stateDir], {
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const replies = (proc.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as KernelReply);
  return { status: proc.status, signal: proc.signal, replies, stderr: proc.stderr ?? "" };
}

/** One reply's result, or a thrown error naming the request that failed. */
export function replyResult<T>(replies: KernelReply[], id: number): T {
  const reply = replies.find((candidate) => candidate.id === id);
  if (!reply) throw new Error(`no reply for request ${id} (got ${replies.length} replies)`);
  if (reply.error) throw new Error(`kernel error for request ${id}: ${reply.error.message ?? "unknown"}`);
  return reply.result as T;
}
