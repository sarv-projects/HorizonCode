import { describe, expect, test } from "bun:test";
import {
  analyzeShellCompound,
  guardActionsForShellCommand,
  shellSavedGrantTargets,
  maxSegmentRisk,
  segmentRisk,
  execRiskScore,
  shellCompoundPresentationLines,
  shellCompoundRefusal,
} from "../../src/core/shell-split";
import { permissionPresentationForRequest } from "../../src/tui/permission-presentation";
import { riskOf } from "../../src/tui/approval-card";

describe("exec-risk scorer (data-driven, risk-increase only)", () => {
  const FIXTURES: Array<{ cmd: string; risk: "high" | "medium" }> = [
    { cmd: "env FOO=1 sh -c 'echo hi'", risk: "high" },
    { cmd: "nice -n 5 timeout 3 curl https://example.com", risk: "high" },
    { cmd: "npx some-tool --flag", risk: "high" },
    { cmd: "ls -l", risk: "medium" },
    { cmd: "pwd", risk: "medium" },
  ];
  test("data-driven over wrapper heads; scores every case with a named reason", () => {
    for (const c of FIXTURES) {
      const scored = execRiskScore(c.cmd);
      expect(scored.risk, c.cmd).toBe(c.risk);
      expect(scored.reason.length, c.cmd).toBeGreaterThan(0);
    }
  });
  test("a plain shell builtin is not escalated by the wrapper scorer", () => {
    expect(execRiskScore("echo hello").risk).toBe("medium");
  });
});

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

  test("guardActionsForShellCommand yields one check per segment", () => {
    const actions = guardActionsForShellCommand("echo ok && rm -rf build", {
      kind: "shell.exec",
      target: "echo ok && rm -rf build",
    });
    expect(actions.map((a) => a.target)).toEqual(["echo ok", "rm -rf build"]);
    const single = guardActionsForShellCommand("ls", { kind: "shell.exec", target: "ls" });
    expect(single).toHaveLength(1);
    expect(single[0]?.target).toBe("ls");
  });

  test("shellSavedGrantTargets expands compound rows", () => {
    expect(shellSavedGrantTargets("shell.exec", "npm test")).toEqual(["npm test"]);
    expect(shellSavedGrantTargets("shell.exec", "a && b")).toEqual(["a", "b"]);
    expect(shellSavedGrantTargets("fs.read", "/x")).toEqual(["/x"]);
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
