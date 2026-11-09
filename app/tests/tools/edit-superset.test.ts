/**
 * edit-superset.test.ts — FEAT-002 (edit-engine superset).
 *
 * Covers the sharpened fuzzy ladder and miss feedback layered on top of the
 * NF-069 unique-match discipline:
 *   (a) the unicode-fold rung folds the codex code points and applies uniquely;
 *   (b) an ambiguous unicode-fold match is refused, never guessed;
 *   (c) ladder order is preserved: exact beats fold, fold beats the looser rungs;
 *   (d) miss feedback renders up to MAX_RECORDED_MATCHES=5 candidate previews
 *       bounded to OCCURRENCE_PREVIEW_CONTEXT=5 lines / OCCURRENCE_PREVIEW_MAX_LEN=80
 *       chars with the \u2026 ellipsis;
 *   (e) the already-applied branch (and any content-revealing preview) appears
 *       only when the session has read the file (wasRead gate).
 *
 * Each test is written to FAIL if the FEAT-002 code is reverted (the fold rung,
 * the EDIT_LADDER order, the preview bounds, or the read gate).
 */

import { describe, expect, test } from "bun:test";
import {
  EDIT_LADDER,
  MAX_RECORDED_MATCHES,
  OCCURRENCE_PREVIEW_CONTEXT,
  OCCURRENCE_PREVIEW_MAX_LEN,
  editTool,
} from "../../src/tools/edit";
import { readTool } from "../../src/tools/read";
import { makeWorkspace, mockToolContext, readFixture } from "./helpers";

/** A context whose session has already READ the fixture (the fuzzy-rung gate). */
async function ctxHavingRead(ws: string, opts: { rel?: string; sessionId?: string } = {}) {
  const ctx = mockToolContext(opts.sessionId === undefined ? { cwd: ws } : { cwd: ws, sessionId: opts.sessionId });
  const read = await readTool.execute({ path: opts.rel ?? "f.txt" }, ctx);
  if (!read.ok) throw new Error(`fixture read failed: ${read.error}`);
  return ctx;
}

describe("the unicode-fold rung (FEAT-002)", () => {
  test("the ladder names unicode-fold between indent-normalised and the looser rungs", () => {
    // Guards the EDIT_LADDER contract directly; fails if the rung is removed or re-ordered.
    expect(EDIT_LADDER).toEqual(["exact", "indent-normalised", "unicode-fold", "3-way merge", "line-patch"]);
  });

  test("(a) folds smart quotes / dashes / exotic spaces and applies uniquely", async () => {
    // The file uses a smart quote (\u2019), an em dash (\u2014) and a non-breaking
    // space (\u00A0); the old string uses their ASCII equivalents. No exact match
    // exists, so only the unicode-fold rung can locate this line.
    const file = "const label = \u2018done\u2019;\u00A0// step\u2014one\n";
    const ws = makeWorkspace({ "f.txt": file });
    const r = await editTool.execute(
      { path: "f.txt", old: "const label = 'done'; // step-one", new: "const label = 'pending';" },
      await ctxHavingRead(ws),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 1 occurrence(s) in f.txt (matched via unicode-fold)");
    expect(readFixture(ws, "f.txt")).toBe("const label = 'pending';\n");
  });

  test("(b) an ambiguous unicode-fold match is refused, not guessed", async () => {
    // Two lines fold to the same ASCII target (smart quotes), so the rung must
    // refuse with the candidate lines and leave the file untouched.
    const file = "a = \u201Chi\u201D;\nb = 1;\na = \u201Chi\u201D;\n";
    const ws = makeWorkspace({ "f.txt": file });
    const r = await editTool.execute(
      { path: "f.txt", old: 'a = "hi";', new: 'a = "bye";' },
      await ctxHavingRead(ws),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("near-match is ambiguous in f.txt after unicode-fold matching: 2 candidates");
    expect(r.error).toContain("lines 1-1, 3-3");
    expect(readFixture(ws, "f.txt")).toBe(file);
  });

  test("(c) exact beats fold: an exact match wins with no rung suffix", async () => {
    // An exact ASCII line is present; a different line only folds. Exact must win.
    const file = "x = 'a';\ny = \u2018b\u2019;\n";
    const ws = makeWorkspace({ "f.txt": file });
    const r = await editTool.execute(
      { path: "f.txt", old: "x = 'a';", new: "x = 'Z';" },
      mockToolContext({ cwd: ws }),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 1 occurrence(s) in f.txt"); // exact — no "(matched via ...)"
    expect(readFixture(ws, "f.txt")).toBe("x = 'Z';\ny = \u2018b\u2019;\n");
  });

  test("(c) fold beats looser rungs: a quote-only difference uses unicode-fold, not 3-way merge", async () => {
    // The line differs from the old string only by a smart quote; the fold rung
    // matches it before the trim-based merge rung is ever consulted.
    const file = "value: \u201Cready\u201D,\n";
    const ws = makeWorkspace({ "f.txt": file });
    const r = await editTool.execute(
      { path: "f.txt", old: 'value: "ready",', new: 'value: "set",' },
      await ctxHavingRead(ws),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 1 occurrence(s) in f.txt (matched via unicode-fold)");
    expect(readFixture(ws, "f.txt")).toBe('value: "set",\n');
  });
});

describe("miss feedback previews (FEAT-002)", () => {
  test("(d) renders at most 5 candidate previews, 5 lines each, truncated at 80 chars", async () => {
    // Build a file with MANY partially-similar windows plus one very long line.
    // Each "marker" line can match the MIDDLE line of the old block, giving >5
    // windows a non-zero overlap; the anchors (HEAD/TAIL) exist nowhere, so the
    // line-patch rung yields zero candidates and the ladder falls through to
    // locateFailed, which renders the previews.
    const longLine = "marker " + "z".repeat(200);
    const lines: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      lines.push("marker");
      lines.push(longLine);
    }
    const file = lines.join("\n") + "\n";
    const ws = makeWorkspace({ "f.txt": file });
    // old: HEAD / marker / TAIL — HEAD and TAIL appear nowhere, so no rung
    // matches; only the MIDDLE "marker" line overlaps, across many windows.
    const r = await editTool.execute(
      { path: "f.txt", old: "HEAD\nmarker\nTAIL", new: "x\ny\nz" },
      await ctxHavingRead(ws),
    );
    expect(r.ok).toBe(false);

    const header = `closest candidates (up to ${MAX_RECORDED_MATCHES}, ${OCCURRENCE_PREVIEW_CONTEXT} lines each):`;
    expect(r.error).toContain(header);

    // Count the rendered previews: each starts with "  lines N-M (" — capped at 5.
    const previewHeaders = (r.error ?? "").match(/\n {2}lines \d+-\d+ \(\d+% similar\):/g) ?? [];
    expect(previewHeaders.length).toBeGreaterThan(0);
    expect(previewHeaders.length).toBeLessThanOrEqual(MAX_RECORDED_MATCHES);

    // In the preview section the long line is truncated to exactly
    // OCCURRENCE_PREVIEW_MAX_LEN chars (4-space indent + 79 chars + ellipsis).
    const truncated = "    " + longLine.slice(0, OCCURRENCE_PREVIEW_MAX_LEN - 1) + "\u2026";
    expect(r.error).toContain(truncated);

    // Every preview body line (4-space indent) is bounded to 4 + 80 chars.
    const previewSection = (r.error ?? "").slice((r.error ?? "").indexOf(header));
    for (const bodyLine of previewSection.split("\n")) {
      if (bodyLine.startsWith("    ")) {
        expect(bodyLine.length).toBeLessThanOrEqual(4 + OCCURRENCE_PREVIEW_MAX_LEN);
      }
    }
  });
});

describe("read-gated already-applied branch (FEAT-002)", () => {
  const FILE = "status: shipped\n";

  test("(e) already-applied is reported when the session has read the file", async () => {
    const ws = makeWorkspace({ "f.txt": FILE });
    const r = await editTool.execute(
      { path: "f.txt", old: "status: queued", new: "status: shipped" },
      await ctxHavingRead(ws),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("the file may already contain this edit");
    expect(readFixture(ws, "f.txt")).toBe(FILE);
  });

  test("(e) already-applied / file contents are suppressed when the file was NOT read", async () => {
    const ws = makeWorkspace({ "f.txt": FILE });
    // No read: the fuzzy rungs (and the content-revealing feedback) must be gated.
    const r = await editTool.execute(
      { path: "f.txt", old: "status: queued", new: "status: shipped" },
      mockToolContext({ cwd: ws }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HZ_PRECONDITION_FAILED");
    expect(r.error).not.toContain("the file may already contain this edit");
    expect(r.error).not.toContain("status: shipped");
    expect(readFixture(ws, "f.txt")).toBe(FILE);
  });
});
