import { describe, expect, test } from "bun:test";
import {
  formatApprovalAskAnnouncement,
  formatBusyStatusAnnouncement,
  formatIdleStatusAnnouncement,
  formatUnknownEffectAnnouncement,
  reduceMotion,
  screenReaderMode,
  spinnerIntervalMs,
} from "../../src/tui/a11y";

describe("a11y", () => {
  test("HZ_REDUCE_MOTION slows spinner", () => {
    expect(reduceMotion({ HZ_REDUCE_MOTION: "1" })).toBe(true);
    expect(spinnerIntervalMs({ HZ_REDUCE_MOTION: "1" })).toBe(1000);
    expect(spinnerIntervalMs({})).toBe(100);
  });

  test("screen reader announcements are plain", () => {
    expect(screenReaderMode({ HZ_SCREEN_READER: "1" })).toBe(true);
    expect(formatIdleStatusAnnouncement({ badge: "PLAN", model: "gpt-4", provider: "mock", path: "~" })).toContain(
      "mode PLAN",
    );
    expect(formatBusyStatusAnnouncement({ verb: "Reading", turnMs: 12_000, esc: true })).toContain("Working: Reading");
  });

  test("effect unknown and approval announcements are plain", () => {
    expect(
      formatUnknownEffectAnnouncement({ effectId: "eff-12345678-abcd", tool: "write", receiptId: "rcpt-1" }),
    ).toContain("could not be verified");
    expect(formatUnknownEffectAnnouncement({ effectId: "eff-12345678-abcd" })).toContain("eff-1234");
    expect(formatApprovalAskAnnouncement({ title: "write README.md", canAlways: true })).toContain("Approval required");
    expect(formatApprovalAskAnnouncement({ title: "shell", detail: "ls -la" })).toContain("ls -la");
  });
});
