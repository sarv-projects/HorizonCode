/**
 * output-budget.ts — NF-074 context-cost contracts (v0.1 slice).
 *
 * Three contracts live here, all with one source of constants:
 *  - (a) usage-anchored output fit: the request's maxTokens is fitted to what
 *    is left of the model's window, estimated from the provider's newest
 *    usage anchor plus a locally counted tail, with a fixed framing charge
 *    and an absolute headway margin.
 *  - (b) the R-tools-42 model-facing cap (≤ 16 KiB and ≤ 4,000 tokens per
 *    tool result) with an explicit truncation marker. Over-cap output spills
 *    to `<workspace>/.hz/state/spills/<sha256>.txt` (canonical) or
 *    `<workspace>/.hzcode/spills/<sha256>.txt` (legacy, in place) — the reduced
 *    v0.1 stand-in for the `hz://artifact/...` pointer (no artifact store exists
 *    yet); the caller resolves the directory (paths.ts). When `spillDir` is
 *    given, `planToolOutputCap` materialises the spill through
 *    `writeSpillFile`: the directory is created 0700 and the file written
 *    0600 (Unix, umask-proof; docs/03 D12), and an already-loose file is
 *    tightened. The shipped loop writes only when the file is absent, so the
 *    bytes land once, owner-only.
 *  - Truncation is lossless-resumable in shape: `nextOffset` names the byte
 *    offset of the kept prefix, so the following slice can start there.
 *
 * The token numbers are LOCAL ESTIMATES (bytes / 4) — honest for fitting,
 * never used as accounting. Real usage comes from provider reports.
 */

import * as path from "node:path";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { displayBlobBodyPath, putBlobForWorkspace } from "./blobs";
import { sha256Hex } from "./canon";
import type { ChatMsg } from "../contracts";

export const BYTES_PER_TOKEN_ESTIMATE = 4;
/** Per-message framing charge (NF-074(a): 16 tokens, a constant, not a guess). */
export const FRAMING_CHARGE_TOKENS = 16;
/** R-tools-42 model-facing caps. */
export const MAX_RESULT_BYTES = 16 * 1024;
export const MAX_RESULT_TOKENS = 4_000;
/** R-tools-42: the full untruncated stream cap; above this the call fails. */
export const MAX_TOOL_STREAM_BYTES = 64 * 1024 * 1024;
/** NF-074(a): absolute headway margin kept between input and the window edge. */
export const HEADWAY_TOKENS = 4_096;
export const MIN_OUTPUT_TOKENS = 256;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
export const DEFAULT_WINDOW_TOKENS = 128 * 1024;

/** Local token estimate: UTF-8 bytes / 4. Fitting only, never accounting. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(typeof text === "string" ? text : "", "utf8") / BYTES_PER_TOKEN_ESTIMATE);
}

/** Windows for the models we ship; unknown models take the conservative default. */
export function windowForModel(model: string): number {
  const m = (typeof model === "string" ? model : "").toLowerCase();
  if (m.includes("claude")) return 200 * 1024;
  if (m.includes("gpt-4o") || m.includes("gpt-4-turbo") || m.includes("gpt-4.1")) return 128 * 1024;
  return DEFAULT_WINDOW_TOKENS;
}

/** Whole-prompt local estimate, including framing charges and tool schemas. */
export function estimatePromptTokens(system: string, messages: ChatMsg[], toolsJson = ""): number {
  let total = estimateTokens(system);
  if (toolsJson !== "") total += estimateTokens(toolsJson);
  for (const message of Array.isArray(messages) ? messages : []) {
    total += FRAMING_CHARGE_TOKENS + estimateTokens(message.content ?? "");
    for (const call of message.toolCalls ?? []) total += estimateTokens(call.arguments ?? "");
  }
  return total;
}

/**
 * NF-074(a): fit the output cap to the remaining window. `inputEstimate` is
 * the anchor (the previous turn's reported input + output tokens) plus the
 * tail counted locally since — or the whole-prompt estimate when no provider
 * usage has been seen yet. Never returns more than the default output cap and
 * never less than the floor; the headway margin is absolute.
 */
export function fitMaxOutputTokens(inputEstimate: number, windowTokens: number = DEFAULT_WINDOW_TOKENS): number {
  const used = Number.isFinite(inputEstimate) ? Math.max(0, Math.floor(inputEstimate)) : 0;
  const window = Number.isFinite(windowTokens) ? Math.floor(windowTokens) : DEFAULT_WINDOW_TOKENS;
  const room = window - used - HEADWAY_TOKENS;
  if (room < MIN_OUTPUT_TOKENS) return MIN_OUTPUT_TOKENS;
  return Math.min(DEFAULT_MAX_OUTPUT_TOKENS, room);
}

export interface ToolOutputCapOptions {
  maxBytes?: number;
  maxTokens?: number;
  /** Absolute directory that receives spilled full outputs; absent = no spill. */
  spillDir?: string;
  /** Path text shown in the marker (e.g. `.hz/state/spills`). Defaults to spillDir. */
  displaySpillDir?: string;
  /**
   * When set, over-cap output is stored in the blob CAS under this workspace
   * (docs/12 §4.1) instead of `spills/<hash>.txt`. Shipped when `HZ_BLOB_SPILL=1`.
   */
  blobCasWorkspace?: string;
  /** Overridable only for tests; production uses the R-tools-42 constant. */
  maxStreamBytes?: number;
}

export interface ToolOutputTruncation {
  reason: "bytes" | "tokens";
  omittedBytes: number;
  omittedLines: number;
  /** Byte offset of the end of the kept prefix: where the next slice starts. */
  nextOffset: number;
  spillPath?: string;
}

export interface ToolOutputPlan {
  text: string;
  truncated?: ToolOutputTruncation;
  spill?: { file: string; contents: string };
}

const isUnix = process.platform !== "win32";

/**
 * Post-create chmod so the mode is exact regardless of umask. Best-effort: a
 * target that vanished between the write and the chmod is not an error, and on
 * non-Unix the call is a no-op (POSIX modes do not exist there).
 */
function setOwnerOnly(target: string, mode: number): void {
  if (!isUnix) return;
  try {
    chmodSync(target, mode);
  } catch {
    /* best effort */
  }
}

/**
 * Materialise one planned spill, owner-only (docs/03 D12): the directory is
 * chmod 0700 and the file 0600 after the create, umask-proof, and an existing
 * loose-mode file is tightened. Never throws — spilling is best-effort by
 * contract, and a caller that cannot spill still serves the capped text. The
 * write is create-exclusive (`wx`): an existing spill under the same sha256
 * name already holds exactly these bytes.
 */
export function writeSpillFile(spill: { file: string; contents: string }): void {
  const dir = path.dirname(spill.file);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* the caller's own write may still succeed */
  }
  setOwnerOnly(dir, 0o700);
  try {
    writeFileSync(spill.file, spill.contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    /* exists already, or the caller's own persist attempt will report it */
  }
  // Always applied: covers the file just created and tightens a pre-existing
  // loose one the caller is about to reuse.
  setOwnerOnly(spill.file, 0o600);
}

/**
 * NF-074(b): cap a tool result for the model. Under the cap, the text is
 * returned untouched (byte-identical). Over it, a line-aware prefix is kept
 * (≤ maxBytes AND ≤ maxTokens on the byte/4 estimate) and the full text is
 * offered for spill; the marker carries what R-tools-43 requires in spirit.
 * When `spillDir` is set, the offered spill is materialised too, owner-only
 * (see `writeSpillFile`).
 */
/** Model/tool arg for lossless-resumable output continuation (docs/30 §8 #15). */
export const TOOL_OUTPUT_OFFSET_ARG = "outputOffset";

export function parseToolOutputContinuationOffset(args: Record<string, unknown>): number | undefined {
  const v = args[TOOL_OUTPUT_OFFSET_ARG];
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  return undefined;
}

/** Strip continuation args before a tool or MCP server sees the payload. */
export function stripToolOutputContinuationArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (!(TOOL_OUTPUT_OFFSET_ARG in args)) return args;
  const next = { ...args };
  delete next[TOOL_OUTPUT_OFFSET_ARG];
  return next;
}

/**
 * Continue a truncated tool result from a prior `nextOffset` (CBM / docs/30 §8 #15 reduced).
 */
export function planToolOutputFromOffset(
  output: string,
  startOffset: number,
  opts: ToolOutputCapOptions = {},
): ToolOutputPlan {
  const text = typeof output === "string" ? output : "";
  const off = Math.max(0, Math.floor(startOffset));
  if (off === 0) return planToolOutputCap(text, opts);
  const slice = Buffer.from(text, "utf8").subarray(off).toString("utf8");
  const plan = planToolOutputCap(slice, opts);
  const base = plan.truncated;
  if (base !== undefined) {
    plan.truncated = { ...base, nextOffset: off + base.nextOffset };
  }
  return plan;
}

export function planToolOutputCap(output: string, opts: ToolOutputCapOptions = {}): ToolOutputPlan {
  const text = typeof output === "string" ? output : "";
  const maxBytes = opts.maxBytes ?? MAX_RESULT_BYTES;
  const maxTokens = opts.maxTokens ?? MAX_RESULT_TOKENS;
  const maxStream = opts.maxStreamBytes ?? MAX_TOOL_STREAM_BYTES;
  const bytes = Buffer.byteLength(text, "utf8");
  const tokens = estimateTokens(text);

  // The stream cap is a safety bound, not a cap: a tool whose capture itself
  // exceeds it fails the call (refusing to spill a stream that was already
  // clipped upstream). It is checked before the under-cap fast path so a
  // caller-supplied limit always applies.
  if (bytes > maxStream) {
    const note = `[output too large: ${bytes} bytes exceeds the ${maxStream} byte per-call limit; not spilled]`;
    return {
      text: note,
      truncated: { reason: "bytes", omittedBytes: bytes, omittedLines: text.split("\n").length, nextOffset: 0 },
    };
  }

  if (bytes <= maxBytes && tokens <= maxTokens) return { text };

  const tokenBinding = maxTokens * BYTES_PER_TOKEN_ESTIMATE < maxBytes;
  const byteBudget = Math.max(1, Math.min(maxBytes, maxTokens * BYTES_PER_TOKEN_ESTIMATE));
  const reason: "bytes" | "tokens" = tokenBinding && tokens > maxTokens ? "tokens" : "bytes";

  let kept = text;
  if (bytes > byteBudget) {
    const sliced = Buffer.from(text, "utf8").subarray(0, byteBudget).toString("utf8");
    const candidate = sliced.endsWith("\uFFFD") ? sliced.slice(0, -1) : sliced;
    const lastNewline = candidate.lastIndexOf("\n");
    kept = lastNewline > candidate.length / 2 ? candidate.slice(0, lastNewline + 1) : candidate;
  }
  const keptBytes = Buffer.byteLength(kept, "utf8");
  const omittedBytes = Math.max(0, bytes - keptBytes);
  const omittedLines = Math.max(0, text.split("\n").length - (kept === "" ? 0 : kept.split("\n").length));
  const nextOffset = keptBytes;

  let spillPath: string | undefined;
  let spill: { file: string; contents: string } | undefined;
  if (opts.blobCasWorkspace !== undefined && opts.blobCasWorkspace !== "") {
    const { hash } = putBlobForWorkspace(opts.blobCasWorkspace, text);
    spillPath = displayBlobBodyPath(opts.blobCasWorkspace, hash);
  } else if (opts.spillDir !== undefined && opts.spillDir !== "") {
    const hash = sha256Hex(text);
    const display = opts.displaySpillDir !== undefined && opts.displaySpillDir !== "" ? opts.displaySpillDir : opts.spillDir;
    spillPath = path.join(display, `${hash}.txt`);
    spill = { file: path.join(opts.spillDir, `${hash}.txt`), contents: text };
    // Persist it now, owner-only. The shipped loop writes a spill only when the
    // file is absent, so the full output lands exactly once, under a 0700
    // directory, at 0600.
    writeSpillFile(spill);
  }

  const parts = [
    `[truncated: ${bytes} \u2192 ${keptBytes} bytes (${maxTokens}-token model budget)`,
    spillPath !== undefined ? `full output: ${spillPath}` : "full output not spilled",
    `omitted ${omittedBytes} bytes / ${omittedLines} lines`,
    `nextOffset: ${nextOffset}`,
  ];
  const marker = parts.join("; ") + (spillPath !== undefined ? "; read the spill or narrow the command]" : "]");
  const prefix = kept === "" || kept.endsWith("\n") ? kept : `${kept}\n`;
  return { text: `${prefix}${marker}`, truncated: { reason, omittedBytes, omittedLines, nextOffset, spillPath }, spill };
}
