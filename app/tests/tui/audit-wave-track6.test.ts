/**
 * audit-wave-track6.test.ts — Track 6 regression suite:
 * TUI Security, 3-Stage Approval, Mouse, IME & Leak Fixes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { ApprovalRequest, GuardAction, Runtime } from "../../src/contracts";
import {
  createApprovalUi,
  createStructuredApprovalHandler,
} from "../../src/tui/approval";
import {
  createApprovalStageState,
  reduceApprovalStageKey,
} from "../../src/tui/approval-card";
import { normalizeApprovalKeyPrompt } from "../../src/tui/approval-key-prompt";
import { EscapeWriter } from "../../src/tui/escape-writer";
import {
  APPROVAL_TYPE_AHEAD_MS,
  consumeFullscreenStagedApprovalKey,
} from "../../src/tui/fullscreen-approval";
import { composeStatusBar, toolVerb, userBlock } from "../../src/tui/live";
import { renderInline } from "../../src/tui/markdown";
import { feedMouseBytes } from "../../src/tui/mouse-parse";
import { createKeypressPasteCollector, createPasteCollector } from "../../src/tui/paste";
import { runPrint } from "../../src/tui/print";
import { createRenderer } from "../../src/tui/render";
import { colorEnabled, sanitizeText, setColorEnabled, strip } from "../../src/tui/style";

const TUI_DIR = path.resolve(import.meta.dir, "../../src/tui");

let prevColor = false;
beforeAll(() => {
  prevColor = colorEnabled();
  setColorEnabled(false);
});
afterAll(() => setColorEnabled(prevColor));

describe("Track 6 — P0: Single-Line Paste Guard & Fail-Closed 3-Stage Approval", () => {
  test("approval.ts line mode always_confirm requires explicit y/yes and fails closed on empty/EOF or 'a'", async () => {
    const req: ApprovalRequest = { kind: "shell.exec", title: "Run build", detail: "bun run build" };
    const action: GuardAction = { kind: "shell.exec", target: "bun run build" };

    // Empty / EOF in Stage 2 must deny (fail-closed)
    const uiEof = createApprovalUi(true);
    uiEof.threeStage = true;
    uiEof.renderer = createRenderer({ wrap: false, out: () => {} });
    const answersEof = ["a", ""];
    uiEof.ask = async () => answersEof.shift() ?? "";
    expect(await createStructuredApprovalHandler(uiEof)(req, action)).toEqual({ decision: "declined" });

    // Double-tapping 'a' in Stage 2 must NOT confirm; returns to Stage 1 then 'n' -> '' denies
    const uiDoubleA = createApprovalUi(true);
    uiDoubleA.threeStage = true;
    uiDoubleA.renderer = createRenderer({ wrap: false, out: () => {} });
    const answersDoubleA = ["a", "a", "n", ""];
    uiDoubleA.ask = async () => answersDoubleA.shift() ?? "";
    expect(await createStructuredApprovalHandler(uiDoubleA)(req, action)).toEqual({ decision: "declined" });
  });

  test("approval-card.ts Stage 2 rejects 'a' and Stage 3 strips C1 controls and pops by code point", () => {
    const s1 = createApprovalStageState({ canAlways: true, alwaysPattern: "npm test" });
    const s2 = reduceApprovalStageKey(s1, "a", { name: "a" }).state;
    expect(s2.stage).toBe("always_confirm");

    // Double-tapping 'a' in Stage 2 must NOT confirm
    const secondA = reduceApprovalStageKey(s2, "a", { name: "a" });
    expect(secondA.done).toBe(false);
    expect(secondA.state.stage).toBe("always_confirm");

    // Stage 3: C1 control stripped + emoji popped by code point on Backspace
    let s3 = reduceApprovalStageKey(s1, "n", { name: "n" }).state;
    s3 = reduceApprovalStageKey(s3, "ok\u009b31m🚀", { name: undefined }).state;
    expect(s3.steeringInput).toBe("ok31m🚀");
    s3 = reduceApprovalStageKey(s3, undefined, { name: "backspace" }).state;
    expect(s3.steeringInput).toBe("ok31m");
  });

  test("fullscreen-approval.ts enforces Stage-2 type-ahead and converts Stage-3 pasted newlines to spaces", () => {
    const s1 = createApprovalStageState({ canAlways: true, alwaysPattern: "bun test" });
    const s2 = reduceApprovalStageKey(s1, "a", { name: "a" }).state;

    // Stage 2 type-ahead guard drops keys before armedAt
    const armedAt = 2000;
    expect(
      consumeFullscreenStagedApprovalKey(s2, armedAt, armedAt - 1, false, { name: "y" }, "y"),
    ).toEqual({ kind: "ignore" });
    expect(
      consumeFullscreenStagedApprovalKey(s2, armedAt, armedAt + APPROVAL_TYPE_AHEAD_MS, false, { name: "y" }, "y").kind,
    ).toBe("resolved");

    // Stage 3 pasted newlines become spaces instead of prematurely submitting, and C1 controls are stripped
    let s3 = reduceApprovalStageKey(s1, "n", { name: "n" }).state;
    const pastedChunk = consumeFullscreenStagedApprovalKey(
      s3,
      armedAt,
      armedAt + 10,
      true,
      { name: undefined },
      "line1\r\nline2\u009b31m",
    );
    expect(pastedChunk.kind).toBe("transition");
    if (pastedChunk.kind === "transition") {
      s3 = pastedChunk.state;
      expect(s3.steeringInput).toBe("line1 line231m");
    }
    const pastedEnter = consumeFullscreenStagedApprovalKey(
      s3,
      armedAt,
      armedAt + 15,
      true,
      { name: "return" },
      "\r",
    );
    expect(pastedEnter.kind).toBe("transition");
    if (pastedEnter.kind === "transition") {
      expect(pastedEnter.state.steeringInput).toBe("line1 line231m ");
    }
  });

  test("approval.ts askStagedKey onTick does not overwrite Stage 2/3 card with Stage 1", async () => {
    const req: ApprovalRequest = { kind: "shell.exec", title: "Run", detail: "bun test" };
    const action: GuardAction = { kind: "shell.exec", target: "bun test" };
    const ui = createApprovalUi(true);
    ui.renderer = createRenderer({ wrap: false, out: () => {} });
    ui.runtime = { sessionId: "sess-tick-check" } as unknown as Runtime;

    let tickedPlain = "";
    ui.askStagedKey = async (prompt, initial) => {
      const normalized = normalizeApprovalKeyPrompt(prompt);
      const s2 = reduceApprovalStageKey(initial, "a", { name: "a" }).state;
      normalized.renderStage?.(s2);
      const ticked = normalized.onTick?.() ?? [];
      tickedPlain = ticked.map(strip).join("\n");
      return { kind: "declined" };
    };

    await createStructuredApprovalHandler(ui)(req, action);
    if (tickedPlain !== "") {
      expect(tickedPlain).toContain("Confirm always");
      expect(tickedPlain).not.toContain("Approve Run?");
    }
  });

  test("interactive.ts and fullscreen-chat.ts wire askStagedKey, /models refresh, and single-line paste rejection", () => {
    const interactiveSrc = readFileSync(path.join(TUI_DIR, "interactive.ts"), "utf8");
    const fullscreenSrc = readFileSync(path.join(TUI_DIR, "fullscreen-chat.ts"), "utf8");
    const fullscreenSlashSrc = readFileSync(path.join(TUI_DIR, "fullscreen-slash.ts"), "utf8");

    expect(interactiveSrc).toContain("ui.askStagedKey =");
    expect(fullscreenSrc).toContain("ui.askStagedKey =");
    expect(interactiveSrc).toContain("isModelsRefreshCommand(arg)");
    expect(interactiveSrc).toContain("runModelsSlashRefresh({ env: process.env })");
    expect(fullscreenSlashSrc).toContain("isModelsRefreshCommand(arg)");
    expect(fullscreenSlashSrc).toContain("runModelsSlashRefresh({ env: process.env })");

    // Fullscreen applyPaste must NOT gate approval denial on pasted.lines > 1
    expect(fullscreenSrc).not.toContain("approvalKeyResolve !== null && pasted.lines > 1");
    expect(fullscreenSrc).not.toContain("approvalResolve !== null && pasted.lines > 1");
    // Interactive submitPaste must guard answerWaiter before handleUserLine
    expect(interactiveSrc).toContain("if (answerWaiter !== null)");
  });
});

describe("Track 6 — P1: Escape Injection & Sanitization", () => {
  test("markdown.ts strips control chars from OSC 8 URLs", () => {
    const out = renderInline("[click](https://example.com/\u001b]52;c;ZGF0YQ==\u0007\u009b31m)", {
      level: 3,
      unicode: true,
      hyperlinks: true,
    });
    expect(out).not.toContain("\u001b]52;");
    expect(out).not.toContain("\u0007");
    expect(out).not.toContain("\u009b");
    expect(out).toContain("\u001b]8;;https://example.com/");
  });

  test("style.ts ANSI_RE strips ECMA-48 CSI, 8-bit C1 CSI, and DCS/APC/PM/SOS sequences", () => {
    const payload =
      "A\u001b[>0qB\u001b[4:3mC\u009b31mD\u001bP1$r0m\u001b\\E\u001b_G=1\u001b\\F\u001b^pm\u009cG\u001bXsos\u001b\\H";
    expect(strip(payload)).toBe("ABCDEFGH");
    expect(sanitizeText(payload)).toBe("ABCDEFGH");
  });

  test("live.ts sanitizes toolVerb, composeStatusBar, and userBlock", () => {
    const verb = toolVerb("read", { path: "foo\u001b[31m\u0007.ts" });
    expect(verb).toBe("Reading foo.ts");
    expect(verb).not.toContain("\u001b");

    const bar = strip(
      composeStatusBar(
        {
          badge: "PLAN\u001b[31m",
          model: "gpt\u001b]0;pwn\u0007",
          provider: "openai\u009b31m",
          path: "~/proj\u001b[2J",
          branch: "main\u001bPbad\u001b\\",
        },
        120,
      ),
    );
    expect(bar).toContain("PLAN");
    expect(bar).toContain("gpt");
    expect(bar).not.toContain("pwn");
    expect(bar).not.toContain("bad");

    const block = userBlock("hi \u001b]52;c;abc\u0007there", 60, "12:00\u001b[31m", false);
    expect(block.join("\n")).toBe("❯ hi there");
  });

  test("render.ts emitArgs sanitizes tool name and args", () => {
    const chunks: string[] = [];
    const r = createRenderer({ wrap: true, out: (c) => void chunks.push(c) });
    r.handle({
      type: "tool.card",
      callId: "c1",
      name: "shell\u001b[31m",
      args: { cmd: "echo \u001b]0;title\u0007hi" },
      status: "running",
    });
    const out = chunks.join("");
    expect(out).not.toContain("\u001b]0;title");
    expect(out).not.toContain("\u0007");
  });

  test("print.ts sanitizes text output when process.stdout.isTTY is true", async () => {
    const origTty = (process.stdout as { isTTY?: boolean }).isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      let written = "";
      const fakeRuntime = {
        sessionId: "s-print",
        model: "m",
        send: async () => ({
          text: "hello \u001b]52;c;ZGF0YQ==\u0007world",
          exit: { terminal: "succeeded" as const },
        }),
        abort: () => {},
      } as unknown as Runtime;
      await runPrint({
        runtime: fakeRuntime,
        prompt: "hi",
        format: "text",
        write: (c) => {
          written += c;
        },
      });
      expect(written).toBe("hello world\n");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: origTty, configurable: true });
    }
  });
});

describe("Track 6 — P1: SGR 1006 Mouse Parsing", () => {
  test("parses SGR press (M), release (m), wheel, and drag accurately", () => {
    const press = feedMouseBytes("\u001b[<0;12;5M");
    expect(press.result.events).toHaveLength(1);
    expect(press.result.events[0]).toMatchObject({ action: "press", button: 0, col: 12, row: 5 });

    const release = feedMouseBytes("\u001b[<0;12;5m");
    expect(release.result.events).toHaveLength(1);
    expect(release.result.events[0]).toMatchObject({ action: "release", button: 0, col: 12, row: 5 });

    const wheel = feedMouseBytes("\u001b[<64;8;3M");
    expect(wheel.result.events[0]).toMatchObject({ action: "wheel", button: 0, col: 8, row: 3 });

    const drag = feedMouseBytes("\u001b[<32;9;4M");
    expect(drag.result.events[0]).toMatchObject({ action: "move", button: 0, col: 9, row: 4 });
  });

  test("never traps arrow keys or non-mouse ESC sequences in carry", () => {
    const up = feedMouseBytes("\u001b[A");
    expect(up.carry).toBe("");
    expect(up.result.plain).toBe("\u001b[A");
    expect(up.result.events).toHaveLength(0);

    const ctrlRight = feedMouseBytes("\u001b[1;5C");
    expect(ctrlRight.carry).toBe("");
    expect(ctrlRight.result.plain).toBe("\u001b[1;5C");

    // Partial SGR prefix IS held in carry until completed
    const part1 = feedMouseBytes("\u001b[<0;10");
    expect(part1.carry).toBe("\u001b[<0;10");
    const part2 = feedMouseBytes(";20M", part1.carry);
    expect(part2.carry).toBe("");
    expect(part2.result.events).toHaveLength(1);
    expect(part2.result.events[0]).toMatchObject({ action: "press", col: 10, row: 20 });
  });
});

describe("Track 6 — P1: Lifecycle, Signal, IME & Resource Leaks", () => {
  test("escape-writer.ts restore() does not double existing signal listeners", () => {
    const sentinel = () => {};
    process.on("SIGTERM", sentinel);
    const before = process.listeners("SIGTERM").length;
    try {
      const w = new EscapeWriter({ hooks: { write: () => {} } });
      w.installLifecycleHandlers(["SIGTERM"]);
      expect(process.listeners("SIGTERM").length).toBe(before + 1);
      w.restore();
      expect(process.listeners("SIGTERM").length).toBe(before);
    } finally {
      process.off("SIGTERM", sentinel);
    }
  });

  test("paste.ts flushAfterEnd() resets state even on empty bracketed paste", () => {
    const lineCollector = createPasteCollector();
    lineCollector.key("paste-start");
    lineCollector.key("paste-end");
    expect(lineCollector.flushAfterEnd()).toBeUndefined();
    expect(lineCollector.active()).toBe(false);
    expect(lineCollector.pasting()).toBe(false);

    const keyCollector = createKeypressPasteCollector();
    keyCollector.key("paste-start");
    keyCollector.key("paste-end");
    expect(keyCollector.flushAfterEnd()).toBeUndefined();
    expect(keyCollector.active()).toBe(false);
    expect(keyCollector.pasting()).toBe(false);
  });

  test("lifecycle hygiene checks across fullscreen-chat.ts, interactive.ts, and unknown-slash.ts", () => {
    const fullscreenSrc = readFileSync(path.join(TUI_DIR, "fullscreen-chat.ts"), "utf8");
    const interactiveSrc = readFileSync(path.join(TUI_DIR, "interactive.ts"), "utf8");
    const unknownSlashSrc = readFileSync(path.join(TUI_DIR, "unknown-slash.ts"), "utf8");

    // SIGINT on process, not process.stdin
    expect(fullscreenSrc).toContain('process.on("SIGINT", onSigInt)');
    expect(fullscreenSrc).toContain('process.off("SIGINT", onSigInt)');
    expect(fullscreenSrc).not.toContain('process.stdin.on("SIGINT"');
    // clearApprovalKeyTick in finish() and unref() on interval
    expect(fullscreenSrc).toContain("clearApprovalKeyTick();");
    expect(fullscreenSrc).toContain(".unref?.()");
    // KernelClient closed in finally on export paths
    expect(interactiveSrc).toContain("await kernel.close()");
    expect(unknownSlashSrc).toContain("await kernel.close()");
    // submitGuard returns promise from handleUserLine
    expect(interactiveSrc).toContain("submitGuard.request(() => handleUserLine(");
    // stdin keypress listeners stored and detached in finish()
    expect(interactiveSrc).toContain("stdinKeypressListeners");
  });
});
