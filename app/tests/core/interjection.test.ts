import { describe, expect, test } from "bun:test";
import {
  INTERJECTION_NOTE,
  INTERJECTION_UNFINISHED_REMINDER,
  InterjectionBuffer,
  acceptInterjection,
  drainFormatted,
  drainFormattedWithRows,
  formatInterjection,
  formatInterrupt,
  formatSystemInterruptSteer,
  formatStrandedInterjections,
  INTERRUPT_NOTE,
} from "../../src/core/interjection";
import { drainInterjectionsAtSafePoint, RunFaults, type LoopDeps } from "../../src/core/loop";
import type { RuntimeCallbacks } from "../../src/contracts";

describe("cancel-safe drain", () => {
  test("drain exposes original framing so an interrupted drain can restore it", () => {
    const b = new InterjectionBuffer();
    b.push("first", "steer");
    b.push("second", "interrupt");
    b.push("third", "steer");
    const rows = drainFormattedWithRows(b);
    expect(rows.map((r) => r.entry.framing)).toEqual(["steer", "interrupt", "steer"]);
    expect(rows[1]!.row.modelText).toContain('<system-interrupt reason="steer">');
    b.restoreFront(rows.slice(1).map((r) => r.entry));
    expect(b.len()).toBe(2);
    expect(drainFormattedWithRows(b).map((r) => r.entry.framing)).toEqual(["interrupt", "steer"]);
  });
});

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

  test("chat-bar steer uses a system-interrupt envelope without aborting", () => {
    const out = formatSystemInterruptSteer("pivot to the failing test");
    expect(out.startsWith('<system-interrupt reason="steer">\n')).toBe(true);
    expect(out).toContain("</system-interrupt>");
    expect(out).toContain("pivot to the failing test");
    expect(out).toContain(INTERJECTION_UNFINISHED_REMINDER);
  });

  test("acceptInterjection mode interrupt frames only the model text", () => {
    const buf = new InterjectionBuffer();
    expect(acceptInterjection(buf, "pivot", { mode: "interrupt" }).accepted).toBe(true);
    const rows = drainFormatted(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayText).toBe("pivot");
    expect(rows[0]!.modelText).toContain('<system-interrupt reason="steer">');
    expect(rows[0]!.modelText).toContain(INTERJECTION_NOTE);
    expect(rows[0]!.modelText.endsWith("</system-interrupt>")).toBe(true);
  });

  test("formatStrandedInterjections picks envelope from interrupted flag", () => {
    const stranded = [{ text: "pivot to tests" }];
    const mid = formatStrandedInterjections(stranded, false)[0]!;
    const cut = formatStrandedInterjections(stranded, true)[0]!;
    expect(mid.modelText).toContain(INTERJECTION_NOTE);
    expect(cut.modelText).toContain(INTERRUPT_NOTE);
    expect(mid.displayText).toBe("pivot to tests");
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

  test("accepts valid image parts and attaches them on drain", () => {
    const buf = new InterjectionBuffer();
    const imgPart = { type: "image" as const, base64: "dGVzdA==", media_type: "image/png" };
    const out = acceptInterjection(buf, "look at this diagram", { images: [imgPart] });
    expect(out.accepted).toBe(true);
    if (out.accepted) {
      expect(out.imagesAccepted).toBe(true);
      expect(out.imagesRefused).toBeUndefined();
    }
    const drained = drainFormattedWithRows(buf);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.row.contentParts).toBeDefined();
    expect(drained[0]!.row.contentParts).toHaveLength(2);
    expect(drained[0]!.row.contentParts![0]).toEqual({
      type: "text",
      text: drained[0]!.row.modelText,
    });
    expect(drained[0]!.row.contentParts![1]).toEqual(imgPart);
  });
});

describe("drainInterjectionsAtSafePoint", () => {
  test("appends synthetic user rows and emits admitted events", () => {
    const buffer = new InterjectionBuffer();
    buffer.push("use ripgrep not grep");
    const appended: Array<{ role: string; content: unknown }> = [];
    const events: string[] = [];
    const deps = {
      interjection: buffer,
      sessionId: "s1",
      store: {
        appendMessage(_sid: string, msg: { role: string; content: unknown }) {
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

  test("appends multipart content when image parts are present", () => {
    const buffer = new InterjectionBuffer();
    const imgPart = { type: "image_url" as const, image_url: { url: "data:image/png;base64,abc" } };
    acceptInterjection(buffer, "check this screenshot", { images: [imgPart] });
    const appended: Array<{ role: string; content: unknown }> = [];
    const deps = {
      interjection: buffer,
      sessionId: "s1",
      store: {
        appendMessage(_sid: string, msg: { role: string; content: unknown }) {
          appended.push(msg);
          return "m1";
        },
      },
      callbacks: {
        onEvent() {},
      } satisfies RuntimeCallbacks,
    } as unknown as LoopDeps;
    const faults = new RunFaults();
    expect(drainInterjectionsAtSafePoint(deps, faults)).toBe(true);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.role).toBe("user");
    expect(Array.isArray(appended[0]?.content)).toBe(true);
    const parts = appended[0]?.content as Array<{ type: string }>;
    expect(parts[0]?.type).toBe("text");
    expect(parts[1]).toEqual(imgPart);
  });
});
