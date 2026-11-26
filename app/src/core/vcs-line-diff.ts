/**
 * vcs-line-diff.ts — pure LCS line diff + unified patch (VCS surface).
 *
 * Zero-dependency replacement for the upstream `similar` crate (grok
 * xai-hunk-tracker/src/diff.rs). No git subprocess, no filesystem I/O. LCS is
 * bounded: inputs over MAX_DIFF_LINES refuse rather than allocate O(n·m).
 */

export const MAX_DIFF_LINES = 10_000;

export type DiffOp =
  | { kind: "equal"; text: string }
  | { kind: "insert"; text: string }
  | { kind: "delete"; text: string };

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // trailing newline
  return lines;
}

/** LCS-based line diff. Equal/insert/delete ops reconstruct both sides. */
export function diffLines(before: string, after: string): DiffOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    throw new Error(`HZ_PRECONDITION_FAILED: diff exceeds ${MAX_DIFF_LINES} lines`);
  }
  // LCS table (n+1)×(m+1).
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "equal", text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "delete", text: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: "insert", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) { ops.push({ kind: "delete", text: a[i]! }); i += 1; }
  while (j < b.length) { ops.push({ kind: "insert", text: b[j]! }); j += 1; }
  return ops;
}

/** Render a unified diff with context lines (git-style `@@` header). */
export function unifiedPatch(
  oldPath: string,
  newPath: string,
  before: string,
  after: string,
  context = 3,
): string {
  const ops = diffLines(before, after);
  if (ops.every((o) => o.kind === "equal")) return "";
  const lines: string[] = [`--- a/${oldPath}`, `+++ b/${newPath}`];
  // Single-hunk patch over the full changed span with context (bounded by ops length).
  const first = Math.max(0, ops.findIndex((o) => o.kind !== "equal") - context);
  let lastChanged = 0;
  for (let k = ops.length - 1; k >= 0; k -= 1) {
    if (ops[k]!.kind !== "equal") { lastChanged = k; break; }
  }
  const last = Math.min(ops.length, lastChanged + context + 1);
  let oldLine = 1;
  let newLine = 1;
  for (let k = 0; k < first; k += 1) {
    if (ops[k]!.kind !== "insert") oldLine += 1;
    if (ops[k]!.kind !== "delete") newLine += 1;
  }
  let oldCount = 0;
  let newCount = 0;
  for (let k = first; k < last; k += 1) {
    if (ops[k]!.kind !== "insert") oldCount += 1;
    if (ops[k]!.kind !== "delete") newCount += 1;
  }
  lines.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
  for (let k = first; k < last; k += 1) {
    const op = ops[k]!;
    const prefix = op.kind === "insert" ? "+" : op.kind === "delete" ? "-" : " ";
    lines.push(`${prefix}${op.text}`);
  }
  return lines.join("\n") + "\n";
}
