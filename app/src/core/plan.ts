/**
 * plan.ts — plan mode's staged-change store and review diff.
 *
 * Plan mode's contract (docs/09 §4.6): while the session is in plan mode the
 * model's write/edit calls are staged instead of applied, the human reviews the
 * diffs, and only /apply writes them. This module is the store and the diff,
 * nothing else — the loop decides when to stage, the TUI decides when to show,
 * apply or discard.
 *
 * Scope, named honestly: the store is in-memory and session-scoped — a reduced
 * form the durable change journal (tools/change-journal.ts) has since left
 * behind. It survives every change inside the process, not a restart; a durable
 * plan artifact belongs in the kernel receipt chain and does not exist yet. The bound is
 * explicit (MAX_STAGED_CHANGES / MAX_STAGED_BYTES, oldest first) because a
 * staged change is a preview, not state, and eviction is reported back to the
 * caller so the loop can tell the human rather than dropping data silently.
 *
 * The diff is line-based with three lines of context and a hard line cap whose
 * cut is named ("... N more lines") — never a silent truncation. Identical text
 * is not a change: unifiedDiff returns "" and the caller prints nothing. The
 * diff is display evidence, not a patch format: a change that only adds or
 * removes the final newline is invisible to a line diff, and CRLF is read as
 * LF so the same edit on two checkouts compares equal.
 *
 * Residual, named: a staged change is a snapshot, not a lock. Nothing here
 * compares the staged `before` with the file at apply time — the caller that
 * writes on apply owns the stale-check (the change-journal's rule is the
 * precedent: a file that moved on since is not ours to overwrite).
 */

export interface StagedChange {
  /** Absolute resolved path (what apply would write). */
  resolved: string;
  /** Workspace-relative path, for messages and diff headers. */
  rel: string;
  /** Content before the change; null = the file did not exist. */
  before: string | null;
  /** Content the change would write. */
  after: string;
  tool: "write" | "edit";
}

/** What stageWrite did: whether it kept the change, and what it evicted. */
export interface StageReport {
  /** False when the change alone exceeds MAX_STAGED_BYTES and was refused. */
  staged: boolean;
  /** Staged changes dropped (oldest first) to make room for this one. */
  evicted: number;
}

/** Bounded so a long plan cannot grow without limit; oldest entries drop first. */
export const MAX_STAGED_CHANGES = 100;
/** Content bound per session (before + after bytes of every staged change). */
export const MAX_STAGED_BYTES = 1024 * 1024;

interface PlanRecord {
  changes: StagedChange[];
  bytes: number;
}

const PLANS = new Map<string, PlanRecord>();

function contentBytes(change: StagedChange): number {
  return Buffer.byteLength(change.before ?? "", "utf8") + Buffer.byteLength(change.after, "utf8");
}

function totalBytes(list: readonly StagedChange[]): number {
  let sum = 0;
  for (const change of list) sum += contentBytes(change);
  return sum;
}

/**
 * Stage one change for review. Oldest entries are evicted (and counted in the
 * report) when either bound would be exceeded; a change that cannot fit even
 * an empty plan is refused rather than clearing the plan for it.
 */
export function stageWrite(sessionId: string, change: StagedChange): StageReport {
  const entry: StagedChange = {
    resolved: String(change.resolved ?? ""),
    rel: String(change.rel ?? ""),
    before: change.before === null || change.before === undefined ? null : String(change.before),
    after: String(change.after ?? ""),
    tool: change.tool === "edit" ? "edit" : "write",
  };
  const incoming = contentBytes(entry);
  if (incoming > MAX_STAGED_BYTES) return { staged: false, evicted: 0 };

  const record: PlanRecord = PLANS.get(sessionId) ?? { changes: [], bytes: 0 };
  let evicted = 0;
  while (
    record.changes.length > 0 &&
    (record.changes.length + 1 > MAX_STAGED_CHANGES || record.bytes + incoming > MAX_STAGED_BYTES)
  ) {
    const dropped = record.changes.shift() as StagedChange;
    record.bytes -= contentBytes(dropped);
    evicted += 1;
  }
  record.changes.push(entry);
  record.bytes += incoming;
  PLANS.set(sessionId, record);
  return { staged: true, evicted };
}

/** The session's staged changes, oldest first (a copy: callers cannot mutate the store). */
export function stagedChanges(sessionId: string): readonly StagedChange[] {
  return [...(PLANS.get(sessionId)?.changes ?? [])];
}

/**
 * Drop staged changes: all of them, or only the named workspace-relative path.
 * Returns how many entries were removed (0 when there was nothing to drop).
 */
/** Replace staged `after` for one path (plan review / partial hunk apply). */
export function replaceStagedAfter(sessionId: string, rel: string, after: string): boolean {
  const record = PLANS.get(sessionId);
  if (record === undefined) return false;
  const idx = record.changes.findIndex((change) => change.rel === rel);
  if (idx < 0) return false;
  const prev = record.changes[idx] as StagedChange;
  record.bytes -= contentBytes(prev);
  const next: StagedChange = { ...prev, after: String(after) };
  record.changes[idx] = next;
  record.bytes += contentBytes(next);
  PLANS.set(sessionId, record);
  return true;
}

export function discardStaged(sessionId: string, rel?: string): number {
  const record = PLANS.get(sessionId);
  if (record === undefined) return 0;
  if (rel === undefined) {
    const removed = record.changes.length;
    PLANS.delete(sessionId);
    return removed;
  }
  const kept = record.changes.filter((change) => change.rel !== rel);
  const removed = record.changes.length - kept.length;
  if (kept.length === 0) PLANS.delete(sessionId);
  else PLANS.set(sessionId, { changes: kept, bytes: totalBytes(kept) });
  return removed;
}

/**
 * Hand the staged list over to the caller and clear the session's stage. Apply
 * uses this so the plan it wrote from cannot be applied twice by accident; a
 * second call returns an empty list.
 */
export function takeStaged(sessionId: string): StagedChange[] {
  const record = PLANS.get(sessionId);
  if (record === undefined) return [];
  PLANS.delete(sessionId);
  return record.changes;
}

/** How many changes the session has staged. */
export function planSize(sessionId: string): number {
  return PLANS.get(sessionId)?.changes.length ?? 0;
}

/* ------------------------------ the diff ------------------------------ */

type OpKind = "keep" | "del" | "ins";

interface Op {
  kind: OpKind;
  line: string;
}

interface DiffLine {
  prefix: " " | "-" | "+";
  text: string;
  /** Old-file line number of the last old line before this one (0-based count). */
  oldBefore: number;
  /** New-file line number of the last new line before this one (0-based count). */
  newBefore: number;
}

/** Lines of context a hunk shows on each side of a change. */
const CONTEXT = 3;

/**
 * How many Myers rounds/steps one diff may explore before falling back to the
 * coarse script. O((N+M)·D) with saved traces can be quadratic on very
 * different files; the fallback (delete the middle, insert the middle) is
 * still a valid diff, just not a minimal one.
 */
const MAX_DIFF_WORK = 1_000_000;

/** Split into lines the way a diff numbers them: separators, not content. */
function splitLines(text: string): string[] {
  const normalized = (typeof text === "string" ? text : "").replace(/\r\n?/g, "\n");
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Delete every old line, insert every new line: the bounded fallback script. */
function coarseOps(oldLines: readonly string[], newLines: readonly string[]): Op[] {
  const ops: Op[] = [];
  for (const line of oldLines) ops.push({ kind: "del", line });
  for (const line of newLines) ops.push({ kind: "ins", line });
  return ops;
}

/**
 * Myers' greedy O((N+M)·D) edit script, or null when the work budget is spent
 * (the caller falls back to coarseOps). Backtracking reads the V snapshots
 * saved before each round, so the script is minimal for the work it explored.
 */
function myersOps(a: readonly string[], b: readonly string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ kind: "ins" as const, line }));
  if (m === 0) return a.map((line) => ({ kind: "del" as const, line }));
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let work = 0;
  let found = -1;

  outer: for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      work += 1;
      if (work > MAX_DIFF_WORK) return null;
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
        work += 1;
        if (work > MAX_DIFF_WORK) return null;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return null;

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const snapshot = trace[d] as Int32Array;
    const k = x - y;
    const prevK = k === -d || (k !== d && snapshot[offset + k - 1] < snapshot[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = snapshot[offset + prevK] as number;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "keep", line: a[x - 1] as string });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push({ kind: "ins", line: b[prevY] as string });
    } else {
      ops.push({ kind: "del", line: a[prevX] as string });
    }
    x = prevX;
    y = prevY;
  }
  // d = 0: the leading diagonal snake (common prefix), if the trace left one.
  while (x > 0 && y > 0) {
    ops.push({ kind: "keep", line: a[x - 1] as string });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    ops.push({ kind: "del", line: a[x - 1] as string });
    x -= 1;
  }
  while (y > 0) {
    ops.push({ kind: "ins", line: b[y - 1] as string });
    y -= 1;
  }
  ops.reverse();
  return ops;
}

/** Turn the op script into prefixed lines with absolute line counters. */
function buildLines(ops: readonly Op[]): DiffLine[] {
  const out: DiffLine[] = [];
  let oldBefore = 0;
  let newBefore = 0;
  for (const op of ops) {
    if (op.kind === "keep") {
      out.push({ prefix: " ", text: op.line, oldBefore: oldBefore++, newBefore: newBefore++ });
    } else if (op.kind === "del") {
      out.push({ prefix: "-", text: op.line, oldBefore: oldBefore++, newBefore });
    } else {
      out.push({ prefix: "+", text: op.line, oldBefore, newBefore: newBefore++ });
    }
  }
  return out;
}

function isChange(line: DiffLine): boolean {
  return line.prefix === "+" || line.prefix === "-";
}

interface Hunk {
  start: number;
  end: number;
}

/** Group changed lines into hunks with at most 2×CONTEXT kept lines between them. */
function hunksOf(lines: readonly DiffLine[]): Hunk[] {
  const hunks: Hunk[] = [];
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isChange(lines[i] as DiffLine)) continue;
    if (first === -1) {
      first = i;
    } else if (i - last > 2 * CONTEXT + 1) {
      hunks.push({ start: Math.max(0, first - CONTEXT), end: Math.min(lines.length, last + CONTEXT + 1) });
      first = i;
    }
    last = i;
  }
  if (first !== -1) hunks.push({ start: Math.max(0, first - CONTEXT), end: Math.min(lines.length, last + CONTEXT + 1) });
  return hunks;
}

/** The unified-diff text for one hunk: the `@@` header plus its lines. */
function renderHunk(lines: readonly DiffLine[], hunk: Hunk): string[] {
  const body = lines.slice(hunk.start, hunk.end);
  const firstOld = body.find((line) => line.prefix !== "+") as DiffLine | undefined;
  const firstNew = body.find((line) => line.prefix !== "-") as DiffLine | undefined;
  const oldCount = body.filter((line) => line.prefix !== "+").length;
  const newCount = body.filter((line) => line.prefix !== "-").length;
  const oldStart = oldCount > 0 ? (firstOld as DiffLine).oldBefore + 1 : (body[0] as DiffLine).oldBefore;
  const newStart = newCount > 0 ? (firstNew as DiffLine).newBefore + 1 : (body[0] as DiffLine).newBefore;
  const out = [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`];
  for (const line of body) out.push(line.prefix + line.text);
  return out;
}

function diffLabels(before: string | null, rel: string): [string, string] {
  const label = (typeof rel === "string" ? rel : "").replace(/[\r\n]+/g, " ") || "(change)";
  return [before === null ? "/dev/null" : label, label];
}

/**
 * A line-based unified diff of `before` (null = the file did not exist) to
 * `after`, with three lines of context per hunk. Empty string when the text is
 * unchanged (or differs only in line-ending style). `maxLines` is a hard cap on
 * the lines of the returned string: when the full diff is longer, the last line
 * is `... N more lines` and N is how many full-diff lines were dropped. Byte
 * stable: no timestamps, no randomness — the same inputs always produce the
 * same string.
 */
export function unifiedDiff(before: string | null, after: string, rel: string, maxLines = 200): string {
  if (!Number.isFinite(maxLines) || maxLines <= 0) return "";
  const oldLines = splitLines(before ?? "");
  const newLines = splitLines(after);

  // Trim the common prefix and suffix first: Myers then only walks the edited
  // middle, which is what makes an average one-line edit cheap on a big file.
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  const middleOld = oldLines.slice(start, endOld);
  const middleNew = newLines.slice(start, endNew);
  if (middleOld.length === 0 && middleNew.length === 0) return "";

  const middle = myersOps(middleOld, middleNew) ?? coarseOps(middleOld, middleNew);
  const ops: Op[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ kind: "keep", line: oldLines[i] as string });
  ops.push(...middle);
  for (let i = endOld; i < oldLines.length; i += 1) ops.push({ kind: "keep", line: oldLines[i] as string });

  const lines = buildLines(ops);
  const hunks = hunksOf(lines);
  if (hunks.length === 0) return "";

  const [beforeLabel, afterLabel] = diffLabels(before, rel);
  const out: string[] = [`--- ${beforeLabel}`, `+++ ${afterLabel}`];
  for (const hunk of hunks) out.push(...renderHunk(lines, hunk));

  const cap = Math.floor(maxLines);
  if (out.length > cap) {
    // The marker is a line of the capped output: never exceed maxLines, and
    // never drop a line without saying how many were dropped.
    const kept = Math.max(0, cap - 1);
    const dropped = out.length - kept;
    return out.slice(0, kept).join("\n") + (kept > 0 ? "\n" : "") + `... ${dropped} more lines\n`;
  }
  return out.join("\n") + "\n";
}

/** Number of hunks in a staged change (0 when unchanged). */
export function countChangeHunks(before: string | null, after: string, rel: string): number {
  const diff = unifiedDiff(before, after, rel, 10_000);
  if (diff === "") return 0;
  return diff.split("\n").filter((line) => line.startsWith("@@")).length;
}

/** Prefix each `@@` header with `[hunk N]` (optional ` · rel`) for /changes (docs/13 D7). */
export function labelDiffHunkHeaders(diff: string, rel?: string): string {
  const fileBit =
    typeof rel === "string" && rel !== "" ? ` · ${rel.replace(/[\r\n]+/g, " ").trim()}` : "";
  let n = 0;
  return diff
    .split("\n")
    .map((line) => (line.startsWith("@@") ? `[hunk ${++n}${fileBit}] ${line}` : line))
    .join("\n");
}

export interface HunkApplyFilePick {
  rel: string;
  hunks: number[];
}

export interface HunkApplySelection {
  /** `path:1,2` form — one or more staged paths. */
  files?: HunkApplyFilePick[];
  /** Bare `1,3` — only when exactly one file is staged. */
  hunks?: number[];
}

function parseHunkNumbers(text: string): number[] | undefined {
  const t = text.trim();
  if (t === "" || !/^[\d,\s]+$/.test(t)) return undefined;
  const nums = t
    .split(/[,\s]+/)
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n > 0);
  return nums.length > 0 ? nums : undefined;
}

/** Parse `/apply` hunk arg: empty => null (apply all staged); invalid => undefined. */
export function parseHunkApplySelection(arg: string): HunkApplySelection | null | undefined {
  const text = arg.trim();
  if (text === "") return null;
  if (text.includes(":")) {
    const files: HunkApplyFilePick[] = [];
    for (const token of text.split(/\s+/)) {
      if (token.trim() === "") continue;
      const colon = token.lastIndexOf(":");
      if (colon <= 0) return undefined;
      const rel = token.slice(0, colon).trim();
      const hunks = parseHunkNumbers(token.slice(colon + 1));
      if (rel === "" || hunks === undefined) return undefined;
      files.push({ rel, hunks });
    }
    return files.length > 0 ? { files } : undefined;
  }
  const hunks = parseHunkNumbers(text);
  if (hunks === undefined) return undefined;
  return { hunks };
}

/** Rewrite staged `after` for selected hunks (multi-file or single-file). */
export function applyHunkSelections(
  sessionId: string,
  staged: readonly StagedChange[],
  selection: HunkApplySelection,
): { ok: true; updated: readonly string[] } | { ok: false; message: string } {
  if (selection.hunks !== undefined) {
    if (staged.length !== 1) {
      return {
        ok: false,
        message:
          "partial hunk apply with bare indices needs one staged file; use path:1,2 per file or bare /apply for every staged change",
      };
    }
    const change = staged[0] as StagedChange;
    const patched = partialAfterFromHunks(change.before, change.after, selection.hunks);
    if (!replaceStagedAfter(sessionId, change.rel, patched)) {
      return { ok: false, message: "could not update staged content for hunk apply" };
    }
    return { ok: true, updated: [change.rel] };
  }
  const picks = selection.files ?? [];
  const updated: string[] = [];
  for (const pick of picks) {
    const change = staged.find((c) => c.rel === pick.rel);
    if (change === undefined) {
      return { ok: false, message: `no staged change for ${pick.rel}` };
    }
    const patched = partialAfterFromHunks(change.before, change.after, pick.hunks);
    if (!replaceStagedAfter(sessionId, pick.rel, patched)) {
      return { ok: false, message: `could not update staged content for ${pick.rel}` };
    }
    updated.push(pick.rel);
  }
  return { ok: true, updated };
}

function diffLinesForChange(before: string | null, after: string): DiffLine[] {
  const oldLines = splitLines(before ?? "");
  const newLines = splitLines(after);
  if (oldLines.join("\n") === newLines.join("\n")) return [];
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  const middleOld = oldLines.slice(start, endOld);
  const middleNew = newLines.slice(start, endNew);
  if (middleOld.length === 0 && middleNew.length === 0) return [];
  const middle = myersOps(middleOld, middleNew) ?? coarseOps(middleOld, middleNew);
  const ops: Op[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ kind: "keep", line: oldLines[i] as string });
  ops.push(...middle);
  for (let i = endOld; i < oldLines.length; i += 1) ops.push({ kind: "keep", line: oldLines[i] as string });
  return buildLines(ops);
}

/** 1-based hunk indices; empty => unchanged `before`; all hunks => `after`. */
export function partialAfterFromHunks(before: string | null, after: string, pick1Based: readonly number[]): string {
  const selected = new Set(pick1Based.filter((n) => Number.isInteger(n) && n > 0));
  if (selected.size === 0) return before ?? "";
  const lines = diffLinesForChange(before, after);
  if (lines.length === 0) return after;
  const hunks = hunksOf(lines);
  if (selected.size >= hunks.length) return after;
  const out: string[] = [];
  let hunkNum = 0;
  let pos = 0;
  for (const hunk of hunks) {
    hunkNum += 1;
    while (pos < hunk.start) {
      const line = lines[pos] as DiffLine;
      if (line.prefix === " ") out.push(line.text);
      pos += 1;
    }
    const apply = selected.has(hunkNum);
    while (pos < hunk.end) {
      const line = lines[pos] as DiffLine;
      if (line.prefix === " ") out.push(line.text);
      else if (apply) {
        if (line.prefix === "+") out.push(line.text);
      } else if (line.prefix === "-") {
        out.push(line.text);
      }
      pos += 1;
    }
  }
  while (pos < lines.length) {
    const line = lines[pos] as DiffLine;
    if (line.prefix === " ") out.push(line.text);
    pos += 1;
  }
  const body = out.join("\n");
  if (after.endsWith("\n") && !body.endsWith("\n")) return `${body}\n`;
  return body;
}
