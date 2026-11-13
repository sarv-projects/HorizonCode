import { describe, expect, test } from "bun:test";
import {
  analyzeShellCompound,
  maxSegmentRisk,
  segmentRisk,
  shellCompoundPresentationLines,
  shellCompoundRefusal,
} from "../../src/core/shell-split";
import { permissionPresentationForRequest } from "../../src/tui/permission-presentation";
import { riskOf } from "../../src/tui/approval-card";

describe("shell compound split", () => {
  test("splits && outside quotes", () => {
    const a = analyzeShellCompound("echo ok && rm -rf build");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.compound).toBe(true);
    expect(a.segments.map((s) => s.text)).toEqual(["echo ok", "rm -rf build"]);
    expect(a.segments[1]!.joiner).toBe("&&");
    expect(["medium", "high"]).toContain(a.segments[1]!.risk);
  });

  test("keeps quoted operators as one segment", () => {
    const a = analyzeShellCompound("echo 'a&&b'");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.compound).toBe(false);
    expect(a.segments).toHaveLength(1);
  });

  test("fail closed on substitution", () => {
    expect(analyzeShellCompound("echo $(whoami)").ok).toBe(false);
    expect(shellCompoundRefusal("echo $(whoami)")).toContain("HZ_PRECONDITION_FAILED");
  });

  test("presentation lists segments", () => {
    const lines = shellCompoundPresentationLines(analyzeShellCompound("ls && pwd"));
    expect(lines.some((l) => l.includes("compound command"))).toBe(true);
    expect(lines.some((l) => l.includes("[medium]"))).toBe(true);
  });

  test("approval risk uses worst segment", () => {
    expect(riskOf("shell.exec", "true && sudo reboot")).toBe("high");
    expect(maxSegmentRisk([{ text: "ls", risk: "medium" }, { text: "pwd", risk: "low" }])).toBe("medium");
    expect(segmentRisk("ls")).toBe("medium");
  });

  test("permission presentation adds compound lines", () => {
    const pres = permissionPresentationForRequest(
      { kind: "shell.exec", title: "run", detail: "echo hi && rm -rf x" },
      "/ws",
    );
    expect(pres.title).toContain("compound");
    expect(pres.lines.join("\n")).toContain("per segment");
  });
});
