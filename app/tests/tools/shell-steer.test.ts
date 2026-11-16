/**
 * C-7 / ruling 490 — deterministic coverage of the auto-background ↔
 * mid-stream-steer race. No wall-clock bound: the background registry is noted
 * directly (the shell tool records it on its 45s timer), then a steer is
 * admitted at the next step boundary. The drain must:
 *   - admit the steer (synthetic user message + interjection.admitted event),
 *   - emit a CLEAR notice naming the live background pid and confirming it was
 *     left running,
 *   - never kill / clear the backgrounded process (registry still has it).
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { LoopDeps } from "../../src/core/loop";
import { drainInterjectionsAtSafePoint } from "../../src/core/loop";
import { InterjectionBuffer } from "../../src/core/interjection";
import {
  activeAutoBackgrounds,
  clearAllAutoBackgrounds,
  noteAutoBackground,
} from "../../src/core/shell-auto-background";

interface Row { role: string; content: string }
interface Ev { type: string; message?: string; text?: string }

afterEach(() => clearAllAutoBackgrounds());

function harness(): {
  buffer: InterjectionBuffer;
  deps: LoopDeps;
  appended: Row[];
  events: Ev[];
} {
  const buffer = new InterjectionBuffer();
  const appended: Row[] = [];
  const events: Ev[] = [];
  const deps = {
    interjection: buffer,
    sessionId: "race-session",
    store: {
      appendMessage: (_sid: string, row: Row) => {
        appended.push(row);
      },
    },
    callbacks: {
      onEvent: (ev: Ev) => {
        events.push(ev);
      },
    },
  } as unknown as LoopDeps;
  return { buffer, deps, appended, events };
}

describe("auto-background ↔ steer race (C-7 / 490)", () => {
  test("steer arriving while a command is backgrounded is admitted at the step boundary with a clear notice", () => {
    const { buffer, deps, appended, events } = harness();

    // A long shell command auto-backgrounded (pid 4321) and is still live.
    noteAutoBackground({ pid: 4321, backgroundedAtMs: 45_000, notice: "partial output" });
    // The mid-stream steer arrives while the command is in the background.
    buffer.push("show me the partial output");

    const delivered = drainInterjectionsAtSafePoint(deps, {} as never);
    expect(delivered).toBe(true);

    // The steer is admitted as a synthetic user message at THIS boundary.
    expect(appended).toHaveLength(1);
    expect(appended[0]!.role).toBe("user");
    expect(appended[0]!.content).toContain("show me the partial output");

    // A clear notice names the live pid and says the process was left running.
    const notice = events.find((e) => e.type === "notice");
    expect(notice).toBeDefined();
    expect(notice!.message).toContain("4321");
    expect(notice!.message).toContain("still running");
    expect(notice!.message).toContain("left running");
    expect(events.some((e) => e.type === "interjection.admitted")).toBe(true);

    // The background process was NOT killed/cleared by admitting the steer.
    expect(activeAutoBackgrounds().map((c) => c.pid)).toContain(4321);
  });

  test("without a backgrounded command the ordinary step-boundary notice is used", () => {
    const { buffer, deps, events } = harness();
    buffer.push("plain steer");
    expect(drainInterjectionsAtSafePoint(deps, {} as never)).toBe(true);
    const notice = events.find((e) => e.type === "notice");
    expect(notice!.message).toBe("mid-turn steer: delivered your message at a step boundary");
  });

  test("no pending steer does nothing", () => {
    const { deps, events } = harness();
    expect(drainInterjectionsAtSafePoint(deps, {} as never)).toBe(false);
    expect(events).toHaveLength(0);
  });
});
