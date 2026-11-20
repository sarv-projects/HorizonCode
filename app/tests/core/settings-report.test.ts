import { describe, expect, test } from "bun:test";
import { renderSettingsReport, settingsReportPublication } from "../../src/core/settings-report";
import type { HzConfig } from "../../src/core/config";
import { assertPublishedNumber } from "../../src/core/metrics";

describe("renderSettingsReport", () => {
  test("masks api key source and lists provider/model", () => {
    const config: HzConfig = {
      provider: "mock",
      model: "mock-1",
      sources: { provider: "default", model: "default", baseUrl: "default", apiKey: "none" },
    };
    const text = renderSettingsReport({ workspace: "/tmp/ws", home: "/tmp/home", config, env: {} });
    expect(text).toContain("provider: mock");
    expect(text).toContain("model: mock-1");
    expect(text).toContain("settings (effective");
    expect(text).toContain("analyticsLog: off");
    expect(text).not.toContain("Residual: local-only analytics log");
  });

  test("renderSettingsReport force-evaluates settingsReportPublication (ruling 617)", () => {
    const config: HzConfig = {
      provider: "mock",
      model: "mock-1",
      sources: { provider: "default", model: "default", baseUrl: "default", apiKey: "none" },
      mcp: { servers: [{ id: "a", command: "x", args: [] }] } as HzConfig["mcp"],
      budget: { maxSteps: 3 },
    };
    const opts = { workspace: "/tmp/ws", home: "/tmp/home", config, env: {} };
    void renderSettingsReport(opts);
    const blocks = settingsReportPublication(opts);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) assertPublishedNumber(block);
  });
});
