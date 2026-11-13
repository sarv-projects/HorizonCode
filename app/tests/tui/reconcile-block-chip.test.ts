import { describe, expect, test } from "bun:test";
import { setColorEnabled, strip } from "../../src/tui/style";
import {
  formatReconcileBlockStatusChip,
  fullscreenReconcileBlockExtra,
  formatReconcileBlockBarrierNotice,
  formatReconcileBlockScrollbackNoticeLines,
  reconcileBlockScrollbackNoticeKey,
} from "../../src/tui/reconcile-block-chip";
import { composeStatusBar } from "../../src/tui/live";
import { formatEffectReconcileBlockStatusLines } from "../../src/core/effect-reconcile-block";

describe("reconcile block chip (ruling 304)", () => {
  test("chip and fullscreen extra when latched", () => {
    setColorEnabled(false);
    const view = { latched: true, mode: "session" as const, reason: "1 open UNKNOWN effect(s)" };
    expect(strip(formatReconcileBlockStatusChip(view))).toBe("BLOCK mutate");
    expect(fullscreenReconcileBlockExtra(view)).toBe("BLOCK mutate");
    expect(formatReconcileBlockBarrierNotice(view)).toContain("mutating tools blocked");
  });

  test("resource mode label", () => {
    setColorEnabled(false);
    expect(strip(formatReconcileBlockStatusChip({ latched: true, mode: "resource", reason: "x" }))).toBe(
      "BLOCK resource",
    );
  });

  test("status bar retains BLOCK chip under width pressure", () => {
    setColorEnabled(false);
    const bar = composeStatusBar(
      {
        badge: "",
        model: "m",
        provider: "p",
        path: "~/w",
        reconcileBlock: { latched: true, mode: "session", reason: "probe mismatch" },
      },
      72,
    );
    expect(strip(bar)).toContain("BLOCK mutate");
  });

  test("scrollback notice lines list BLOCK label and blocked paths (ruling 310)", () => {
    const view = {
      latched: true,
      mode: "resource" as const,
      reason: "probe mismatch",
      blockedPaths: ["src/a.ts", "src/b.ts"],
    };
    const lines = formatReconcileBlockScrollbackNoticeLines(view);
    expect(lines[0]).toContain("mutating tools blocked");
    expect(lines.some((l) => l.includes("BLOCK resource"))).toBe(true);
    expect(lines.join("\n")).toContain("src/a.ts");
    const key = reconcileBlockScrollbackNoticeKey(view);
    expect(key).toContain("resource");
    expect(key).toContain("src/a.ts");
  });

  test("formatEffectReconcileBlockStatusLines for /unknown status", () => {
    const prev = process.env.HZ_EFFECT_RECONCILE_BLOCK;
    process.env.HZ_EFFECT_RECONCILE_BLOCK = "1";
    try {
      const lines = formatEffectReconcileBlockStatusLines({
        latched: true,
        mode: "session",
        reason: "open UNKNOWN",
      });
      expect(lines[0]).toContain("LATCHED");
      expect(lines.some((l) => l.includes("/unknown release"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HZ_EFFECT_RECONCILE_BLOCK;
      else process.env.HZ_EFFECT_RECONCILE_BLOCK = prev;
    }
  });
});
