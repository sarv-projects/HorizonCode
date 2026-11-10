/**
 * diff.ts : the rich diff view: a line-number gutter and coloured +/- rows.
 *
 * Pure: unified-diff text in, display lines out. Used only in rich (TTY) mode;
 * the plain `diffBlock` in render.ts stays byte-identical for pipes and tests.
 *
 *   ▎ src/app.ts
 *     ⋯ lines 40-52
 *     40 │  const a = 1;
 *     41 │- const b = 2;
 *     41 │+ const b = 3;
 *     ⋯ 14 unchanged lines
 *   … 12 more lines
 */

import { bold, colorLevel, dim, onBg, paint, sanitizeText, truncate, type ColorLevel } from "./style";

/** Most diff rows shown before the `N more lines` footer. */
export const RICH_DIFF_LINE_CAP = 40;
/** A run of unchanged context longer than this folds to `⋯ N unchanged lines`. */
const CONTEXT_FOLD = 6;

export interface RichDiffOptions {
  width?: number;
  cap?: number;
  level?: ColorLevel;
  unicode?: boolean;
}

interface Row {
  kind: "file" | "hunk" | "add" | "del" | "ctx" | "fold";
  text: string;
  num?: number;
}

function parse(diff: string): Row[] {
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  let minusFile = "";
  let sawPlus = false;
  const lines = sanitizeText(diff.replace(/\r\n?/g, "\n")).split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("\\ ")) continue;
    if (line.startsWith("--- ")) {
      minusFile = line.slice(4).replace(/^a\//, "");
      sawPlus = false;
      continue;
    }
    if (line.startsWith("+++ ") && !sawPlus) {
      sawPlus = true;
      const plus = line.slice(4).replace(/^b\//, "");
      rows.push({ kind: "file", text: plus === "/dev/null" ? minusFile : plus });
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      const count = Number(hunk[4] ?? 1);
      rows.push({ kind: "hunk", text: count > 1 ? `lines ${newNo}-${newNo + count - 1}` : `line ${newNo}` });
      continue;
    }
    if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1), num: newNo++ });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1), num: oldNo++ });
    else if (line.startsWith(" ") || line === "") {
      rows.push({ kind: "ctx", text: line.slice(1), num: newNo });
      oldNo++;
      newNo++;
    } else rows.push({ kind: "ctx", text: line });
  }
  // Fold long unchanged runs.
  const out: Row[] = [];
  for (let i = 0; i < rows.length; ) {
    if (rows[i]!.kind !== "ctx") {
      out.push(rows[i++]!);
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j]!.kind === "ctx") j++;
    const run = rows.slice(i, j);
    if (run.length > CONTEXT_FOLD) {
      out.push(run[0]!, run[1]!, { kind: "fold", text: `${run.length - 4} unchanged lines` }, run[run.length - 2]!, run[run.length - 1]!);
    } else out.push(...run);
    i = j;
  }
  return out;
}

/** Rendered rows (without the cap footer) for tests and callers that page themselves. */
export function richDiffLines(diff: string, opts: RichDiffOptions = {}): string[] {
  if (typeof diff !== "string" || diff.trim() === "") return [];
  const level = opts.level ?? colorLevel();
  const width = Math.max(24, Math.floor(opts.width ?? 80));
  const u = opts.unicode !== false;
  const rows = parse(diff);
  const maxNo = rows.reduce((m, r) => Math.max(m, r.num ?? 0), 0);
  const numW = Math.max(3, String(maxNo).length);
  const bar = u ? "\u2502" : "|";
  const textW = Math.max(8, width - 2 - numW - 3);
  const out: string[] = [];
  for (const row of rows) {
    if (row.kind === "file") {
      out.push("  " + paint("accent", u ? "\u258e " : "| ", level) + bold(truncate(row.text, width - 4)));
      continue;
    }
    if (row.kind === "hunk") {
      out.push("  " + dim(`${" ".repeat(numW)} ${u ? "\u22ef" : "..."} ${row.text}`));
      continue;
    }
    if (row.kind === "fold") {
      out.push("  " + dim(`${" ".repeat(numW)} ${u ? "\u22ef" : "..."} ${row.text}`));
      continue;
    }
    const num = row.num === undefined ? " ".repeat(numW) : String(row.num).padStart(numW);
    const gutter = dim(`${num} ${bar}`);
    const body = truncate(row.text, textW);
    if (row.kind === "add") {
      const sign = paint("ok", "+", level);
      const line = gutter + sign + " " + paint("ok", body, level);
      out.push("  " + (level >= 2 ? onBg("bgAdd", line, width - 2, level) : line));
    } else if (row.kind === "del") {
      const sign = paint("err", "-", level);
      const line = gutter + sign + " " + paint("err", body, level);
      out.push("  " + (level >= 2 ? onBg("bgDel", line, width - 2, level) : line));
    } else {
      out.push("  " + gutter + "  " + body);
    }
  }
  return out;
}

/** The capped view: at most `cap` rows then a dim `… N more lines` footer. */
export function richDiff(diff: string, opts: RichDiffOptions = {}): string[] {
  const all = richDiffLines(diff, opts);
  const cap = opts.cap ?? RICH_DIFF_LINE_CAP;
  if (all.length <= cap) return all;
  const u = opts.unicode !== false;
  return [...all.slice(0, cap), "  " + dim(`${u ? "\u2026" : "..."} ${all.length - cap} more lines`)];
}
