import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { modelsForProvider } from "../../src/core/catalog/list-models";
import { COMMITTED_CATALOG_SNAPSHOT, loadCatalog } from "../../src/core/catalog/catalog";

describe("modelsForProvider", () => {
  test("merges registry models with catalog ids", () => {
    const list = modelsForProvider(
      "openai",
      {
        providers: {
          providers: [{ id: "openai", baseUrl: "https://x", protocol: "openai", models: ["custom-1"] }],
          rejected: [],
        },
      },
      {
        providers: {
          openai: {
            id: "openai",
            defaultModel: "gpt-4o-mini",
            models: { "gpt-4o-mini": { id: "gpt-4o-mini", provider: "openai", limit: { context: 128000 } } },
          },
        },
      },
    );
    expect(list).toContain("custom-1");
    expect(list).toContain("gpt-4o-mini");
  });

  test("nvidia provider ids come from the shipped snapshot when present", () => {
    if (!existsSync(COMMITTED_CATALOG_SNAPSHOT)) return;
    const prev = process.env.HZ_NO_COMMITTED_SNAPSHOT;
    delete process.env.HZ_NO_COMMITTED_SNAPSHOT;
    try {
      const catalog = loadCatalog({});
      const list = modelsForProvider("nvidia", { providers: undefined }, catalog);
      expect(list.length).toBeGreaterThan(10);
    } finally {
      if (prev === undefined) delete process.env.HZ_NO_COMMITTED_SNAPSHOT;
      else process.env.HZ_NO_COMMITTED_SNAPSHOT = prev;
    }
  });
});
