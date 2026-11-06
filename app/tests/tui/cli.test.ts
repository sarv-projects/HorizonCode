/**
 * cli.test.ts — the flags a script or a human types before the chat starts.
 *
 * These runs never reach the runtime: --version and --help answer immediately and
 * an unusable --workspace is refused with exit code 2.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { appSpec, killAllProcesses, makeWorkspace, runApp } from "./harness";

afterAll(() => {
  killAllProcesses();
});

function scratchPath(name: string): string {
  return path.join(tmpdir(), `hzcode-tui-${name}-${randomUUID().slice(0, 8)}`);
}

describe("command line", () => {
  test("--version prints the version and exits 0", async () => {
    const run = await runApp(appSpec(["--version"]));

    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe("hzcode 0.1.0");
    expect(run.stderr).toBe("");
  });

  test("--help prints the usage and exits 0", async () => {
    const run = await runApp(appSpec(["--help"]));

    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("hzcode \u2014 chat with a coding assistant");
    expect(run.stdout).toContain("hzcode [message]");
    expect(run.stdout).toContain("--workspace <path>");
    expect(run.stdout).toContain("--model <name>");
    expect(run.stdout).toContain("--mock");
    expect(run.stdout).toContain("--version");
    // usage is not an error
    expect(run.stderr).toBe("");
  });

  test("an unusable --workspace exits 2 with a message on stderr", async () => {
    const missing = scratchPath("missing");
    const run = await runApp(appSpec(["--workspace", missing, "--mock"]), "hello\n");

    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("hzcode:");
    expect(run.stderr).toContain("not a folder");
    expect(run.stderr).toContain(missing);
    // nothing was said to stdout: the chat never started
    expect(run.stdout).toBe("");
  });

  test("a --workspace that is a file is not a folder either", async () => {
    const dir = makeWorkspace();
    const file = path.join(dir, "notes.txt");
    writeFileSync(file, "not a directory\n", "utf8");
    const run = await runApp(appSpec(["--workspace", file, "--mock"]), "hello\n");

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("not a folder");
    expect(run.stderr).toContain(file);
  });

  test("--workspace with no value exits 2 instead of guessing", async () => {
    const run = await runApp(appSpec(["--workspace"]), "");

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("needs a folder");
    expect(run.stderr).toContain("hzcode --help");
  });

  test("an unknown option exits 2 instead of starting a chat", async () => {
    const run = await runApp(appSpec(["--nope"]), "hello\n");

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("unknown option --nope");
  });
});
