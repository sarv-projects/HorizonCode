/**
 * fold-lines.ts — pure middle-fold helpers (docs/13 D9 reduced).
 */

export interface FoldMiddleOptions {
  first?: number;
  last?: number;
  ellipsis?: string;
}

/** Keep `first` + `last` lines; replace the middle with one marker line. */
export function foldMiddleLines(lines: readonly string[], opts: FoldMiddleOptions = {}): string[] {
  const first = Math.max(0, opts.first ?? 2);
  const last = Math.max(0, opts.last ?? 3);
  const ellipsis = opts.ellipsis ?? "...";
  if (lines.length <= first + last + 1) return [...lines];
  const hidden = lines.length - first - last;
  const marker = `${ellipsis} +${hidden} line${hidden === 1 ? "" : "s"}`;
  return [...lines.slice(0, first), marker, ...lines.slice(lines.length - last)];
}

/** True when `foldMiddleLines` would insert a marker. */
export function isFoldedMiddleMarker(line: string, ellipsis = "..."): boolean {
  return new RegExp(`^${ellipsis.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\+\\d+ lines?$`).test(line.trim());
}
