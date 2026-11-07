/**
 * shell-minimiser.test.ts — NF-074(c)/(d): the shell-output minimiser and
 * dedicated-tool interception. Bytes stay byte-identical when nothing needs
 * minimising; the flag appears exactly when something was minimised.
 */

import { describe, expect, test } from "bun:test";
import { classifyShellCommand, minimiseShellOutput, shellTool } from "../../src/tools/shell";
import { makeWorkspace, mockToolContext, readFixture } from "./helpers";

describe("classifyShellCommand (byte-stable decisions)", () => {
  test("ordinary commands run", () => {
    for (const command of ["echo hi", "git status", "ls -la", "sleep 1", "cat a b", "python3 -c 'print(1)'", "python3 script.py", "node app.js", "tail -n 5 file.txt"]) {
      expect(classifyShellCommand(command)).toEqual({ action: "run" });
    }
  });

  test("`cat <file>` (exactly one plain argument) intercepts to the read tool", () => {
    expect(classifyShellCommand("cat f.txt")).toEqual({ action: "intercept-read", path: "f.txt" });
    expect(classifyShellCommand("/bin/cat f.txt")).toEqual({ action: "intercept-read", path: "f.txt" });
    expect(classifyShellCommand("VAR=1 cat f.txt")).toEqual({ action: "intercept-read", path: "f.txt" });
  });

  test("terminal programs and forever-streams are refused, with the override named", () => {
    for (const command of ["vim f.txt", "less log", "nano x", "top", "watch ls", "tail -f log", "tail -n50 -f log"]) {
      const plan = classifyShellCommand(command);
      expect(plan.action).toBe("refuse");
    }
    for (const command of ["python", "python3 -i", "node", "irb"]) {
      expect(classifyShellCommand(command).action).toBe("refuse");
    }
  });

  test("the override env bypasses the blocklist, never the interception classifier's honesty", () => {
    expect(classifyShellCommand("vim f.txt", true)).toEqual({ action: "run" });
    expect(classifyShellCommand("cat f.txt", true)).toEqual({ action: "run" });
  });
});

describe("minimiseShellOutput", () => {
  test("plain text is returned unchanged (changed:false)", () => {
    expect(minimiseShellOutput("hello\nworld\n")).toEqual({ text: "hello\nworld\n", changed: false });
  });

  test("ANSI/OSC sequences and control characters are stripped", () => {
    expect(minimiseShellOutput("\u001b[31mred\u001b[0m").text).toBe("red");
    expect(minimiseShellOutput("\u001b]0;title\u0007text").text).toBe("text");
    expect(minimiseShellOutput("a\u0007b").text).toBe("ab");
  });

  test("carriage-return progress lines settle to their final state", () => {
    expect(minimiseShellOutput("aaa\rbbb\rccc\n").text).toBe("ccc\n");
  });

  test("trailing whitespace and blank runs collapse", () => {
    expect(minimiseShellOutput("x  \ny\t \n").text).toBe("x\ny\n");
    expect(minimiseShellOutput("a\n\n\n\n\nb").text).toBe("a\n\nb");
  });
});

describe("the shell tool applies both", () => {
  test("plain output stays byte-identical with no flag", async () => {
    const r = await shellTool.execute({ command: "echo plain" }, mockToolContext());
    expect(r.ok).toBe(true);
    expect(r.output).toBe("plain\nexit 0");
  });

  test("ANSI output is minimised and flagged as minimised", async () => {
    const r = await shellTool.execute(
      { command: "printf '\\033[31mred\\033[0m plain\\n'" },
      mockToolContext(),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("red plain");
    expect(r.output).not.toContain("\u001b");
    expect(r.output).toContain("[output minimised:");
    expect(r.output.endsWith("exit 0")).toBe(true);
  });

  test("a carriage-return progress line is settled before the model sees it", async () => {
    const r = await shellTool.execute({ command: "printf 'aaa\\rbbb\\rccc\\n'" }, mockToolContext());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("ccc");
    expect(r.output).not.toContain("aaa");
    expect(r.output).toContain("[output minimised:");
  });

  test("`cat f.txt` maps to the read tool with a visible notice and an fs.read admission", async () => {
    const ws = makeWorkspace({ "f.txt": "hello from the file\n" });
    const ctx = mockToolContext({ cwd: ws });
    const r = await shellTool.execute({ command: "cat f.txt" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output.startsWith("[intercepted: cat f.txt \u2192 read tool]")).toBe(true);
    expect(r.output).toContain("hello from the file");
    expect(ctx.guardCalls.length).toBe(1);
    expect(ctx.guardCalls[0]?.kind).toBe("fs.read");
    expect(readFixture(ws, "f.txt")).toBe("hello from the file\n");
  });

  test("an interactive command is refused before Guard ever sees it", async () => {
    const ctx = mockToolContext();
    const r = await shellTool.execute({ command: "vim f.txt" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("interactive command blocked (interception)");
    expect(r.error).toContain("HZ_ALLOW_INTERACTIVE=1");
    expect(ctx.guardCalls.length).toBe(0);
  });
});
