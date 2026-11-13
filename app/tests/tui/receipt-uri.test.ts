import { describe, expect, test } from "bun:test";
import { formatHzReceiptUri, isHzReceiptPaletteCommand, parseHzReceiptUri } from "../../src/tui/receipt-uri";
import { rankFullscreenPaletteCommands } from "../../src/tui/receipt-palette";

describe("hz://receipt URI (ruling 288)", () => {
  test("parse and format", () => {
    expect(parseHzReceiptUri("hz://receipt/abc-123")).toBe("abc-123");
    expect(parseHzReceiptUri("  HZ://receipt/xyz  ")).toBe("xyz");
    expect(parseHzReceiptUri("/unknown inspect x")).toBeUndefined();
    expect(formatHzReceiptUri("rid")).toBe("hz://receipt/rid");
    expect(isHzReceiptPaletteCommand("hz://receipt/rid")).toBe(true);
  });

  test("palette injects receipt row when query is a receipt URI", () => {
    const rows = rankFullscreenPaletteCommands("hz://receipt/test-id", [], 10);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.name).toBe("hz://receipt/test-id");
    expect(rows[0]?.description).toContain("R172 reduced");
  });
});
