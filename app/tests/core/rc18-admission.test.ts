/** RC-18 literal admitted-prompt event and fail-closed audit provenance (ruling 359). */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EventTypes } from "../../src/contracts";
import { createRuntime } from "../../src/core";
import { sha256Hex } from "../../src/core/canon";
import { verifySessionEventAnchorSync } from "../../src/core/chain-anchor-verify";
import { sessionEventsPath } from "../../src/core/session-kernel-reconcile";

function loadRows(file: string): Array<Record<string, any>> {
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

describe("RC-18 canonical prompt admission (ruling 359)", () => {
  test("a begun admission appends one hash-chained literal hz.session.prompt.admitted without plaintext", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-prompt-admitted-"));
    const runtime = await createRuntime({ workspace: ws, mock: true });
    try {
      await runtime.send("admit me now", { onEvent() {} });
      const file = sessionEventsPath(ws, runtime.sessionId);
      const admitted = loadRows(file).filter((row) => row.type === EventTypes.sessionPromptAdmitted);
      expect(admitted).toHaveLength(1);
      expect(admitted[0]?.payload?.sessionId).toBe(runtime.sessionId);
      expect(admitted[0]?.payload?.inputDigest).toBe(sha256Hex("admit me now"));
      expect(admitted[0]?.payload?.inputBytes).toBe(Buffer.byteLength("admit me now"));
      expect(typeof admitted[0]?.payload?.admissionId).toBe("string");
      expect(JSON.stringify(admitted)).not.toContain("admit me now");
      const anchor = verifySessionEventAnchorSync(ws, runtime.sessionId);
      expect(anchor.ok).toBe(true);
      expect(anchor.anchorAbsent).toBeFalsy();
    } finally {
      await runtime.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("a broken event anchor halts before provider dispatch rather than silently dropping audit admission", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-prompt-audit-break-"));
    const runtime = await createRuntime({ workspace: ws, mock: true });
    try {
      const file = sessionEventsPath(ws, runtime.sessionId);
      const rowsBefore = loadRows(file);
      writeFileSync(file + ".head", JSON.stringify({ seq: 1_000_000, hash: "0".repeat(64) }));
      const events: string[] = [];
      const result = await runtime.send("should not reach model", {
        onEvent(ev) { events.push(ev.type); },
      });
      expect(result.exit.terminal).toBe("failed");
      expect(events).not.toContain("assistant.done");
      expect(loadRows(file)).toHaveLength(rowsBefore.length);
      expect(verifySessionEventAnchorSync(ws, runtime.sessionId).ok).toBe(false);
    } finally {
      await runtime.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
