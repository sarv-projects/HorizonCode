import { describe, expect, test } from "bun:test";
import {
  resolveScrollbackReceiptInspectTarget,
  scrollbackReceiptInspectNoticeNoTarget,
} from "../../src/tui/scrollback-receipt-shortcut";

describe("scrollback receipt shortcut (ruling 290)", () => {
  test("resolveScrollbackReceiptInspectTarget prefers explicit uri/id", () => {
    expect(resolveScrollbackReceiptInspectTarget("ctx-rcpt", "hz://receipt/explicit")).toBe("explicit");
    expect(resolveScrollbackReceiptInspectTarget("ctx-rcpt", undefined)).toBe("ctx-rcpt");
    expect(resolveScrollbackReceiptInspectTarget(undefined, undefined)).toBeUndefined();
  });

  test("notice mentions palette and hz uri", () => {
    expect(scrollbackReceiptInspectNoticeNoTarget()).toContain("hz://receipt");
    expect(scrollbackReceiptInspectNoticeNoTarget()).toContain("/palette");
  });
});
