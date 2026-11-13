import { describe, expect, test } from "bun:test";
import {
  APPROVAL_TYPE_AHEAD_MS,
  consumeFullscreenApprovalKey,
  fullscreenApprovalStatusExtra,
  fullscreenRichApprovalEnabled,
} from "../../src/tui/fullscreen-approval";

describe("fullscreen approval", () => {
  test("rich approval requires TTY, raw mode and colour", () => {
    expect(fullscreenRichApprovalEnabled({ isTty: false, canRawMode: true }, {}, () => true)).toBe(false);
    expect(fullscreenRichApprovalEnabled({ isTty: true, canRawMode: false }, {}, () => true)).toBe(false);
    expect(fullscreenRichApprovalEnabled({ isTty: true, canRawMode: true }, { NO_COLOR: "1" }, () => true)).toBe(false);
    expect(fullscreenRichApprovalEnabled({ isTty: true, canRawMode: true }, { TERM: "dumb" }, () => true)).toBe(false);
    expect(fullscreenRichApprovalEnabled({ isTty: true, canRawMode: true }, { TERM: "xterm-256color" }, () => false)).toBe(
      false,
    );
    expect(fullscreenRichApprovalEnabled({ isTty: true, canRawMode: true }, { TERM: "xterm-256color" }, () => true)).toBe(
      true,
    );
  });

  test("status extras distinguish single-key vs line prompt", () => {
    expect(fullscreenApprovalStatusExtra("key")).toBe("approval: y/n/a/Esc");
    expect(fullscreenApprovalStatusExtra("line")).toBe("approval: y/n/a + Enter");
  });

  test("consumeFullscreenApprovalKey type-ahead, paste, and keys", () => {
    const armed = 1000;
    expect(consumeFullscreenApprovalKey(armed, armed - 1, false, { name: "y" }, "y")).toBe("ignore");
    expect(consumeFullscreenApprovalKey(armed, armed + APPROVAL_TYPE_AHEAD_MS, true, { name: "y" }, "y")).toBe(
      "paste-block",
    );
    expect(consumeFullscreenApprovalKey(armed, armed + 1, false, { name: "paste-start" }, undefined)).toBe(
      "paste-block",
    );
    expect(consumeFullscreenApprovalKey(armed, armed + 1, false, { name: "y" }, "y")).toBe("y");
    expect(consumeFullscreenApprovalKey(armed, armed + 1, false, { name: "escape" }, "\u001b")).toBe("n");
    expect(consumeFullscreenApprovalKey(armed, armed + 1, false, { name: "x" }, "x")).toBe("ignore");
  });
});
