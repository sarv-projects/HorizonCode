import { describe, expect, test } from "bun:test";
import { feedMouseBytes, flushMouseCarry } from "../../src/tui/mouse-parse";

describe("mouse-parse", () => {
  test("SGR click parsed", () => {
    const { result } = feedMouseBytes("\u001b[<0;12;5m");
    expect(result.events.length).toBe(1);
    expect(result.events[0]?.row).toBe(5);
    expect(result.events[0]?.col).toBe(12);
    expect(result.plain).toBe("");
  });

  test("plain bytes never swallowed", () => {
    const chunks = ["hello", "\u001b[<0;1;1m", "!", ""];
    let carry = "";
    let plain = "";
    let events = 0;
    for (const c of chunks) {
      const fed = feedMouseBytes(c, carry);
      carry = fed.carry;
      plain += fed.result.plain;
      events += fed.result.events.length;
    }
    plain += flushMouseCarry(carry);
    expect(plain).toBe("hello!");
    expect(events).toBe(1);
  });

  test("fuzz: random ASCII never becomes a mouse event without ESC", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789\n\t ";
    for (let i = 0; i < 200; i += 1) {
      let s = "";
      for (let j = 0; j < 8; j += 1) s += alphabet[(i + j) % alphabet.length]!;
      const { result } = feedMouseBytes(s);
      expect(result.events.length).toBe(0);
      expect(result.plain).toBe(s);
    }
  });
});
