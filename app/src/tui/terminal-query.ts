/**
 * terminal-query.ts — terminal probe reply recognition
 * (grok terminal/probe.rs ADAPT). Pure: classify a reply sequence (DA1 /
 * XTVERSION / OSC-4 RGB truecolor) vs keystrokes, detect in-flight reply
 * prefixes so a late reply isn't delivered as input, and split a terminated
 * reply from what follows. No raw-fd IO, no escape writing — the caller owns
 * the query write and the read loop.
 */

export type TermReplyKind = "da1" | "xtversion" | "truecolor" | "decrpm" | "keystroke" | "partial";

/** DECRQM probe for DEC Mode 2026 (Synchronized Output). */
export const DECRQM_SYNC_OUTPUT = "\x1b[?2026$p";

export interface TermReplyClassification {
  kind: TermReplyKind;
  /** True when more bytes are needed to decide (in-flight reply). */
  incomplete: boolean;
}

const RE = {
  da1: /^\x1b\[\?[\d;]+c/,
  decrpm: /^\x1b\[\?(\d+);([0-4])\$y/,
  xtversion: /^\x1bP>\|[\s\S]*?\x1b\\/,
  truecolor: /^\x1b\]4;[\d;]+;rgb:[\da-fA-F/]+\x1b\\/,
};

/**
 * Parse a DECRPM response for DEC Mode 2026 (`CSI ? 2026 ; Pm $ y`).
 * Pm=1 (set) or Pm=2 (reset) indicate the terminal recognizes Mode 2026.
 * Returns `undefined` if `seq` is not a Mode 2026 DECRPM reply.
 */
export function parseSyncOutputDecrpm(seq: string): boolean | undefined {
  const m = RE.decrpm.exec(seq);
  if (!m || m[1] !== "2026") return undefined;
  return m[2] === "1" || m[2] === "2";
}

export function classifyTermReply(seq: string): TermReplyClassification {
  if (RE.da1.test(seq)) return { kind: "da1", incomplete: false };
  if (RE.decrpm.test(seq)) return { kind: "decrpm", incomplete: false };
  if (RE.xtversion.test(seq)) return { kind: "xtversion", incomplete: false };
  if (RE.truecolor.test(seq)) return { kind: "truecolor", incomplete: false };
  if (isReplyPrefix(seq)) return { kind: "partial", incomplete: true };
  return { kind: "keystroke", incomplete: false };
}

/** True when `seq` could be the start of a probe reply (ESC/CSI/OSC/DCS). */
export function isReplyPrefix(seq: string): boolean {
  if (seq === "") return false;
  if (seq === "\x1b") return true;
  if (!seq.startsWith("\x1b")) return false;
  return /^\x1b(?:\[\?|P>|\]4)/.test(seq);
}

/**
 * Split a complete terminated reply from trailing input. Returns the reply
 * slice and the remainder; if no terminator, the whole string is the reply
 * (caller holds it for the late-reply grace) and rest is empty.
 */
export function drainLateReply(input: string): { reply: string; rest: string } {
  const da1 = RE.da1.exec(input);
  if (da1) return { reply: da1[0], rest: input.slice(da1[0].length) };
  for (const re of [RE.decrpm, RE.xtversion, RE.truecolor]) {
    const m = re.exec(input);
    if (m) return { reply: m[0], rest: input.slice(m[0].length) };
  }
  return { reply: input, rest: "" };
}
