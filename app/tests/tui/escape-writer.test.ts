import { describe, expect, test } from "bun:test";
import {
  ENTER_ALT_SCREEN,
  EscapeWriter,
  LEAVE_ALT_SCREEN,
  MOUSE_CAPTURE_OFF,
  SHOW_CURSOR,
  encodeTerminalRestore,
  type TerminalHooks,
} from "../../src/tui/escape-writer";

describe("escape-writer", () => {
  test("enterFullscreen writes alt-screen sequence", () => {
    const written: string[] = [];
    const hooks: TerminalHooks = { write: (d) => written.push(d), enterRawMode: () => {} };
    const w = new EscapeWriter({ hooks });
    w.enterFullscreen();
    expect(written.join("")).toBe(ENTER_ALT_SCREEN);
    expect(w.restoreState.altScreen).toBe(true);
  });

  test("restore is idempotent and golden R7 byte order", () => {
    const written: string[] = [];
    let rawLeft = false;
    const hooks: TerminalHooks = {
      write: (d) => written.push(d),
      leaveRawMode: () => {
        rawLeft = true;
      },
    };
    const w = new EscapeWriter({ hooks });
    w.enterFullscreen();
    w.markMouseCaptured();
    w.markCursorHidden();
    w.restore();
    w.restore();
    expect(written).toHaveLength(2);
    const golden = encodeTerminalRestore(
      { altScreen: true, rawMode: true, mouseCaptured: true, bracketedPaste: false, cursorHidden: true },
      hooks,
    );
    expect(written[0]).toBe(ENTER_ALT_SCREEN);
    expect(written[1]).toBe(MOUSE_CAPTURE_OFF + SHOW_CURSOR + LEAVE_ALT_SCREEN);
    expect(golden).toBe(written[1]);
    expect(rawLeft).toBe(true);
  });

  test("encodeTerminalRestore with empty state is no-op", () => {
    expect(encodeTerminalRestore(
      { altScreen: false, rawMode: false, mouseCaptured: false, bracketedPaste: false, cursorHidden: false },
      { write: () => {} },
    )).toBe("");
  });
});
