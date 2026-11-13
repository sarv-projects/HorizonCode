import { describe, expect, test } from "bun:test";
import {
  buildFullscreenInsetLogicalLines,
  buildFullscreenInsetScrollbackLines,
  buildInsetReconcileBlockLogicalLines,
  buildInsetObservePendingLogicalLines,
} from "../../src/tui/fullscreen-inset-pane";
import { fullscreenTranscriptScrollBackMax, sliceTranscriptViewport } from "../../src/tui/fullscreen-layout";

describe("fullscreen inset pane content (ruling 300)", () => {
  test("prefers UNKNOWN rows over buried transcript", () => {
    const lines = buildFullscreenInsetScrollbackLines({
      transcript: ["a", "b"],
      scrollUp: 2,
      unknownRows: [
        { effectId: "ef1", tool: "write", callId: "c1", receiptId: "r1" },
      ],
    });
    expect(lines[0]).toContain("UNKNOWN");
    expect(lines.some((l) => l.includes("ef1"))).toBe(true);
  });

  test("shows buried transcript when scrolled up", () => {
    const lines = buildFullscreenInsetScrollbackLines({
      transcript: ["old", "mid", "new"],
      scrollUp: 1,
      unknownRows: [],
    });
    expect(lines[0]).toContain("buried");
    expect(lines.some((l) => l.includes("mid"))).toBe(true);
  });

  test("hint when inset open but not scrolled", () => {
    const lines = buildFullscreenInsetScrollbackLines({
      transcript: ["only"],
      scrollUp: 0,
      unknownRows: [],
    });
    expect(lines[0]).toContain("Ctrl+B");
    expect(lines[0]).toContain("wheel on main");
  });

  test("observe-pending inset banner without latch (ruling 342)", () => {
    const prev = process.env.HZ_EFFECT_RECONCILE_BLOCK;
    process.env.HZ_EFFECT_RECONCILE_BLOCK = "1";
    try {
      const view = {
        latched: false,
        mode: "session" as const,
        observePendingActive: true,
        observePendingDependencies: [{ resourcePath: "/w/pending.ts", effectIds: ["eff-observe"] }],
      };
      const only = buildInsetObservePendingLogicalLines(view);
      expect(only[0]).toContain("BLOCK observe");
      expect(only.some((l) => l.includes("pending.ts"))).toBe(true);
      const lines = buildFullscreenInsetLogicalLines({
        transcript: ["buried"],
        mainScrollUp: 5,
        unknownRows: [{ effectId: "ef1", tool: "write", callId: "c1", receiptId: "r1" }],
        reconcileBlock: view,
      });
      expect(lines[0]).toContain("BLOCK observe");
      expect(lines.some((l) => l.includes("ef1"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.HZ_EFFECT_RECONCILE_BLOCK;
      else process.env.HZ_EFFECT_RECONCILE_BLOCK = prev;
    }
  });

  test("reconcile-block latched shows BLOCK banner and path summary (ruling 309)", () => {
    const prev = process.env.HZ_EFFECT_RECONCILE_BLOCK;
    process.env.HZ_EFFECT_RECONCILE_BLOCK = "1";
    try {
      const view = {
        latched: true,
        mode: "resource" as const,
        reason: "probe mismatch",
        blockedPaths: ["src/a.ts", "src/b.ts"],
      };
      const blockOnly = buildInsetReconcileBlockLogicalLines(view);
      expect(blockOnly[0]).toContain("BLOCK resource");
      expect(blockOnly.some((l) => l.includes("LATCHED"))).toBe(true);
      expect(blockOnly.some((l) => l.includes("src/a.ts"))).toBe(true);
      const lines = buildFullscreenInsetLogicalLines({
        transcript: ["buried"],
        mainScrollUp: 5,
        unknownRows: [{ effectId: "ef1", tool: "write", callId: "c1", receiptId: "r1" }],
        reconcileBlock: view,
      });
      expect(lines[0]).toContain("BLOCK resource");
      expect(lines.some((l) => l.includes("src/b.ts"))).toBe(true);
      expect(lines.some((l) => l.includes("ef1"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.HZ_EFFECT_RECONCILE_BLOCK;
      else process.env.HZ_EFFECT_RECONCILE_BLOCK = prev;
    }
  });

  test("inset scrollBack reveals older buried lines (ruling 305)", () => {
    const logical = buildFullscreenInsetLogicalLines({
      transcript: ["a", "b", "c", "d", "e"],
      mainScrollUp: 2,
      unknownRows: [],
    });
    expect(logical.some((l) => l.includes("a"))).toBe(true);
    const maxBack = fullscreenTranscriptScrollBackMax(logical, 80, 2);
    expect(maxBack).toBeGreaterThan(0);
    const viewport = sliceTranscriptViewport(logical, 80, 2, maxBack);
    expect(viewport.some((r) => r.includes("a"))).toBe(true);
  });
});
