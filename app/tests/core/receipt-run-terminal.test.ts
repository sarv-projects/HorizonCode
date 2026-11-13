import { describe, expect, test } from "bun:test";
import {
  RUN_COMPLETE_EVENT,
  buildRunCompletePayload,
  captureTerminalRunCapabilitySnapshot,
  formatRunTerminalCapabilityLines,
  latestRunCompleteFromEvents,
} from "../../src/core/receipt-run-terminal";

describe("receipt-run-terminal (ruling 298)", () => {
  test("captures terminal.run capability geometry", () => {
    const snap = captureTerminalRunCapabilitySnapshot({
      cols: 100,
      rows: 40,
      stdinIsTTY: true,
      stdoutIsTTY: false,
      shellSessionOpen: 2,
    });
    expect(snap.capabilityId).toBe("terminal.run");
    expect(snap.cols).toBe(100);
    expect(snap.rows).toBe(40);
    expect(snap.shellSessionOpen).toBe(2);
    const lines = formatRunTerminalCapabilityLines(snap, { terminal: "failed", detail: "format_errors" });
    expect(lines.some((l) => l.includes("RC-7 terminal failed"))).toBe(true);
    expect(lines.some((l) => l.includes("100x40"))).toBe(true);
  });

  test("latestRunCompleteFromEvents picks newest run.complete", () => {
    const snap = captureTerminalRunCapabilitySnapshot({ cols: 80, rows: 24, shellSessionOpen: 0 });
    const payload = buildRunCompletePayload({ terminal: "succeeded", detail: "turn_end" }, snap);
    const events = [
      {
        type: RUN_COMPLETE_EVENT,
        payload: { exit: { terminal: "failed", detail: "steps" }, terminalRunCapability: snap },
      },
      { type: RUN_COMPLETE_EVENT, payload },
    ];
    const latest = latestRunCompleteFromEvents(events);
    expect(latest?.exit.terminal).toBe("succeeded");
    expect(latest?.terminalRunCapability.cols).toBe(80);
  });
});
