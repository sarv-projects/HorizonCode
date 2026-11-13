import { describe, expect, test } from "bun:test";
import { renderSettingsReport } from "../../src/core/settings-report";
import type { HzConfig } from "../../src/core/config";

describe("renderSettingsReport", () => {
  test("masks api key source and lists provider/model", () => {
    const config: HzConfig = {
      provider: "mock",
      model: "mock-1",
      sources: { provider: "default", model: "default", baseUrl: "default", apiKey: "none" },
    };
    const text = renderSettingsReport({ workspace: "/tmp/ws", home: "/tmp/home", config });
    expect(text).toContain("provider: mock");
    expect(text).toContain("model: mock-1");
    expect(text).toContain("settings (effective");
  });
});
