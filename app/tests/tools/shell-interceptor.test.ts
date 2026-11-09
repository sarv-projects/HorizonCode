/**
 * shell-interceptor.test.ts — NF-074(d): the configurable bash interceptor rule
 * table in shell.ts, ported from oh-my-pi's bash-interceptor.
 *
 * Covers candidate derivation (whole command, per flat segment, env-assignment
 * stripped), quote/escape-aware tokenization, incomplete syntax handled safely,
 * the piped-stdin exemption, tool-availability gating, and the PRESERVED
 * cat->read interception. Every assertion here fails if the interceptor is
 * reverted to the hard-coded cat->read-only classifier.
 */

import { describe, expect, test } from "bun:test";
import {
  checkBashInterception,
  classifyShellCommand,
  extractFlatShellCommandSegments,
  interceptionCandidates,
  shellTool,
  type BashInterceptorRule,
} from "../../src/tools/shell";
import { mockToolContext } from "./helpers";

const ALL = ["read", "write", "edit", "grep", "glob", "shell", "todo"];

describe("interceptionCandidates (candidate derivation)", () => {
  test("includes the whole trimmed command", () => {
    expect(interceptionCandidates("  grep foo file  ")).toContain("grep foo file");
  });

  test("includes each flat shell segment that is not piped-stdin", () => {
    const candidates = interceptionCandidates("ls -la; grep foo file");
    expect(candidates).toContain("ls -la");
    expect(candidates).toContain("grep foo file");
  });

  test("includes an env-assignment-stripped candidate for a leading NAME=value", () => {
    const candidates = interceptionCandidates("FOO=bar grep needle file");
    // The whole command and the segment keep the assignment...
    expect(candidates).toContain("FOO=bar grep needle file");
    // ...and the env-stripped candidate exposes the real head for rule matching.
    expect(candidates).toContain("grep needle file");
  });

  test("a piped-stdin segment is NOT a candidate (no path tool replaces `| grep`)", () => {
    const candidates = interceptionCandidates("cat x | grep y");
    expect(candidates).toContain("cat x | grep y"); // whole command still present
    expect(candidates).toContain("cat x"); // the first stage is a candidate
    expect(candidates).not.toContain("grep y"); // the piped stage is exempt
  });

  test("a first-stage / standalone pipe producer is still a candidate", () => {
    // The producer side of a pipe does not read piped stdin, so it is a candidate.
    const candidates = interceptionCandidates("grep y file | sort");
    expect(candidates).toContain("grep y file");
  });
});

describe("extractFlatShellCommandSegments (quote/escape-aware, incomplete-safe)", () => {
  test("a quoted operator character does not split a segment", () => {
    // The `;` and `|` live inside quotes, so this is one flat segment.
    const segments = extractFlatShellCommandSegments("echo 'a; b | c'");
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe("echo 'a; b | c'");
    expect(segments[0]?.pipedStdin).toBe(false);
  });

  test("an escaped separator does not split a segment", () => {
    const segments = extractFlatShellCommandSegments("echo a\\; b");
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe("echo a\\; b");
  });

  test("a real pipe marks the downstream segment pipedStdin, `&&` does not", () => {
    const piped = extractFlatShellCommandSegments("cat x | grep y");
    expect(piped.map((s) => s.pipedStdin)).toEqual([false, true]);
    const anded = extractFlatShellCommandSegments("cat x && grep y");
    expect(anded.map((s) => s.pipedStdin)).toEqual([false, false]);
  });

  test("incomplete/undetermined syntax returns [] (declines to split)", () => {
    expect(extractFlatShellCommandSegments("echo 'unterminated")).toEqual([]); // open quote
    expect(extractFlatShellCommandSegments("echo $(grep y file)")).toEqual([]); // command substitution
    expect(extractFlatShellCommandSegments("echo `grep y`")).toEqual([]); // backticks
    expect(extractFlatShellCommandSegments("echo trailing\\")).toEqual([]); // dangling escape
  });

  test("whole command stays a candidate even when segmentation declines", () => {
    // Command substitution makes segmentation bail, but the whole-command
    // candidate still lets a rule match the outer `grep`.
    const candidates = interceptionCandidates("grep y $(echo file)");
    expect(candidates).toEqual(["grep y $(echo file)"]);
  });
});

describe("checkBashInterception (rule table + availability gating)", () => {
  test("grep is intercepted toward the grep tool when grep is available", () => {
    const rule = checkBashInterception("grep needle file", ALL);
    expect(rule?.tool).toBe("grep");
  });

  test("find with a predicate is intercepted toward the glob tool", () => {
    const rule = checkBashInterception("find . -name '*.ts'", ALL);
    expect(rule?.tool).toBe("glob");
  });

  test("the env-stripped candidate matches (FOO=bar grep ...)", () => {
    const rule = checkBashInterception("FOO=bar grep needle file", ALL);
    expect(rule?.tool).toBe("grep");
  });

  test("a rule fires only when its target tool is available", () => {
    // grep tool absent -> transparent, even though the pattern matches.
    expect(checkBashInterception("grep needle file", ["read", "write", "edit", "glob"])).toBeNull();
    // glob tool absent -> find is transparent.
    expect(checkBashInterception("find . -name x", ["read", "grep"])).toBeNull();
  });

  test("a piped-stdin grep is NOT intercepted toward a path-based tool", () => {
    // The only grep here reads piped stdin; no candidate exposes it.
    expect(checkBashInterception("cat x | grep y", ALL)).toBeNull();
  });

  test("a non-matching command is transparent", () => {
    expect(checkBashInterception("echo hello", ALL)).toBeNull();
    expect(checkBashInterception("git status", ALL)).toBeNull();
  });

  test("invalid-regex rules are skipped at compile (no throw)", () => {
    const rules: BashInterceptorRule[] = [
      { pattern: "(", tool: "grep", message: "bad" },
      { pattern: "^\\s*grep\\s+", tool: "grep", message: "good" },
    ];
    const rule = checkBashInterception("grep x file", ALL, rules);
    expect(rule?.message).toBe("good");
  });
});

describe("classifyShellCommand (rule table wired in, existing paths preserved)", () => {
  test("grep classifies as intercept-suggest toward the grep tool", () => {
    expect(classifyShellCommand("grep needle file")).toEqual({
      action: "intercept-suggest",
      tool: "grep",
      message: expect.stringContaining("`grep` tool"),
    });
  });

  test("find -name classifies as intercept-suggest toward the glob tool", () => {
    const plan = classifyShellCommand("find . -type f -name '*.ts'");
    expect(plan).toEqual({ action: "intercept-suggest", tool: "glob", message: expect.stringContaining("`glob` tool") });
  });

  test("a rule is transparent when its tool is not in availableTools", () => {
    // Thread a registry view without grep/glob: the command runs.
    expect(classifyShellCommand("grep needle file", false, ["read", "write"])).toEqual({ action: "run" });
    expect(classifyShellCommand("find . -name x", false, ["read", "write"])).toEqual({ action: "run" });
  });

  test("PRESERVED: cat with a single plain operand still intercepts to read", () => {
    expect(classifyShellCommand("cat f.txt")).toEqual({ action: "intercept-read", path: "f.txt" });
    expect(classifyShellCommand("VAR=1 cat f.txt")).toEqual({ action: "intercept-read", path: "f.txt" });
    expect(classifyShellCommand("timeout 5 cat x")).toEqual({ action: "intercept-read", path: "x" });
  });

  test("PRESERVED: cat with a metacharacter operand runs (not refused, not suggested)", () => {
    // The SHELL_METACHARACTER guard keeps the dynamic operand as the shell's job,
    // and the rule table (which has no cat rule) must not claim it either.
    expect(classifyShellCommand("cat *.txt")).toEqual({ action: "run" });
    expect(classifyShellCommand("cat $HOME/f")).toEqual({ action: "run" });
  });

  test("PRESERVED: multi-operand cat and plain tail still run", () => {
    expect(classifyShellCommand("cat a b")).toEqual({ action: "run" });
    expect(classifyShellCommand("tail -n 5 file.txt")).toEqual({ action: "run" });
  });

  test("PRESERVED: interactive, tail -f and REPL refusals win over the rule table", () => {
    expect(classifyShellCommand("vim f.txt").action).toBe("refuse");
    expect(classifyShellCommand("tail -f log").action).toBe("refuse");
    expect(classifyShellCommand("python").action).toBe("refuse");
  });
});

describe("the shell tool surfaces an intercept-suggest without running or Guarding", () => {
  test("`grep` returns the rule message naming the grep tool, before Guard", async () => {
    const ctx = mockToolContext();
    const r = await shellTool.execute({ command: "grep needle file.txt" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("`grep` tool");
    expect(r.error).toContain("Original command: grep needle file.txt");
    expect(ctx.guardCalls.length).toBe(0); // blocked before Guard, nothing spawned
  });

  test("a piped-stdin grep is NOT suggested and runs normally through Guard", async () => {
    const ctx = mockToolContext();
    const r = await shellTool.execute({ command: "echo hi | grep hi" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("hi");
    expect(ctx.guardCalls.length).toBe(1);
    expect(ctx.guardCalls[0]?.kind).toBe("shell.exec");
  });
});
