import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CONFIG_UNSET,
  defaultConfigPath,
  loadConfig,
  mergeConfigFileLayers,
  workspaceConfigFile,
} from "../../src/core/config";

let home: string;
let workspace: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "hz-home-"));
  workspace = mkdtempSync(path.join(tmpdir(), "hz-ws-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe("CONFIG_UNSET workspace layer (H-3 reduced)", () => {
  test("mergeConfigFileLayers ignores UNSET so user value wins", () => {
    const merged = mergeConfigFileLayers(
      { permissionMode: "read-only", theme: "dark" },
      { permissionMode: CONFIG_UNSET, theme: "mono" },
    );
    expect(merged.permissionMode).toBe("read-only");
    expect(merged.theme).toBe("mono");
  });

  test("loadConfig applies workspace permissionMode over user", () => {
    const userFile = defaultConfigPath(home);
    mkdirSync(path.dirname(userFile), { recursive: true });
    writeFileSync(userFile, JSON.stringify({ permissionMode: "default" }), "utf8");
    const wsFile = workspaceConfigFile(workspace);
    mkdirSync(path.dirname(wsFile), { recursive: true });
    writeFileSync(wsFile, JSON.stringify({ permissionMode: "read-only" }), "utf8");
    const env = { HOME: home, USERPROFILE: home, HZ_PROVIDER: "mock" };
    const cfg = loadConfig(env, userFile, workspace);
    expect(cfg.permissionMode).toBe("read-only");
  });
});
