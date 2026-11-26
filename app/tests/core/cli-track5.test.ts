import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  VERSION,
  buildReexecArgs,
  isAcpCwdContained,
  parseArgs,
  runH2hCommand,
  runLoginCommand,
  runModelsCommand,
  runTasksCommand,
  runTuiCommand,
  runVerifyArtifactCommand,
} from "../../src/main";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

function captureStreams<T>(fn: () => T | Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  return Promise.resolve()
    .then(fn)
    .then((result) => ({ result, stdout, stderr }))
    .finally(() => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    });
}

describe("Track 5: CLI, Packaging, Windows Launchers, CI & Repo Hygiene", () => {
  test("VERSION matches app/package.json", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "app/package.json"), "utf8")) as {
      version: string;
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(VERSION).toBe(pkg.version);
    expect(pkg.bin?.hzcode).toBe("../bin/hzcode");
    expect(pkg.scripts?.check).not.toContain("/tmp/hz-b-app");
  });

  test("Windows launchers bin/hzcode.cmd and bin/hzcode.ps1 preserve --no-env-file", () => {
    const cmd = readFileSync(path.join(REPO_ROOT, "bin/hzcode.cmd"), "utf8");
    const ps1 = readFileSync(path.join(REPO_ROOT, "bin/hzcode.ps1"), "utf8");
    expect(cmd).toContain("--no-env-file");
    expect(cmd).toContain("app\\src\\main.ts");
    expect(ps1).toContain("--no-env-file");
    expect(ps1).toContain("app\\src\\main.ts");
  });

  test("parseArgs supports --provider <name> and validates missing value", () => {
    const a = parseArgs(["--provider", "openai", "--model", "gpt-5"]);
    expect(a.errors).toEqual([]);
    expect(a.provider).toBe("openai");
    expect(a.model).toBe("gpt-5");

    const b = parseArgs(["--provider=anthropic"]);
    expect(b.errors).toEqual([]);
    expect(b.provider).toBe("anthropic");

    const bad = parseArgs(["--provider"]);
    expect(bad.errors).toContain("--provider needs a name");
  });

  test("buildReexecArgs preserves --no-env-file run and strips --worktree/--workspace", () => {
    const args = buildReexecArgs("/repo/app/src/main.ts", "/tmp/wt-1", [
      "--worktree",
      "feat-x",
      "--workspace=/old",
      "--provider",
      "mock",
      "-p",
      "hello",
    ]);
    expect(args).toEqual([
      "--no-env-file",
      "run",
      "/repo/app/src/main.ts",
      "--workspace",
      "/tmp/wt-1",
      "--provider",
      "mock",
      "-p",
      "hello",
    ]);
  });

  test("hzcode logout with no args prints usage and exits 2 even on TTY", async () => {
    const desc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const { result, stderr } = await captureStreams(() => runLoginCommand(["logout"]));
      expect(result).toBe(2);
      expect(stderr).toContain("usage: hzcode logout <provider>");
    } finally {
      if (desc) Object.defineProperty(process.stdin, "isTTY", desc);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });

  test("runTasksCommand uses ESM import, supports --help, and rejects unknown flags with exit 2", async () => {
    const mainSrc = readFileSync(path.join(REPO_ROOT, "app/src/main.ts"), "utf8");
    expect(mainSrc).not.toContain('require("./core/task-board")');

    const help = await captureStreams(() => runTasksCommand(["--help"]));
    expect(help.result).toBe(0);
    expect(help.stdout).toContain("usage: hzcode tasks");

    const bad = await captureStreams(() => runTasksCommand(["--bogus"]));
    expect(bad.result).toBe(2);
    expect(bad.stderr).toContain("unknown argument --bogus");

    const ws = mkdtempSync(path.join(tmpdir(), "hz-cli-tasks-"));
    const ok = await captureStreams(() => runTasksCommand(["--workspace", ws, "--json"]));
    expect(ok.result).toBe(0);
    expect(JSON.parse(ok.stdout).ok).toBe(true);
  });

  test("runH2hCommand and runVerifyArtifactCommand reject unknown flags and invalid --tasks with exit 2", async () => {
    for (const badTasks of ["0", "-3", "1.5", "abc"]) {
      const res = await captureStreams(() => runH2hCommand(["--tasks", badTasks]));
      expect(res.result).toBe(2);
      expect(res.stderr).toContain("--tasks needs a positive integer");
    }

    const h2hUnknown = await captureStreams(() => runH2hCommand(["--nope"]));
    expect(h2hUnknown.result).toBe(2);
    expect(h2hUnknown.stderr).toContain("unknown argument --nope");

    const vaUnknown = await captureStreams(() => runVerifyArtifactCommand(["--nope"]));
    expect(vaUnknown.result).toBe(2);
    expect(vaUnknown.stderr).toContain("unknown argument --nope");
  });

  test("isAcpCwdContained allows workspace subdirs and refuses escapes including symlinks", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-acp-ws-"));
    const sub = path.join(ws, "nested");
    const outside = mkdtempSync(path.join(tmpdir(), "hz-acp-out-"));
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(outside, "secret.txt"), "x");

    expect(isAcpCwdContained(ws, ws).ok).toBe(true);
    expect(isAcpCwdContained(ws, sub).ok).toBe(true);
    expect(isAcpCwdContained(ws, outside).ok).toBe(false);
    expect(isAcpCwdContained(ws, path.join(ws, "..")).ok).toBe(false);

    const linkPath = path.join(ws, "escape-link");
    symlinkSync(outside, linkPath);
    expect(isAcpCwdContained(ws, linkPath).ok).toBe(false);
  });

  test("runTuiCommand and runModelsCommand support --workspace and reject unknown flags with exit 2", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-tui-relaunch-"));
    const tuiMissing = await captureStreams(() => runTuiCommand(["relaunch", "--workspace", ws]));
    expect(tuiMissing.result).toBe(1);
    expect(tuiMissing.stderr).toContain("no handoff file");

    const tuiUnknown = await captureStreams(() => runTuiCommand(["relaunch", "--bogus"]));
    expect(tuiUnknown.result).toBe(2);
    expect(tuiUnknown.stderr).toContain("unknown argument --bogus");

    const modelsHelp = await captureStreams(() => runModelsCommand(["refresh", "--help"]));
    expect(modelsHelp.result).toBe(0);
    expect(modelsHelp.stdout).toContain("--workspace <path>");

    const modelsUnknown = await captureStreams(() => runModelsCommand(["refresh", "--bogus"]));
    expect(modelsUnknown.result).toBe(2);
    expect(modelsUnknown.stderr).toContain("unknown argument --bogus");
  });

  test("CI workflows, ops/gates.sh, SECURITY.md, and CONTRIBUTING.md match Track 5 hygiene", () => {
    const opsCi = readFileSync(path.join(REPO_ROOT, "ops/ci/github-actions.yml"), "utf8");
    const ghCi = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ghCi).toBe(opsCi);
    expect(opsCi).toContain("windows-latest");
    expect(opsCi).toContain("macos-latest");
    expect(opsCi).toContain("bun install --frozen-lockfile");

    const gates = readFileSync(path.join(REPO_ROOT, "ops/gates.sh"), "utf8");
    expect(gates).toContain("${bin}.exe");

    expect(existsSync(path.join(REPO_ROOT, "SECURITY.md"))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, "CONTRIBUTING.md"))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, "LICENSE"))).toBe(false);
  });
});
