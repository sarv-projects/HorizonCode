import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultConfigPath, loadConfig } from "../../src/core/config";
import { AUTONOMY_PRESETS, parseAutonomyPreset } from "../../src/core/autonomy-presets";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(() => cleanupTemps());

function configFile(body: Record<string, unknown>): string {
  const home = tempDir("hz-auto-home-");
  const file = defaultConfigPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body), "utf8");
  return file;
}

describe("autonomy presets", () => {
  test("each preset maps to a permission mode", () => {
    for (const p of AUTONOMY_PRESETS) {
      expect(p.permissionMode).toBeDefined();
      expect(parseAutonomyPreset(p.id)?.permissionMode).toBe(p.permissionMode);
    }
    expect(parseAutonomyPreset("auto_edits")?.id).toBe("auto-edits");
  });

  test("config autonomy selects permission mode when permissionMode omitted", () => {
    const file = configFile({ autonomy: "auto-edits" });
    const cfg = loadConfig({ HZ_NO_COMMITTED_SNAPSHOT: "1" }, file);
    expect(cfg.autonomy).toBe("auto-edits");
    expect(cfg.permissionMode).toBe("accept-edits");
  });

  test("explicit permissionMode wins over autonomy", () => {
    const file = configFile({ autonomy: "assisted", permissionMode: "default" });
    const cfg = loadConfig({ HZ_NO_COMMITTED_SNAPSHOT: "1" }, file);
    expect(cfg.permissionMode).toBe("default");
  });
});
