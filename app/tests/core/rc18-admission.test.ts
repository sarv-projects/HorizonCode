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

  test("send appends hz.session.checkpoint.created for the turn (443)", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-ckpt-evt-"));
    const runtime = await createRuntime({ workspace: ws, mock: true });
    try {
      await runtime.send("checkpoint please", { onEvent() {} });
      const file = sessionEventsPath(ws, runtime.sessionId);
      const created = loadRows(file).filter((row) => row.type === EventTypes.sessionCheckpointCreated);
      expect(created.length).toBeGreaterThanOrEqual(1);
      expect(typeof created[0]?.payload?.checkpointId).toBe("string");
      expect(typeof created[0]?.payload?.labelDigest).toBe("string");
      expect(verifySessionEventAnchorSync(ws, runtime.sessionId).ok).toBe(true);
    } finally {
      await runtime.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("send brackets a turn with claim then busy then release (439/440)", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-busy-bracket-"));
    const runtime = await createRuntime({ workspace: ws, mock: true });
    try {
      await runtime.send("busy bracket please", { onEvent() {} });
      const file = sessionEventsPath(ws, runtime.sessionId);
      const rows = loadRows(file);
      const acquired = rows.filter((row) => row.type === EventTypes.sessionClaimAcquired);
      const entered = rows.filter((row) => row.type === EventTypes.sessionBusyEntered);
      const left = rows.filter((row) => row.type === EventTypes.sessionBusyLeft);
      const released = rows.filter((row) => row.type === EventTypes.sessionClaimReleased);
      expect(acquired).toHaveLength(1);
      expect(entered).toHaveLength(1);
      expect(left).toHaveLength(1);
      expect(released).toHaveLength(1);
      const claimId = acquired[0]?.payload?.claimId;
      expect(typeof claimId).toBe("string");
      expect(entered[0]?.payload?.claimId).toBe(claimId);
      expect(left[0]?.payload?.claimId).toBe(claimId);
      expect(released[0]?.payload?.claimId).toBe(claimId);
      expect(left[0]?.payload?.terminal).toBe("succeeded");
      expect(released[0]?.payload?.reason).toBe("succeeded");
      const order = [
        EventTypes.sessionClaimAcquired,
        EventTypes.sessionBusyEntered,
        EventTypes.sessionBusyLeft,
        EventTypes.sessionClaimReleased,
      ].map((t) => rows.findIndex((row) => row.type === t));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect(order[0]!).toBeLessThan(order[1]!);
      expect(order[1]!).toBeLessThan(order[2]!);
      expect(order[2]!).toBeLessThan(order[3]!);
      expect(verifySessionEventAnchorSync(ws, runtime.sessionId).ok).toBe(true);
    } finally {
      await runtime.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("slash skill activation appends hz.skill.invoked", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-skill-invoked-"));
    const runtime = await createRuntime({ workspace: ws, mock: true });
    try {
      await runtime.send("/execute-plan run phase one", { onEvent() {} });
      const file = sessionEventsPath(ws, runtime.sessionId);
      const invoked = loadRows(file).filter((row) => row.type === EventTypes.skillInvoked);
      expect(invoked).toHaveLength(1);
      expect(invoked[0]?.payload?.skill).toBe("execute-plan");
      expect(invoked[0]?.payload?.sessionId).toBe(runtime.sessionId);
      expect(invoked[0]?.payload?.actionBytes).toBe(Buffer.byteLength("run phase one", "utf8"));
      const installed = loadRows(file).filter((row) => row.type === EventTypes.skillInstalled);
      expect(installed.some((row) => row.payload?.name === "execute-plan" && row.payload?.source === "synthesised")).toBe(
        true,
      );
    } finally {
      await runtime.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("first send announces hz.skill.installed once per skill (448)", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-skill-installed-"));
    const runtime = await createRuntime({ workspace: ws, mock: true });
    try {
      await runtime.send("hello", { onEvent() {} });
      await runtime.send("hello again", { onEvent() {} });
      const file = sessionEventsPath(ws, runtime.sessionId);
      const installed = loadRows(file).filter((row) => row.type === EventTypes.skillInstalled);
      const builtins = installed.filter((row) => row.payload?.name === "execute-plan");
      expect(builtins).toHaveLength(1);
      expect(builtins[0]?.payload?.source).toBe("synthesised");
      expect(builtins[0]?.payload?.status).toBe("installed");
      expect(typeof builtins[0]?.payload?.digest).toBe("string");
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
