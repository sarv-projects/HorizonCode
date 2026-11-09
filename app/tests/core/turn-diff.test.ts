/**
 * turn-diff.test.ts -- the per-turn aggregated file diff (FEAT-003).
 *
 * The aggregator (src/core/turn-diff.ts) collapses the change-journal entries
 * recorded during one model turn into ONE unified diff: one net diff per file,
 * `before` from the earliest entry and `after` read from disk at turn end. These
 * tests drive it with real temp files for the on-disk `after`, and reset the
 * journal between cases so each turn starts from a clean boundary. They MUST
 * fail if the aggregation is reverted.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { computeTurnDiff } from "../../src/core/turn-diff";
import {
  __resetJournalForTests,
  liveEntries,
  recordChange,
  type ChangeEntry,
} from "../../src/tools/change-journal";
import { makeWorkspace } from "../tools/helpers";

/** A synthetic journal entry for a file inside `ws`. */
function entry(ws: string, rel: string, before: string | null, at: number): ChangeEntry {
  return {
    path: path.join(ws, rel),
    rel,
    before,
    afterSha256: `sha256:${rel}:${String(at)}`,
    at,
    tool: "write",
  };
}

/** Write `content` to `rel` inside `ws` (the net on-disk "after"). */
function putFile(ws: string, rel: string, content: string): void {
  writeFileSync(path.join(ws, rel), content);
}

describe("turn-diff aggregator", () => {
  test("(a) two different files edited in one turn -> ONE diff with both, files === 2", () => {
    const ws = makeWorkspace({ "a.txt": "a-old\n", "b.txt": "b-old\n" });
    __resetJournalForTests();
    // The net on-disk state at turn end.
    putFile(ws, "a.txt", "a-new\n");
    putFile(ws, "b.txt", "b-new\n");

    const entries = [entry(ws, "a.txt", "a-old\n", 1), entry(ws, "b.txt", "b-old\n", 2)];
    const out = computeTurnDiff(entries);

    expect(out.files).toBe(2);
    // One aggregate string carrying BOTH files' hunks.
    expect(out.diff).toContain("a.txt");
    expect(out.diff).toContain("b.txt");
    expect(out.diff).toContain("-a-old");
    expect(out.diff).toContain("+a-new");
    expect(out.diff).toContain("-b-old");
    expect(out.diff).toContain("+b-new");
    expect(out.truncated).toBe(false);
  });

  test("(b) two edits to the SAME file collapse to one net diff (earliest before -> final after)", () => {
    const ws = makeWorkspace({ "c.txt": "v0\n" });
    __resetJournalForTests();
    // Two edits in the turn: v0 -> v1 -> v2. Only the net v0 -> v2 should show.
    putFile(ws, "c.txt", "v2\n");

    const entries = [entry(ws, "c.txt", "v0\n", 1), entry(ws, "c.txt", "v1\n", 2)];
    const out = computeTurnDiff(entries);

    expect(out.files).toBe(1);
    // Earliest preimage (v0) against the final on-disk content (v2); the
    // intermediate v1 is NOT a line in the diff.
    expect(out.diff).toContain("-v0");
    expect(out.diff).toContain("+v2");
    expect(out.diff).not.toContain("v1");
  });

  test("(c) a turn with zero recorded changes yields files === 0 and empty diff", () => {
    __resetJournalForTests();
    const out = computeTurnDiff([]);
    expect(out.files).toBe(0);
    expect(out.diff).toBe("");
    expect(out.truncated).toBe(false);
  });

  test("(c') a recorded entry whose on-disk content is unchanged is not a file change", () => {
    const ws = makeWorkspace({ "d.txt": "same\n" });
    __resetJournalForTests();
    // The journal recorded an entry, but the net on-disk content equals before.
    putFile(ws, "d.txt", "same\n");
    const out = computeTurnDiff([entry(ws, "d.txt", "same\n", 1)]);
    expect(out.files).toBe(0);
    expect(out.diff).toBe("");
  });

  test("(d) the aggregate is a valid unified diff (--- / +++ / @@)", () => {
    const ws = makeWorkspace({ "e.txt": "one\n" });
    __resetJournalForTests();
    putFile(ws, "e.txt", "two\n");
    const out = computeTurnDiff([entry(ws, "e.txt", "one\n", 1)]);
    expect(out.diff).toContain("--- ");
    expect(out.diff).toContain("+++ ");
    expect(out.diff).toContain("@@");
  });

  test("a new file in the turn diffs from /dev/null", () => {
    const ws = makeWorkspace({});
    __resetJournalForTests();
    putFile(ws, "new.txt", "hello\n");
    const out = computeTurnDiff([entry(ws, "new.txt", null, 1)]);
    expect(out.files).toBe(1);
    expect(out.diff).toContain("--- /dev/null");
    expect(out.diff).toContain("+hello");
  });

  test("a nonRestorable preimage is noted, not crashed", () => {
    const ws = makeWorkspace({ "big.txt": "x\n" });
    __resetJournalForTests();
    putFile(ws, "big.txt", "y\n");
    const e = { ...entry(ws, "big.txt", null, 1), nonRestorable: true };
    const out = computeTurnDiff([e]);
    expect(out.files).toBe(1);
    expect(out.diff).toContain("not restorable");
    expect(out.diff).toContain("+y");
  });

  test("a file deleted after the edit yields a safe (empty-after) diff, no crash", () => {
    const ws = makeWorkspace({});
    __resetJournalForTests();
    // No file on disk: read fails, after is treated as empty -> removal diff.
    const out = computeTurnDiff([entry(ws, "gone.txt", "was-here\n", 1)]);
    expect(out.files).toBe(1);
    expect(out.diff).toContain("-was-here");
  });

  test("output is byte-stable: files appear in first-change order", () => {
    const ws = makeWorkspace({ "z.txt": "z0\n", "y.txt": "y0\n" });
    __resetJournalForTests();
    putFile(ws, "z.txt", "z1\n");
    putFile(ws, "y.txt", "y1\n");
    // z recorded before y -> z's hunk precedes y's hunk.
    const out = computeTurnDiff([entry(ws, "z.txt", "z0\n", 1), entry(ws, "y.txt", "y0\n", 2)]);
    expect(out.diff.indexOf("z.txt")).toBeLessThan(out.diff.indexOf("y.txt"));
    // Same inputs, same output.
    const again = computeTurnDiff([entry(ws, "z.txt", "z0\n", 1), entry(ws, "y.txt", "y0\n", 2)]);
    expect(again.diff).toBe(out.diff);
  });

  test("a huge aggregate is capped and reports truncated", () => {
    const ws = makeWorkspace({});
    __resetJournalForTests();
    const after = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n") + "\n";
    putFile(ws, "huge.txt", after);
    const out = computeTurnDiff([entry(ws, "huge.txt", null, 1)], 50);
    expect(out.truncated).toBe(true);
    expect(out.diff).toContain("more lines");
    expect(out.diff.split("\n").filter((l) => l !== "").length).toBeLessThanOrEqual(50);
  });

  test("via the journal: entries recorded this turn drive the aggregate (boundary diff)", () => {
    const ws = makeWorkspace({ "f.txt": "f0\n" });
    __resetJournalForTests();
    const sid = "turn-diff-session";
    // Boundary before the turn: nothing recorded yet for this session.
    const before = new Set(liveEntries(sid).map((e) => e.id));
    // The turn records a change; the net on-disk content is f1.
    recordChange(sid, entry(ws, "f.txt", "f0\n", 10));
    putFile(ws, "f.txt", "f1\n");
    const turnEntries = liveEntries(sid).filter((e) => !before.has(e.id));
    expect(turnEntries.length).toBe(1);
    const out = computeTurnDiff(turnEntries);
    expect(out.files).toBe(1);
    expect(out.diff).toContain("-f0");
    expect(out.diff).toContain("+f1");
  });
});
