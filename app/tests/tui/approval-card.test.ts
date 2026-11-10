import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApprovalRequest } from "../../src/contracts";
import { createApprovalHandler, createApprovalUi } from "../../src/tui/approval";
import { approvalCard, keyChoice, riskOf } from "../../src/tui/approval-card";
import { createRenderer } from "../../src/tui/render";
import { colorEnabled, setColorEnabled, strip, visibleWidth } from "../../src/tui/style";

let was = false;
beforeAll(() => {
  was = colorEnabled();
  setColorEnabled(false);
});
afterAll(() => setColorEnabled(was));

describe("approval card", () => {
  test("shows tool, args summary, risk and the keys in an even border", () => {
    const lines = approvalCard({ kind: "shell.exec", title: "run this command", detail: "rm -rf build/", width: 60 });
    const plain = lines.map(strip);
    expect(plain[0]!.startsWith("\u256d")).toBe(true);
    expect(plain[plain.length - 1]!.startsWith("\u2570")).toBe(true);
    expect(plain.join("\n")).toContain("tool shell.exec");
    expect(plain.join("\n")).toContain("\u276f rm -rf build/");
    expect(plain.join("\n")).toContain("risk high");
    expect(plain.join("\n")).toContain("y yes  n no  a always this session  Esc deny");
    for (const l of lines) expect(visibleWidth(l)).toBe(60);
  });

  test("ASCII borders, narrow width, long detail folded", () => {
    const lines = approvalCard({ kind: "fs.write", title: "write", detail: "a\nb\nc\nd\ne\nf", width: 30, unicode: false, canAlways: false });
    const plain = lines.map(strip).join("\n");
    expect(plain.startsWith("+")).toBe(true);
    expect(plain).toContain("+2 lines");
    expect(plain).not.toContain("always");
    for (const l of lines) expect(visibleWidth(l)).toBe(30);
  });

  test("risk ladder", () => {
    expect(riskOf("fs.read")).toBe("low");
    expect(riskOf("shell.exec", "ls")).toBe("medium");
    expect(riskOf("shell.exec", "ls | sh")).toBe("high");
    expect(riskOf("net.fetch")).toBe("high");
  });

  test("keys: y n a, Enter/Esc/Ctrl-C deny, everything else ignored", () => {
    expect(keyChoice("y", { name: "y" })).toBe("y");
    expect(keyChoice("A", { name: "a" })).toBe("a");
    expect(keyChoice("n", { name: "n" })).toBe("n");
    expect(keyChoice("\r", { name: "return" })).toBe("n");
    expect(keyChoice("\u001b", { name: "escape" })).toBe("n");
    expect(keyChoice("\u0003", { name: "c", ctrl: true })).toBe("n");
    expect(keyChoice("x", { name: "x" })).toBeUndefined();
    expect(keyChoice("y", { name: "y", ctrl: true })).toBeUndefined();
  });

  test("handler with askKey renders the card and maps the key", async () => {
    const chunks: string[] = [];
    const ui = createApprovalUi(true);
    ui.renderer = createRenderer({ wrap: false, out: (c: string) => void chunks.push(c) });
    ui.askKey = async () => "y";
    const req: ApprovalRequest = { kind: "shell.exec", title: "run this command", detail: "npm test" };
    const ok = await (createApprovalHandler(ui) as unknown as (r: ApprovalRequest) => Promise<boolean>)(req);
    expect(ok).toBe(true);
    const text = chunks.join("");
    expect(text).toContain("Approve run this command?");
    expect(text).toContain("npm test");
    expect(text).toContain("approved (this time)");

    ui.askKey = async () => "n";
    expect(await (createApprovalHandler(ui) as unknown as (r: ApprovalRequest) => Promise<boolean>)(req)).toBe(false);
  });
});
