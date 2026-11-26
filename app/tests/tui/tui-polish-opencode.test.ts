import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  VIRTUAL_CHUNK_LINES,
  VIRTUAL_MIN_LINES,
  createVirtualDiffChunks,
  renderVirtualDiffWindow,
  richDiffLines,
  visibleDiffChunkRange,
} from "../../src/tui/diff";
import {
  applyEditorKey,
  createDeferredSubmitGuard,
  lineEditorStep,
} from "../../src/tui/fullscreen-line-editor";
import {
  TRANSCRIPT_BACKFILL_CHUNK,
  TRANSCRIPT_TAIL_ROWS,
  createTranscriptMountBudget,
  mountFullscreenTranscriptWindow,
  sliceTranscriptTailFirst,
} from "../../src/tui/fullscreen-transcript";
import { rowsAfter, rowsBefore } from "../../src/tui/transcript";
import {
  createKeypressPasteCollector,
  createPasteCollector,
  editorPasteDisplay,
  normalizePastedLineEndings,
  pasteLabel,
} from "../../src/tui/paste";
import { colorEnabled, setColorEnabled, strip } from "../../src/tui/style";

let prevColor = false;
beforeAll(() => {
  prevColor = colorEnabled();
  setColorEnabled(false);
});
afterAll(() => setColorEnabled(prevColor));

describe("Track C.1: ConPTY \\r\\n and \\r paste normalization", () => {
  test("normalizePastedLineEndings converts CRLF, bare CR, and mixed line endings to LF", () => {
    expect(normalizePastedLineEndings("")).toBe("");
    expect(normalizePastedLineEndings("a\r\nb\r\nc")).toBe("a\nb\nc");
    expect(normalizePastedLineEndings("a\rb\rc")).toBe("a\nb\nc");
    expect(normalizePastedLineEndings("a\r\nb\rc\nd\r\n")).toBe("a\nb\nc\nd\n");
  });

  test("createPasteCollector splits ConPTY embedded CR/CRLF inside readline lines and collapses multi-line paste", () => {
    const collector = createPasteCollector();
    expect(collector.key("paste-start")).toBe(true);
    expect(collector.pasting()).toBe(true);
    expect(collector.line("first\rsecond\r\nthird")).toBeUndefined();
    expect(collector.key("paste-end")).toBe(true);
    expect(collector.pasting()).toBe(false);
    const result = collector.line("fourth\r");
    expect(result).toBeDefined();
    expect(result!.text).toBe("first\nsecond\nthird\nfourth");
    expect(result!.lines).toBe(4);
    expect(pasteLabel(result!.lines)).toBe("[pasted 4 lines]");
    expect(editorPasteDisplay(result!)).toEqual({
      display: "[pasted 4 lines]",
      submitText: "first\nsecond\nthird\nfourth",
    });
  });

  test("createKeypressPasteCollector normalizes split CR+LF and bare CR without accidental submits", () => {
    const collector = createKeypressPasteCollector();
    collector.key("paste-start");
    expect(collector.pasting()).toBe(true);
    // Split CRLF across consecutive keypress chunks must stay one newline, not two.
    collector.chunk("alpha\r");
    collector.chunk("\nbeta\rgamma\r");
    // While pasting, collector remains active and never emits a submit result prematurely.
    expect(collector.flushAfterEnd()).toBeUndefined();
    collector.key("paste-end");
    expect(collector.pasting()).toBe(false);
    const result = collector.flushAfterEnd();
    expect(result).toEqual({
      text: "alpha\nbeta\ngamma",
      lines: 3,
      raw: ["alpha", "beta", "gamma", ""],
    });
    expect(editorPasteDisplay(result!).display).toBe("[pasted 3 lines]");
  });
});

describe("Track C.2: IME double-defer submit + re-entrancy guard", () => {
  test("double-defers across two macrotask ticks so IME composition commits before submit", () => {
    const queue: Array<() => void> = [];
    let nextId = 1;
    const cleared = new Set<number>();
    const guard = createDeferredSubmitGuard({
      schedule: (fn) => {
        const id = nextId++;
        queue.push(() => {
          if (!cleared.has(id)) fn();
        });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clear: (handle) => {
        cleared.add(handle as unknown as number);
      },
    });

    let editorBuffer = "안녕하";
    const submitted: string[] = [];

    expect(guard.request(() => {
      submitted.push(editorBuffer);
    })).toBe(true);
    expect(guard.isPending()).toBe(true);
    expect(guard.isSubmitting()).toBe(true);
    expect(submitted).toEqual([]);

    // Rapid double-Enter while pending must be rejected.
    expect(guard.request(() => {
      submitted.push("duplicate");
    })).toBe(false);

    // Tick 1 fires: schedules Tick 2, still does not submit yet.
    queue.shift()!();
    expect(submitted).toEqual([]);
    expect(guard.isPending()).toBe(true);

    // IME commits final composed syllable between Tick 1 and Tick 2.
    editorBuffer += "세요";

    // Tick 2 fires: submits the fully composed string once.
    queue.shift()!();
    expect(submitted).toEqual(["안녕하세요"]);
    expect(guard.isPending()).toBe(false);
    expect(guard.isSubmitting()).toBe(false);
  });

  test("re-entrancy lock blocks overlapping async submits until settled", async () => {
    let release!: () => void;
    const calls: number[] = [];
    const guard = createDeferredSubmitGuard({ immediate: true });

    const firstAccepted = guard.request(async () => {
      calls.push(1);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    expect(firstAccepted).toBe(true);
    expect(guard.isSubmitting()).toBe(true);

    const secondAccepted = guard.request(() => {
      calls.push(2);
    });
    expect(secondAccepted).toBe(false);
    expect(calls).toEqual([1]);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(guard.isSubmitting()).toBe(false);

    expect(guard.request(() => {
      calls.push(3);
    })).toBe(true);
    expect(calls).toEqual([1, 3]);
  });

  test("cancel() aborts a pending double-deferred submit", () => {
    const queue: Array<() => void> = [];
    let nextId = 1;
    const cleared = new Set<number>();
    const guard = createDeferredSubmitGuard({
      schedule: (fn) => {
        const id = nextId++;
        queue.push(() => {
          if (!cleared.has(id)) fn();
        });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clear: (handle) => {
        cleared.add(handle as unknown as number);
      },
    });

    let ran = false;
    expect(guard.request(() => {
      ran = true;
    })).toBe(true);
    guard.cancel();
    expect(guard.isPending()).toBe(false);
    expect(guard.isSubmitting()).toBe(false);

    while (queue.length > 0) queue.shift()!();
    expect(ran).toBe(false);
  });

  test("real setTimeout double-defer completes and pure line editor stays synchronous", async () => {
    const step = lineEditorStep({ text: "hi" }, 13);
    expect(step.action).toEqual({ kind: "submit" });
    expect(applyEditorKey("a", "b".charCodeAt(0))).toEqual({
      text: "ab",
      action: { kind: "insert", ch: "b" },
    });

    const guard = createDeferredSubmitGuard();
    let fired = false;
    await new Promise<void>((resolve) => {
      expect(
        guard.request(() => {
          fired = true;
          resolve();
        }),
      ).toBe(true);
      expect(fired).toBe(false);
    });
    expect(fired).toBe(true);
  });
});

describe("Track C.3: Tail-first 40/60 transcript mount budget", () => {
  test("mounts newest 40 rows immediately and backfills older rows in 60-row chunks", () => {
    expect(TRANSCRIPT_TAIL_ROWS).toBe(40);
    expect(TRANSCRIPT_BACKFILL_CHUNK).toBe(60);

    const rows = Array.from({ length: 250 }, (_, i) => `row-${i}`);
    const initial = sliceTranscriptTailFirst(rows);
    expect(initial.items.length).toBe(40);
    expect(initial.startIndex).toBe(210);
    expect(initial.endIndex).toBe(250);
    expect(initial.remainingOlder).toBe(210);
    expect(initial.fullyMounted).toBe(false);
    expect(initial.items[0]).toBe("row-210");
    expect(initial.items[39]).toBe("row-249");

    const budget = createTranscriptMountBudget();
    expect(budget.mountedCount()).toBe(40);
    expect(budget.slice(rows).items.length).toBe(40);

    // Backfill 40 -> 100 -> 160 -> 220 -> 250
    expect(budget.backfill(rows.length)).toBe(true);
    expect(budget.mountedCount()).toBe(100);
    expect(budget.backfill(rows.length)).toBe(true);
    expect(budget.mountedCount()).toBe(160);
    expect(budget.backfill(rows.length)).toBe(true);
    expect(budget.mountedCount()).toBe(220);
    expect(budget.backfill(rows.length)).toBe(true);
    expect(budget.mountedCount()).toBe(250);
    expect(budget.slice(rows).fullyMounted).toBe(true);
    expect(budget.backfill(rows.length)).toBe(false);

    budget.reset();
    expect(budget.mountedCount()).toBe(40);
  });

  test("mountFullscreenTranscriptWindow expands in 60-row chunks as scrollUp deepens", () => {
    const transcript = Array.from({ length: 300 }, (_, i) => `line-${i}`);
    const budget = createTranscriptMountBudget();

    const firstPaint = mountFullscreenTranscriptWindow(transcript, budget, {
      scrollUp: 0,
      viewportRows: 24,
    });
    expect(firstPaint.items.length).toBe(40);
    expect(firstPaint.startIndex).toBe(260);

    // Scroll up 70 rows (needs 70 + 24 = 94 rows -> expands 40 -> 100).
    const scrolled = mountFullscreenTranscriptWindow(transcript, budget, {
      scrollUp: 70,
      viewportRows: 24,
    });
    expect(budget.mountedCount()).toBe(100);
    expect(scrolled.items.length).toBe(100);
    expect(scrolled.startIndex).toBe(200);
    expect(scrolled.remainingOlder).toBe(200);
  });

  test("rowsBefore and rowsAfter respect weighted row budgets", () => {
    const weights = [1, 5, 1, 1, 4, 1];
    expect(rowsBefore(weights, 6, 5)).toBe(4);
    expect(rowsAfter(weights, 0, 6)).toBe(2);
  });
});

describe("Track C.4: >= 3000-line virtual diff chunking (128-line chunks, ±1 window)", () => {
  function makeAddedDiff(lineCount: number): string {
    const body = Array.from({ length: lineCount }, (_, i) => `+const line_${i + 1} = ${i + 1};`).join("\n");
    return `--- /dev/null\n+++ b/src/massive.ts\n@@ -0,0 +1,${lineCount} @@\n${body}`;
  }

  test("below 3000 lines stays unvirtualized and matches richDiffLines exactly", () => {
    expect(VIRTUAL_MIN_LINES).toBe(3000);
    expect(VIRTUAL_CHUNK_LINES).toBe(128);

    const smallDiff = makeAddedDiff(50);
    const plan = createVirtualDiffChunks(smallDiff);
    expect(plan.virtualized).toBe(false);
    expect(plan.chunks.length).toBe(1);

    const win = renderVirtualDiffWindow(plan, { scrollTop: 0, viewportHeight: 30, level: 0 });
    expect(win.virtualized).toBe(false);
    expect(win.leadingPlaceholderRows).toBe(0);
    expect(win.trailingPlaceholderRows).toBe(0);
    expect(win.lines).toEqual(richDiffLines(smallDiff, { level: 0 }));
  });

  test("3500-line diff partitions into 128-line chunks and renders only viewport ±1 with exact gutters", () => {
    const massiveDiff = makeAddedDiff(3500);
    const plan = createVirtualDiffChunks(massiveDiff);
    // 1 file header + 1 hunk header + 3500 added lines = 3502 rows
    expect(plan.virtualized).toBe(true);
    expect(plan.totalRows).toBe(3502);
    expect(plan.chunkSize).toBe(128);
    expect(plan.gutterWidth).toBe(4);
    expect(plan.chunks.length).toBe(Math.ceil(3502 / 128));

    // Check ±1 range calculation in the middle of the file.
    const range = visibleDiffChunkRange(plan.chunks.length, 1500, 40, 128, 1);
    expect(range.viewportStartChunk).toBe(Math.floor(1500 / 128)); // 11
    expect(range.viewportEndChunk).toBe(Math.floor(1539 / 128)); // 12
    expect(range.startChunk).toBe(10);
    expect(range.endChunk).toBe(13);

    const win = renderVirtualDiffWindow(plan, {
      scrollTop: 1500,
      viewportHeight: 40,
      width: 80,
      level: 0,
    });
    expect(win.virtualized).toBe(true);
    expect(win.range).toEqual(range);
    expect(win.leadingPlaceholderRows).toBe(10 * 128);
    expect(win.lines.length).toBe(4 * 128);
    expect(win.leadingPlaceholderRows + win.lines.length + win.trailingPlaceholderRows).toBe(plan.totalRows);

    // Byte-for-byte parity with full richDiffLines slice (including 4-digit line-number gutter).
    const full = richDiffLines(massiveDiff, { width: 80, level: 0 });
    expect(win.lines).toEqual(full.slice(win.leadingPlaceholderRows, win.leadingPlaceholderRows + win.lines.length));
    expect(strip(win.lines[0]!)).toContain("1279 │+ const line_1279 = 1279;");

    // Top of diff: startChunk clamps at 0, overscan includes chunk 1.
    const topWin = renderVirtualDiffWindow(plan, { scrollTop: 0, viewportHeight: 40, width: 80, level: 0 });
    expect(topWin.range).toEqual({ startChunk: 0, endChunk: 1, viewportStartChunk: 0, viewportEndChunk: 0 });
    expect(topWin.leadingPlaceholderRows).toBe(0);
    expect(topWin.lines.length).toBe(256);
    // Chunk 0 still uses 4-digit gutter width (matching line 3500).
    expect(strip(topWin.lines[2]!)).toBe("     1 │+ const line_1 = 1;");

    // Bottom of diff: endChunk clamps at last chunk.
    const lastIdx = plan.chunks.length - 1;
    const bottomWin = renderVirtualDiffWindow(plan, {
      scrollTop: 3480,
      viewportHeight: 40,
      width: 80,
      level: 0,
    });
    expect(bottomWin.range.endChunk).toBe(lastIdx);
    expect(bottomWin.trailingPlaceholderRows).toBe(0);
    expect(strip(bottomWin.lines[bottomWin.lines.length - 1]!)).toBe("  3500 │+ const line_3500 = 3500;");
  });
});
