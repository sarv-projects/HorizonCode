/**
 * shell-minimiser.test.ts — NF-074(c)/(d): the shell-output minimiser and
 * dedicated-tool interception. Bytes stay byte-identical when nothing needs
 * minimising; the flag appears exactly when something was minimised.
 */

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
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

  test("one layer of matching quotes is stripped; nothing dynamic is ever intercepted", () => {
    // The audit repros: quoted operands used to be passed through raw...
    expect(classifyShellCommand("cat 'file.txt'")).toEqual({ action: "intercept-read", path: "file.txt" });
    expect(classifyShellCommand('cat "file.txt"')).toEqual({ action: "intercept-read", path: "file.txt" });
    // ...and a glob used to be intercepted as a literal, which the shell must expand.
    expect(classifyShellCommand("cat *.txt")).toEqual({ action: "run" });
    expect(classifyShellCommand("cat '*.txt'")).toEqual({ action: "run" });
    expect(classifyShellCommand("cat $HOME/f")).toEqual({ action: "run" });
    expect(classifyShellCommand("cat 'a b.txt'")).toEqual({ action: "run" }); // whitespace splits: the shell's job
    expect(classifyShellCommand("cat -n file")).toEqual({ action: "run" }); // unchanged
  });

  test("wrapper tokens do not hide the real head from the blocklist", () => {
    for (const command of [
      "env less file",
      "timeout 5 vim",
      "timeout -s KILL 5 vim",
      "command man ls",
      "nice -n 5 nano x",
      "nohup watch ls",
      "stdbuf -o0 top",
      "env VAR=1 less log",
      "exec vim f",
    ]) {
      expect(classifyShellCommand(command).action, command).toBe("refuse");
    }
    // ...and the cat interception still sees through them.
    expect(classifyShellCommand("timeout 5 cat x")).toEqual({ action: "intercept-read", path: "x" });
    expect(classifyShellCommand("VAR=1 command cat f.txt")).toEqual({ action: "intercept-read", path: "f.txt" });
    // Normal commands are unaffected.
    expect(classifyShellCommand("timeout 5 echo hi")).toEqual({ action: "run" });
    expect(classifyShellCommand("nice echo hi")).toEqual({ action: "run" });
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
    // A bare CR only moves the cursor: text before a trailing bare CR stays visible.
    expect(minimiseShellOutput("progress 50%\r").text).toBe("progress 50%");
  });

  test("CRLF is a line ending and survives byte-for-byte", () => {
    const crlf = "line one\r\nline two\r\n";
    expect(minimiseShellOutput(crlf)).toEqual({ text: crlf, changed: false });
    // ...while a bare CR on the same stream is still an overwrite.
    expect(minimiseShellOutput("down 10%\rdown 20%\rdone\r\nnext line\r\n").text).toBe("done\r\nnext line\r\n");
  });

  test("invisible reordering characters are stripped; script characters are kept", () => {
    // The wave-13 audit repro: printf emitted the line rendering as "cleanred" +
    // a reversed tail while the model received the bidi override and zero-width
    // verbatim (the terminal hid their presence).
    const audited = "cleanred\u202EdlroW olleh\u200Btail";
    const minimised = minimiseShellOutput(audited);
    expect(minimised.changed).toBe(true);
    expect(minimised.text).toBe("cleanreddlroW ollehtail");
    expect(minimised.text).not.toContain("\u202E");
    expect(minimised.text).not.toContain("\u200B");
    // Isolates, the other overrides/embeddings and the remaining zero-widths go too.
    expect(minimiseShellOutput("a\u2066b\u2069c\u200Cd\u200De\u202Af\u202Cg").text).toBe("abcdefg");
    // ...and nothing else does: CJK, emoji and RTL script text pass through
    // byte-for-byte (this is the control set, not a script filter).
    const script = "\u65e5\u672c\u8a9e\u30c6\u30ad\u30b9\u30c8 \ud83c\udf89 \u0645\u0631\u062d\u0628\u0627";
    expect(minimiseShellOutput(script)).toEqual({ text: script, changed: false });
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
    expect(r.output).toContain("Output:\nplain");
    expect(r.output).toMatch(/Exit code: 0/);
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
    expect(r.output).toMatch(/Exit code: 0/);
  });

  test("a carriage-return progress line is settled before the model sees it", async () => {
    const r = await shellTool.execute({ command: "printf 'aaa\\rbbb\\rccc\\n'" }, mockToolContext());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("ccc");
    expect(r.output).not.toContain("aaa");
    expect(r.output).toContain("[output minimised:");
  });

  test("a CRLF line ending reaches the model byte-for-byte, unflagged (audit repro)", async () => {
    const r = await shellTool.execute({ command: "printf 'line one\\r\\nline two\\r\\n'" }, mockToolContext());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("line one");
    expect(r.output).toContain("line two");
    expect(r.output).toMatch(/Exit code: 0/);
    expect(r.output).not.toContain("[output minimised:");
  });

  test("mixed CR progress and CRLF lines: the progress line settles, the CRLF survives", async () => {
    const r = await shellTool.execute(
      { command: "printf 'down 10%%\\rdown 20%%\\rdone\\r\\nnext\\r\\n'" },
      mockToolContext(),
    );
    expect(r.ok).toBe(true);
    const body = r.output.split("Output:\n")[1] ?? "";
    expect(body.startsWith("done\r\nnext\r")).toBe(true);
    expect(r.output).not.toContain("down 10%");
    expect(r.output).toContain("[output minimised:");
  });

  test("a minimised over-cap result spills the ORIGINAL bytes, not the minimised text", async () => {
    const ws = makeWorkspace();
    const command = `yes $'\\033[31m${"x".repeat(40)}\\033[0m' | head -n 600`;
    const r = await shellTool.execute({ command }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("[output minimised:");
    expect(r.output).not.toContain("\u001b[31m");
    const spillDir = path.join(ws, ".hz", "state", "spills");
    const files = readdirSync(spillDir);
    expect(files.length).toBe(1);
    const spill = readFileSync(path.join(spillDir, files[0] as string), "utf8");
    expect(spill.length).toBeGreaterThan(16 * 1024);
    expect(spill.startsWith("\u001b[31m")).toBe(true); // the raw ANSI bytes, not the minimised view
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

  test("quoted operands and globs behave at execution time", async () => {
    const ws = makeWorkspace({ "f.txt": "hello quoted\n", "g.txt": "second file\n" });
    const ctx = mockToolContext({ cwd: ws });
    const quoted = await shellTool.execute({ command: "cat 'f.txt'" }, ctx);
    expect(quoted.ok).toBe(true);
    expect(quoted.output.startsWith("[intercepted: cat f.txt \u2192 read tool]")).toBe(true);
    expect(quoted.output).toContain("hello quoted");
    const doubleQuoted = await shellTool.execute({ command: 'cat "f.txt"' }, ctx);
    expect(doubleQuoted.output.startsWith("[intercepted: cat f.txt \u2192 read tool]")).toBe(true);
    // A glob is the shell's to expand: no interception, real output.
    const glob = await shellTool.execute({ command: "cat *.txt" }, ctx);
    expect(glob.ok).toBe(true);
    expect(glob.output).not.toContain("[intercepted");
    expect(glob.output).toContain("hello quoted");
    expect(glob.output).toContain("second file");
    expect(glob.output).toMatch(/Exit code: 0/);
  });

  test("invisible reordering characters reach the model stripped, at tool level", async () => {
    const r = await shellTool.execute(
      // Octal UTF-8 bytes, not printf's \u escape: \u output depends on the
      // shell's locale (a C/POSIX locale prints it literally), so the test
      // would pass or fail by host locale. U+202E = e2 80 ae, U+200B = e2 80 8b.
      { command: "printf 'cleanred\\342\\200\\256dlroW olleh\\342\\200\\213tail\\n'" },
      mockToolContext(),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("cleanreddlroW ollehtail");
    expect(r.output).not.toContain("\u202E");
    expect(r.output).not.toContain("\u200B");
    expect(r.output).toContain("[output minimised:");
  });

  test("a wrapper-wrapped interactive command is refused before Guard sees it", async () => {
    const ctx = mockToolContext();
    const r = await shellTool.execute({ command: "timeout 5 vim f.txt" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("interactive command blocked (interception)");
    expect(ctx.guardCalls.length).toBe(0);
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
