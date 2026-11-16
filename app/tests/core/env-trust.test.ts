/**
 * env-trust.test.ts — a workspace .env must not decide the trust boundary.
 *
 * Bun auto-loads `.env` from the process cwd. The launcher therefore runs with
 * `--no-env-file`, and the only env file hzcode reads itself is the user-owned
 * `<user config dir>/env` (0600, outside the workspace). These tests are
 * end-to-end through bin/hzcode for the first claim and unit-level for the
 * loader's permission/ownership/worktree rules.
 */

import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { loadUserEnvFile } from "../../src/core/config";
import { cleanupTemps, repoRoot, tempDir } from "./helpers";

afterAll(() => {
  cleanupTemps();
});

const saved: Array<[string, string | undefined]> = [];
for (const key of ["HZ_KERNEL_BIN", "HZ_KERNEL_SHA256", "HZ_KERNEL_PIN", "HZ_PROVIDER", "HZ_BASE_URL", "HZ_MODEL", "HZ_ANCHOR_KEY", "HZ_SANDBOX_EXEC"]) {
  saved.push([key, process.env[key]]);
}

afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A scrubbed environment: no inherited HZ_* or provider keys can mask a leak. */
function scrubbedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of [
    "HZ_KERNEL_BIN",
    "HZ_KERNEL_SHA256",
    "HZ_KERNEL_PIN",
    "HZ_PROVIDER",
    "HZ_BASE_URL",
    "HZ_MODEL",
    "HZ_ANCHOR_KEY",
    "HZ_SANDBOX_EXEC",
    "HZ_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  ]) {
    delete env[key];
  }
  return env;
}

test("the launcher ignores a workspace .env for config and kernel selection", () => {
  const workspace = tempDir("hz-env-trust-ws-");
  const home = tempDir("hz-env-trust-home-");
  const fakeKernel = path.join(workspace, "hz-env-trust-evil-kernel");

  writeFileSync(
    path.join(workspace, ".env"),
    [
      "HZ_PROVIDER=hz-env-trust-evil-provider",
      "HZ_BASE_URL=https://hz-env-trust-evil.invalid",
      `HZ_KERNEL_BIN=${fakeKernel}`,
      "HZ_ANCHOR_KEY=00",
      "HZ_SANDBOX_EXEC=0",
      "HZ_MODEL=hz-env-trust-evil-model",
      "HZ_KERNEL_PIN=off",
      "HZ_KERNEL_SHA256=hz-env-trust-not-a-digest",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = spawnSync("bash", [path.join(repoRoot, "bin", "hzcode"), "doctor", "--workspace", workspace], {
    cwd: workspace,
    env: scrubbedEnv(home),
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  expect(result.error).toBeUndefined();
  expect(output).toContain("hzcode doctor");
  // If Bun had loaded workspace/.env, doctor would name the fake binary or the
  // evil provider/model/endpoint. None of these may appear.
  expect(output).not.toContain("hz-env-trust-evil-kernel");
  expect(output).not.toContain("hz-env-trust-evil-provider");
  expect(output).not.toContain("hz-env-trust-evil.invalid");
  expect(output).not.toContain("hz-env-trust-evil-model");
  expect(output).not.toContain("HZ_KERNEL_PIN=off");
  expect(output).not.toContain("hz-env-trust-not-a-digest");
});

test("loadUserEnvFile loads only an owner-only user file outside the workspace", () => {
  const home = tempDir("hz-env-user-home-");
  const configDir = path.join(home, ".config", "horizon");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const file = path.join(configDir, "env");
  writeFileSync(
    file,
    ["# user-owned", "export HZ_PROVIDER=openai", "HZ_BASE_URL='https://example.invalid'", "HZ_MODEL=model-x", ""].join("\n"),
    "utf8",
  );
  chmodSync(file, 0o600);

  const target: Record<string, string | undefined> = {};
  const loaded = loadUserEnvFile({ home, workspace: tempDir("hz-env-unrelated-ws-"), target });
  expect(loaded.skipped).toBeUndefined();
  expect(loaded.loaded.sort()).toEqual(["HZ_BASE_URL", "HZ_MODEL", "HZ_PROVIDER"]);
  expect(target.HZ_PROVIDER).toBe("openai");
  expect(target.HZ_BASE_URL).toBe("https://example.invalid");

  // An explicit environment variable wins over the file.
  const explicit: Record<string, string | undefined> = { HZ_PROVIDER: "anthropic" };
  const second = loadUserEnvFile({ home, target: explicit });
  expect(second.loaded).not.toContain("HZ_PROVIDER");
  expect(explicit.HZ_PROVIDER).toBe("anthropic");
});

test("a loose or symlinked user env file is refused", () => {
  if (process.platform === "win32") return;
  const home = tempDir("hz-env-loose-home-");
  const configDir = path.join(home, ".config", "horizon");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const file = path.join(configDir, "env");
  writeFileSync(file, "HZ_PROVIDER=evil\n", "utf8");
  chmodSync(file, 0o644);
  const loose = loadUserEnvFile({ home, target: {} });
  expect(loose.skipped).toContain("0600");
  expect(loose.loaded).toEqual([]);

  chmodSync(file, 0o600);
  const link = path.join(tempDir("hz-env-link-"), "env");
  symlinkSync(file, link);
  const linked = loadUserEnvFile({ configDir: path.dirname(link), target: {} });
  expect(linked.skipped).toContain("regular file");
  expect(linked.loaded).toEqual([]);
});

test("a user env file inside the workspace is refused", () => {
  const workspace = tempDir("hz-env-inside-ws-");
  const configDir = path.join(workspace, ".config", "horizon");
  mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, "env");
  writeFileSync(file, "HZ_PROVIDER=evil\n", "utf8");
  chmodSync(file, 0o600);

  const loaded = loadUserEnvFile({ configDir, workspace, target: {} });
  expect(loaded.skipped).toContain("inside the workspace");
  expect(loaded.loaded).toEqual([]);
});

test("config never reads a workspace .env on its own", async () => {
  const workspace = tempDir("hz-env-config-ws-");
  writeFileSync(path.join(workspace, ".env"), "HZ_PROVIDER=evil\nHZ_MODEL=evil\n", "utf8");
  const { loadConfig } = await import("../../src/core/config");
  const config = loadConfig({}, path.join(tempDir("hz-env-config-home-"), "config.json"));
  expect(config.provider).toBe("mock");
  expect(config.model).not.toBe("evil");
});
