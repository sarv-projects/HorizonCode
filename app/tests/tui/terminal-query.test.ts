/**
 * terminal-query.test.ts — terminal probe reply recognition
 * (grok terminal/probe.rs ADAPT). Pure classification of DA1/XTVERSION/RGB
 * replies vs keystrokes; late replies must not leak into input.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyTermReply,
  isReplyPrefix,
  drainLateReply,
  type TermReplyKind,
} from "../../src/tui/terminal-query";

describe("terminal query reply recognizer", () => {
  test("DA1 device attributes reply is recognized", () => {
    expect(classifyTermReply("\x1b[?62;1;4;22c").kind).toBe("da1");
  });

  test("XTVERSION reply is recognized", () => {
    expect(classifyTermReply("\x1bP>|xterm(390)\x1b\\").kind).toBe("xtversion");
  });

  test("RGB truecolor reply (OSC 4) is recognized", () => {
    expect(classifyTermReply("\x1b]4;1;rgb:ffff/0000/0000\x1b\\").kind).toBe("truecolor");
  });

  test("ordinary keystrokes are not replies", () => {
    expect(classifyTermReply("a").kind).toBe("keystroke");
    expect(classifyTermReply("\x1b[A").kind).toBe("keystroke"); // arrow key
  });

  test("partial reply is a prefix (late grace must wait)", () => {
    expect(isReplyPrefix("\x1b[?62")).toBe(true);
    expect(isReplyPrefix("\x1b")).toBe(true);
    expect(isReplyPrefix("hello")).toBe(false);
  });

  test("drainLateReply splits a complete reply from following keystrokes", () => {
    const r = drainLateReply("\x1b[?62;1c" + "abc");
    expect(r.reply).toContain("c");
    expect(r.rest).toBe("abc");
  });
});
