import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EffectHost } from "../../src/core/effect-host";
import {
  RUN_COMPLETE_EVENT,
  buildRunCompletePayload,
  captureTerminalRunCapabilitySnapshot,
} from "../../src/core/receipt-run-terminal";
import { kernelStateDir } from "../../src/core/paths";
import { sessionEventsPath } from "../../src/core/session-kernel-reconcile";
import { buildReceiptInspectorModel, formatReceiptInspectorScrollbackLines } from "../../src/tui/receipt-inspector";

describe("receipt inspector (ruling 284)", () => {
  test("structured panes include effect, receipt, postimage, chain", () => {
    const host = new EffectHost();
    const id = "00000000-0000-4000-8000-0000000000ee";
    host.begin(id, "write", "call-x");
    host.recordAllow(id, { leaseId: "lease-1" });
    host.recordExecute(id, { ok: true });
    host.recordObserve(id, {
      receiptId: "rcpt-1",
      receiptSeq: 3,
      postimageDigest: "d".repeat(64),
      postimageObservationStable: true,
      resourceKey: "/tmp/ws/foo.txt",
    });
    const record = host.getRecord(id)!;
    const receipt = {
      id: "rcpt-1",
      seq: 3,
      ts: "2026-01-01T00:00:00.000Z",
      prevHash: "prev",
      hash: "hash",
      action: "tool.execute",
      tool: "write",
      argsDigest: "a".repeat(64),
      resultDigest: "b".repeat(64),
      effectId: id,
      postimagePath: "/tmp/ws/foo.txt",
      postimageDigest: "d".repeat(64),
    };
    const model = buildReceiptInspectorModel({ record, receipt, sessionId: "sess-9" });
    expect(model).toBeDefined();
    expect(model!.panes.map((p) => p.id)).toEqual([
      "effect",
      "receipt",
      "postimage",
      "chain",
      "children",
      "verify",
    ]);
    const lines = formatReceiptInspectorScrollbackLines(model!);
    expect(lines.some((l) => l.includes("── Effect record ──"))).toBe(true);
    expect(lines.some((l) => l.includes("── Receipt summary ──"))).toBe(true);
    expect(lines.some((l) => l.includes("postimageDigest"))).toBe(true);
    expect(lines.some((l) => l.includes("prevHash"))).toBe(true);
    expect(lines.some((l) => l.includes("Terminal (run)"))).toBe(true);
  });

  test("child receipt pane lists linked child receipts", () => {
    const child = "00000000-0000-4000-8000-0000000000cc";
    const record = {
      effectId: "00000000-0000-4000-8000-0000000000aa",
      tool: "agent",
      callId: "c-agent",
      steps: [
        { phase: "execute" as const, at: "2026-01-01T00:00:00.000Z", ok: true, childEffectIds: [child] },
      ],
    };
    const modelWs = buildReceiptInspectorModel({
      record,
      receipt: {
        id: "r1",
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        prevHash: null,
        hash: "h",
        action: "tool.execute",
        tool: "agent",
        argsDigest: "a",
        resultDigest: "b",
        childEffectIds: [child],
      },
      workspace: "/tmp/ws-child-pane",
      sessionId: "parent-sess",
    });
    const pane = modelWs!.panes.find((p) => p.id === "children");
    expect(pane?.lines.some((l) => l.includes(child))).toBe(true);
    expect(pane?.lines.some((l) => l.includes("agent.spawn"))).toBe(true);
    expect(pane?.lines.some((l) => l.includes("nested receipt replay:"))).toBe(true);
    expect(pane?.lines.some((l) => l.includes("nested event-stream replay:"))).toBe(true);
  });

  test("run terminal pane surfaces provider failure code from run.complete", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-rcpt-fail-"));
    const sessionId = "sess-provider-fail";
    mkdirSync(path.join(kernelStateDir(workspace), "events"), { recursive: true });
    const snap = captureTerminalRunCapabilitySnapshot({ cols: 80, rows: 24, shellSessionOpen: 0 });
    const payload = buildRunCompletePayload(
      { terminal: "failed", detail: "provider_error" },
      snap,
      { providerFailureCode: "RATE_LIMIT" },
    );
    writeFileSync(
      sessionEventsPath(workspace, sessionId),
      `${JSON.stringify({ type: RUN_COMPLETE_EVENT, payload })}\n`,
      "utf8",
    );
    const record = {
      effectId: "eff-read",
      tool: "read",
      callId: "c-read",
      steps: [{ phase: "execute", at: "2026-01-01T00:00:00.000Z", ok: true }],
    };
    const model = buildReceiptInspectorModel({ record, workspace, sessionId });
    const runTerm = model?.panes.find((p) => p.id === "run_terminal");
    expect(runTerm?.lines.some((l) => l.includes("provider failure code RATE_LIMIT"))).toBe(true);
  });

  test("shell effect adds terminal pane with capability and exit", () => {
    const record = {
      effectId: "eff-shell",
      tool: "shell",
      callId: "c-shell",
      steps: [{ phase: "execute", at: "2026-01-01T00:00:00.000Z", ok: true }],
    };
    const model = buildReceiptInspectorModel({ record });
    expect(model!.panes.some((p) => p.id === "terminal")).toBe(true);
    const term = model!.panes.find((p) => p.id === "terminal");
    expect(term?.lines.some((l) => l.includes("terminal.run"))).toBe(true);
  });
});
