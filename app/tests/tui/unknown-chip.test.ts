import { describe, expect, test } from "bun:test";
import { setColorEnabled, strip } from "../../src/tui/style";
import {
  formatUnknownEffectNotice,
  formatUnknownStatusChip,
  fullscreenUnknownExtra,
  unknownCountAfterEvent,
} from "../../src/tui/unknown-chip";
import { composeStatusBar } from "../../src/tui/live";

describe("unknown chip (ruling 235)", () => {
  test("notice names tool, receipt, effect", () => {
    expect(
      formatUnknownEffectNotice({
        effectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        tool: "write",
        receiptId: "r-1",
      }),
    ).toBe("effect outcome unverified (UNKNOWN) · tool write · receipt r-1 · effect aaaaaaaa");
  });

  test("status chip and fullscreen extra", () => {
    setColorEnabled(false);
    expect(strip(formatUnknownStatusChip(2))).toBe("UNKNOWN 2");
    expect(fullscreenUnknownExtra(1)).toBe("UNKNOWN 1");
    expect(fullscreenUnknownExtra(0)).toBe("");
  });

  test("unknown count tracks facade events", () => {
    let n = 0;
    n = unknownCountAfterEvent(n, {
      type: "effect.unknown",
      effectId: "e1",
      tool: "read",
    });
    n = unknownCountAfterEvent(n, {
      type: "effect.unknown",
      effectId: "e2",
      tool: "edit",
    });
    expect(n).toBe(2);
    n = unknownCountAfterEvent(n, { type: "effect.reconciled", effectId: "e1" });
    expect(n).toBe(1);
  });

  test("status bar retains UNKNOWN under width pressure", () => {
    setColorEnabled(false);
    const bar = composeStatusBar(
      {
        badge: "",
        model: "m",
        provider: "p",
        path: "~/w",
        unknownCount: 1,
        unknownReceiptId: "receipt-abc",
      },
      60,
    );
    expect(strip(bar)).toContain("UNKNOWN");
  });
});
