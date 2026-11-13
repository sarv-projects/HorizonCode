import { describe, expect, test } from "bun:test";
import { EffectHost } from "../../src/core/effect-host";
import { collectUnknownEffectRows } from "../../src/core/effect-unknown-list";
import { formatUnknownInspectorLines, formatReceiptChainInspectLines } from "../../src/tui/unknown-inspector";
import { runUnknownCommand } from "../../src/tui/unknown-slash";
import { parseUnknownSlashArgs } from "../../src/tui/unknown-slash-parse";
import type { Runtime } from "../../src/contracts";
import { createRenderer } from "../../src/tui/render";
import { strip } from "../../src/tui/style";

describe("unknown inspector (ruling 264)", () => {
  test("collectUnknownEffectRows lists only unresolved effects", () => {
    const host = new EffectHost();
    const idSettled = "00000000-0000-4000-8000-000000000001";
    const idOpen = "00000000-0000-4000-8000-000000000002";
    host.begin(idSettled, "read", "call-a");
    host.recordAllow(idSettled);
    host.recordExecute(idSettled, { ok: true });
    host.recordObserve(idSettled, { receiptId: "r1", receiptSeq: 1 });
    host.begin(idOpen, "write", "call-b");
    host.recordAllow(idOpen);
    host.recordExecute(idOpen, { ok: true });
    const rows = collectUnknownEffectRows(host);
    expect(rows.map((r) => r.effectId)).toEqual([idOpen]);
    expect(rows[0]?.tool).toBe("write");
  });

  test("formatUnknownInspectorLines prints header and rows", () => {
    const lines = formatUnknownInspectorLines([
      { effectId: "eff-aaaa-bbbb-cccc", tool: "edit", callId: "c1", receiptId: "rcpt-9" },
    ]);
    expect(lines[0]).toContain("1 unreconciled");
    expect(lines[1]).toContain("eff-aaaa-bbbb-cccc");
    expect(lines[1]).toContain("edit");
    expect(lines[1]).toContain("rcpt-9");
    expect(lines.some((l) => l.includes("/unknown inspect"))).toBe(true);
  });

  test("parseUnknownSlashArgs", () => {
    expect(parseUnknownSlashArgs("")).toEqual({ kind: "list" });
    expect(parseUnknownSlashArgs("reconcile")).toEqual({ kind: "reconcile", probe: false });
    expect(parseUnknownSlashArgs("reconcile --probe")).toEqual({ kind: "reconcile", probe: true });
    expect(parseUnknownSlashArgs("status")).toEqual({ kind: "status" });
    expect(parseUnknownSlashArgs("export")).toEqual({ kind: "export" });
    expect(parseUnknownSlashArgs("release")).toEqual({ kind: "release" });
    expect(parseUnknownSlashArgs("clear")).toEqual({ kind: "release" });
    expect(parseUnknownSlashArgs("inspect eff-1")).toEqual({ kind: "inspect", target: "eff-1" });
  });

  test("formatReceiptChainInspectLines uses structured panes", () => {
    const host = new EffectHost();
    const id = "00000000-0000-4000-8000-000000000088";
    host.begin(id, "edit", "c2");
    const lines = formatReceiptChainInspectLines({ record: host.getRecord(id) });
    expect(lines.some((l) => l.includes("── Effect record ──"))).toBe(true);
  });

  test("runUnknownCommand prints via renderer", () => {
    const chunks: string[] = [];
    const renderer = createRenderer({ wrap: false, out: (c) => void chunks.push(c) });
    const host = new EffectHost();
    const id = "00000000-0000-4000-8000-000000000099";
    host.begin(id, "shell", "call-z");
    const rt = {
      sessionId: "s",
      unknownEffects: () => collectUnknownEffectRows(host),
    } as unknown as Runtime;
    runUnknownCommand(rt, renderer);
    const text = strip(chunks.join(""));
    expect(text).toContain(id);
    expect(text).toContain("shell");
  });
});
