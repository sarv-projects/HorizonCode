import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EventTypes, nowIso } from "../../src/contracts";
import {
  deriveShellEffectTerminalView,
  formatShellEffectTerminalLines,
  parseShellExitCodeFromToolOutput,
} from "../../src/core/receipt-shell-terminal";
import type { EffectRecord } from "../../src/core/effect-host";
import { kernelStateDir } from "../../src/core/paths";
import { sessionEventsPath } from "../../src/core/session-kernel-reconcile";

describe("receipt-shell-terminal (ruling 292)", () => {
  test("parseShellExitCodeFromToolOutput reads codex-shaped and legacy tails", () => {
    expect(parseShellExitCodeFromToolOutput("Exit code: 0\nOutput:\nhi")).toBe(0);
    expect(parseShellExitCodeFromToolOutput("body\nexit 2")).toBe(2);
    expect(parseShellExitCodeFromToolOutput("no exit")).toBe(undefined);
  });

  test("deriveShellEffectTerminalView for shell effect with session log exit", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-shell-term-"));
  const sessionId = "sess-shell-term";
    try {
      const eventsDir = path.join(kernelStateDir(ws), "events");
      mkdirSync(eventsDir, { recursive: true });
      const record: EffectRecord = {
        effectId: "eff-1",
        tool: "shell",
        callId: "call-1",
        steps: [{ phase: "execute", at: nowIso(), ok: true }],
      };
      const output = "Exit code: 1\nOutput:\nfail\n";
      writeFileSync(
        sessionEventsPath(ws, sessionId),
        `${JSON.stringify({
          type: EventTypes.toolResult,
          seq: 1,
          payload: { callId: "call-1", effectId: "eff-1", name: "shell", ok: false, output },
        })}\n`,
        "utf8",
      );
      const view = deriveShellEffectTerminalView(record, { workspace: ws, sessionId });
      expect(view?.capabilityId).toBe("terminal.run");
      expect(view?.exitCode).toBe(1);
      expect(view?.processOutcome).toBe("failed");
      const lines = formatShellEffectTerminalLines(view!);
      expect(lines.some((l) => l.includes("terminal.run"))).toBe(true);
      expect(lines.some((l) => l.includes("RC-7 run terminal"))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
