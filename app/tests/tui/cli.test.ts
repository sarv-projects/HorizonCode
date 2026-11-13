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
    expect(run.stdout).toContain("--list-models");
    expect(run.stdout).toContain("--show-prompts");
    expect(run.stdout).toContain("--show-repo-map");
    expect(run.stdout).toContain("--mock");
    expect(run.stdout).toContain("--version");
    expect(run.stdout).toContain("hzcode keybind check");
    // usage is not an error
    expect(run.stderr).toBe("");
  });

  test("keybind check defaults exits 0", async () => {
    const run = await runApp(appSpec(["keybind", "check"]));
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("keybind check ok");
  });

  test("keybind check rejects protected chord shadow", async () => {
    const dir = makeWorkspace();
    const file = path.join(dir, "keys.json");
    writeFileSync(file, JSON.stringify({ "turn.cancel": "ctrl+c" }), "utf8");
    const run = await runApp(appSpec(["keybind", "check", file]));
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("protected");
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

  test("--show-prompts prints JSON and exits 0 without a turn", async () => {
    const ws = makeWorkspace();
    const run = await runApp(appSpec(["--workspace", ws, "--mock", "--show-prompts"]), "");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('"Hello!"');
    expect(run.stdout).toContain('"system"');
    expect(run.stderr).toBe("");
  });

  test("--show-repo-map prints map and exits 0 without a turn", async () => {
    const ws = makeWorkspace({ "src/index.ts": "export function app() { return 1; }\n" });
    const run = await runApp(appSpec(["--workspace", ws, "--mock", "--show-repo-map"]), "");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[repo_map:");
    expect(run.stderr).toBe("");
  });

  test("--list-models filters by substring", async () => {
    const ws = makeWorkspace();
    const run = await runApp(appSpec(["--workspace", ws, "--mock", "--list-models", "mock"]), "");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("mock-1");
  });

  test("--model typo exits 2 with did-you-mean", async () => {
    const ws = makeWorkspace();
    const run = await runApp(appSpec(["--workspace", ws, "--mock", "--model", "mock-2"]), "");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Did you mean");
    expect(run.stderr).toContain("mock-1");
  });
});
