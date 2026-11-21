import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { saveUserEnvVar, loadUserEnvFile } from "../../src/core/config";

describe("saveUserEnvVar (First-Time Auth Wizard persistence)", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(tmpdir(), "hz-env-home-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("creates user env file with 0600 permissions", () => {
    const target: Record<string, string | undefined> = {};
    const res = saveUserEnvVar("GROQ_API_KEY", "gsk_test12345", { home: tempHome, target });

    expect(res.saved).toBe(true);
    expect(existsSync(res.path)).toBe(true);
    expect(target.GROQ_API_KEY).toBe("gsk_test12345");

    if (process.platform !== "win32") {
      const stat = lstatSync(res.path);
      expect(stat.mode & 0o077).toBe(0); // 0600 permissions
    }

    const loaded = loadUserEnvFile({ home: tempHome, target: {} });
    expect(loaded.loaded).toContain("GROQ_API_KEY");
  });

  test("updates existing key in place without destroying other vars", () => {
    const target: Record<string, string | undefined> = {};
    saveUserEnvVar("VAR_A", "apple", { home: tempHome, target });
    saveUserEnvVar("VAR_B", "banana", { home: tempHome, target });
    saveUserEnvVar("VAR_A", "avocado", { home: tempHome, target });

    const content = readFileSync(path.join(tempHome, ".config", "horizon", "env"), "utf8");
    expect(content).toContain('VAR_A="avocado"');
    expect(content).toContain('VAR_B="banana"');
    expect(content).not.toContain('VAR_A="apple"');
  });

  test("refuses symlinks fail-closed", () => {
    const configDir = path.join(tempHome, ".config", "horizon");
    const target: Record<string, string | undefined> = {};
    saveUserEnvVar("INIT", "val", { home: tempHome, target });

    const envFile = path.join(configDir, "env");
    const symlinkTarget = path.join(tempHome, "secret.txt");
    writeFileSync(symlinkTarget, "secret");
    rmSync(envFile);
    symlinkSync(symlinkTarget, envFile);

    const res = saveUserEnvVar("EXPLOIT", "val", { home: tempHome, target });
    expect(res.saved).toBe(false);
    expect(res.error).toContain("symlinks are refused");
  });
});
