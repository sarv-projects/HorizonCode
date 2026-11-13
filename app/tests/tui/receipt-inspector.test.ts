import { describe, expect, test } from "bun:test";
import { EffectHost } from "../../src/core/effect-host";
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
