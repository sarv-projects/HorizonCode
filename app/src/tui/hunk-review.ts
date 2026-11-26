/**
 * hunk-review.ts -- per-hunk review model for Plan Mode (docs/28 §14).
 *
 * Pure data layer: parses a unified diff into indexed hunks, records
 * accept/reject/edit decisions and produces a selection string compatible with
 * the existing `/apply <path>:<hunks>` parser. Nothing here mutates files.
 */

export type HunkReviewDecision = "accept" | "reject" | "edit";

export interface HunkReviewItem {
  index: number;
  path: string;
  header: string;
  lines: string[];
  decision?: HunkReviewDecision;
}

/** Split a unified diff into 1-based hunks; file headers before the first @@ are ignored. */
export function parseDiffHunks(diff: string, rel: string): HunkReviewItem[] {
  const hunks: HunkReviewItem[] = [];
  let current: HunkReviewItem | undefined;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      current = { index: hunks.length + 1, path: rel, header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (current !== undefined) current.lines.push(line);
  }
  return hunks;
}

export interface HunkReviewOutcome {
  accepted: number[];
  rejected: number[];
  pending: number;
  /** Selection string for core/plan.ts parseHunkApplySelection; "" if nothing accepted. */
  selection: string;
}

/** Fold decisions into an apply selection. Edit/undecided hunks are never applied. */
export function applyHunkDecisions(hunks: readonly HunkReviewItem[]): HunkReviewOutcome {
  const accepted = new Map<string, number[]>();
  const rejected: number[] = [];
  let pending = 0;
  for (const hunk of hunks) {
    if (hunk.decision === "accept") {
      const list = accepted.get(hunk.path) ?? [];
      list.push(hunk.index);
      accepted.set(hunk.path, list);
    } else if (hunk.decision === "reject") {
      rejected.push(hunk.index);
    } else {
      pending += 1;
    }
  }
  const selection = [...accepted.entries()]
    .map(([path, indexes]) => `${path}:${indexes.join(",")}`)
    .join(" ");
  return {
    accepted: [...accepted.values()].flat(),
    rejected,
    pending,
    selection,
  };
}

/** Wrapping cursor movement; empty lists stay at 0. */
export function nextHunkCursor(
  hunks: readonly HunkReviewItem[],
  key: "up" | "down",
  current: number,
): number {
  if (hunks.length === 0) return 0;
  const delta = key === "down" ? 1 : -1;
  return (current + delta + hunks.length) % hunks.length;
}

const DECISION_MARK: Record<HunkReviewDecision, string> = {
  accept: "a",
  reject: "r",
  edit: "e",
};

/** Scrollback-safe rendering of the review modal block. */
export function renderHunkReview(hunks: readonly HunkReviewItem[], cursor: number): string {
  const lines: string[] = ["Per-hunk review: [a]ccept [r]eject [e]dit, arrows move, Enter applies accepted hunks"];
  for (const hunk of hunks) {
    const mark = hunk.decision === undefined ? "?" : DECISION_MARK[hunk.decision];
    const pointer = hunk.index - 1 === cursor ? "❯" : " ";
    lines.push(`${pointer} [${hunk.index}] ${mark} ${hunk.path} ${hunk.header}`);
    for (const line of hunk.lines.slice(0, 6)) lines.push(`    ${line}`);
  }
  if (hunks.length === 0) lines.push("(no hunks to review)");
  return lines.join("\n");
}
