import { describe, expect, test } from "bun:test";
import {
  INTERJECTION_NOTE,
  InterjectionBuffer,
  acceptInterjection,
  drainFormatted,
  formatInterjection,
  formatInterrupt,
} from "../../src/core/interjection";
import { drainInterjectionsAtSafePoint, RunFaults, type LoopDeps } from "../../src/core/loop";
import type { RuntimeCallbacks } from "../../src/contracts";

describe("interjection format", () => {
  test("wraps with mid-turn note and user_query envelope", () => {
    const out = formatInterjection("stop and fix the test first");
    expect(out.startsWith(`${INTERJECTION_NOTE}\n<user_query>\n`)).toBe(true);
    expect(out).toContain("stop and fix the test first");
    expect(out).toContain("If the user is asking for a response");
  });

  test("interrupt uses a different lead-in", () => {
    const out = formatInterrupt("do the other thing");
    expect(out).toContain("The user interrupted the previous turn:");
    expect(out).toContain("do the other thing");
  });

  test("drainFormatted preserves FIFO and never merges", () => {
    const buf = new InterjectionBuffer();
    buf.push("one");
    buf.push("two");
    const rows = drainFormatted(buf, (t) => t.replace("[SECRET] ", ""));
    expect(buf.isEmpty()).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.displayText).toBe("one");
    expect(rows[1]?.displayText).toBe("two");
    expect(rows[0]?.modelText).not.toBe(rows[1]?.modelText);
  });
});

describe("acceptInterjection", () => {
  test("refuses empty text", () => {
    const buf = new InterjectionBuffer();
    expect(acceptInterjection(buf, "   ").accepted).toBe(false);
    expect(buf.isEmpty()).toBe(true);
  });

  test("queues text and flags dropped images", () => {
    const buf = new InterjectionBuffer();
    const out = acceptInterjection(buf, "hello", { images: [{}] });
    expect(out.accepted).toBe(true);
    if (out.accepted) expect(out.imagesRefused).toBe(true);
    expect(buf.len()).toBe(1);
  });
});

describe("drainInterjectionsAtSafePoint", () => {
  test("appends synthetic user rows and emits admitted events", () => {
    const buffer = new InterjectionBuffer();
    buffer.push("use ripgrep not grep");
    const appended: Array<{ role: string; content: string }> = [];
    const events: string[] = [];
    const deps = {
      interjection: buffer,
      sessionId: "s1",
      store: {
        appendMessage(_sid: string, msg: { role: string; content: string }) {
          appended.push(msg);
          return "m1";
        },
      },
      callbacks: {
        onEvent(ev) {
          if (ev.type === "interjection.admitted") events.push(ev.text);
        },
      } satisfies RuntimeCallbacks,
    } as unknown as LoopDeps;
    const faults = new RunFaults();
    expect(drainInterjectionsAtSafePoint(deps, faults)).toBe(true);
    expect(buffer.isEmpty()).toBe(true);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.role).toBe("user");
    expect(appended[0]?.content).toContain("use ripgrep not grep");
    expect(events).toEqual(["use ripgrep not grep"]);
  });
});
