import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { cleanCommitMessage, commitCommand, commitPrompt, shellQuote, stagedDiff, withReceiptTrailer } from "../../src/core/commit";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

test("message cleanup, trailer and quoting", () => {
  expect(cleanCommitMessage('```\nfix: a\n\nbody\n```')).toBe("fix: a\n\nbody");
  expect(cleanCommitMessage('"fix: b"')).toBe("fix: b");
  expect(withReceiptTrailer("s", "abc")).toBe("s\n\nHZ-Receipt: abc");
  expect(withReceiptTrailer("s", undefined)).toBe("s");
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  expect(commitCommand("a'b; rm -rf /")).toBe(`git commit -m 'a'\\''b; rm -rf /'`);
  const p = commitPrompt("DIFF", true, "ctx");
  expect(p).toContain("DIFF");
  expect(p).toContain("[diff truncated]");
  expect(p).toContain("ctx");
});

test("stagedDiff reads only the index", () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "hz-commit-"));
  dirs.push(d);
  spawnSync("git", ["init", "-q", d]);
  writeFileSync(path.join(d, "a.txt"), "one\n");
  expect(stagedDiff(d)).toEqual({ diff: "", truncated: false });
  spawnSync("git", ["add", "a.txt"], { cwd: d });
  const r = stagedDiff(d);
  expect("diff" in r && r.diff).toContain("+one");
});
