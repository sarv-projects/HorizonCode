import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  describeAdapterCatalogue,
  loadAdapterConfigs,
  normalizeAdapterConfig,
  resolveAdapter,
  selectAdapterForProgram,
} from "../../src/core/dap/config";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

function ws(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-dap-cfg-"));
  roots.push(dir);
  return dir;
}

describe("dap config", () => {
  test("defaults include common adapters", () => {
    const configs = loadAdapterConfigs();
    expect(configs.debugpy?.command).toBe("python");
    expect(configs.debugpy?.args).toEqual(["-m", "debugpy.adapter"]);
    expect(configs.gdb?.fileTypes).toContain(".c");
    expect(configs.dlv?.connectMode).toBe("socket");
  });

  test("workspace .hz/dap.json overrides merge launchDefaults", () => {
    const dir = ws();
    mkdirSync(path.join(dir, ".hz"), { recursive: true });
    writeFileSync(
      path.join(dir, ".hz", "dap.json"),
      JSON.stringify({
        adapters: {
          debugpy: {
            command: "python3",
            args: ["-m", "debugpy.adapter"],
            languages: ["python"],
            fileTypes: [".py"],
            launchDefaults: { justMyCode: true },
          },
        },
      }),
    );
    const configs = loadAdapterConfigs(dir);
    expect(configs.debugpy?.command).toBe("python3");
    expect(configs.debugpy?.launchDefaults.justMyCode).toBe(true);
    expect(configs.debugpy?.launchDefaults.stopOnEntry).toBe(true);
  });

  test("normalizeAdapterConfig rejects empty command", () => {
    expect(normalizeAdapterConfig({ command: "" })).toBeNull();
    expect(normalizeAdapterConfig({ command: "gdb", args: ["-i", "dap"] })?.command).toBe("gdb");
  });

  test("resolveAdapter finds bun when present", () => {
    const dir = ws();
    mkdirSync(path.join(dir, ".hz"), { recursive: true });
    writeFileSync(
      path.join(dir, ".hz", "dap.json"),
      JSON.stringify({
        adapters: {
          "test-bun": {
            command: "bun",
            args: ["--version"],
            languages: ["javascript"],
            fileTypes: [".ts"],
          },
        },
      }),
    );
    const resolved = resolveAdapter("test-bun", dir);
    expect(resolved).not.toBeNull();
    expect(resolved!.resolvedCommand.length).toBeGreaterThan(0);
    expect(resolved!.args).toEqual(["--version"]);
  });

  test("selectAdapterForProgram prefers extension match among stdio adapters", () => {
    const dir = ws();
    // Unique extension so built-in catalogue cannot compete.
    mkdirSync(path.join(dir, ".hz"), { recursive: true });
    writeFileSync(
      path.join(dir, ".hz", "dap.json"),
      JSON.stringify({
        adapters: {
          "local-py": {
            command: "bun",
            args: ["-e", "1"],
            languages: ["python"],
            fileTypes: [".hzpy"],
            rootMarkers: ["pyproject.toml"],
          },
        },
      }),
    );
    writeFileSync(path.join(dir, "pyproject.toml"), "[project]\nname='t'\n");
    const picked = selectAdapterForProgram("app.hzpy", dir);
    expect(picked?.name).toBe("local-py");
  });

  test("describeAdapterCatalogue lists availability", () => {
    const rows = describeAdapterCatalogue(ws());
    expect(rows.some((r) => r.name === "debugpy")).toBe(true);
    expect(rows.every((r) => typeof r.available === "boolean")).toBe(true);
  }, { timeout: 15_000 });

  test("socket adapters can be auto-selected when no stdio match", () => {
    const dir = ws();
    mkdirSync(path.join(dir, ".hz"), { recursive: true });
    writeFileSync(
      path.join(dir, ".hz", "dap.json"),
      JSON.stringify({
        adapters: {
          onlydlv: {
            command: "bun",
            args: [],
            languages: ["go"],
            fileTypes: [".hzgo"],
            connectMode: "socket",
          },
        },
      }),
    );
    expect(selectAdapterForProgram("main.hzgo", dir)?.name).toBe("onlydlv");
  });
});
