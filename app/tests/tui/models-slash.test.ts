import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { COMMITTED_CATALOG_SNAPSHOT, loadCatalog } from "../../src/core/catalog/catalog";
import { modelsForProvider } from "../../src/core/catalog/list-models";
import { formatModelsNotice, MODELS_LIST_CAP } from "../../src/tui/models-slash";

describe("models slash output", () => {
  test("empty list yields guidance", () => {
    expect(formatModelsNotice("mock", [])).toContain("no models listed");
  });

  test("truncates long lists", () => {
    const ids = Array.from({ length: MODELS_LIST_CAP + 5 }, (_, i) => `m-${i}`);
    const msg = formatModelsNotice("p", ids);
    expect(msg).toContain(`+${ids.length - MODELS_LIST_CAP} more`);
  });

  test("nvidia provider lists catalog snapshot ids", () => {
    if (!existsSync(COMMITTED_CATALOG_SNAPSHOT)) return;
    const prev = process.env.HZ_NO_COMMITTED_SNAPSHOT;
    delete process.env.HZ_NO_COMMITTED_SNAPSHOT;
    try {
      const catalog = loadCatalog({});
      const list = modelsForProvider(
        "nvidia",
        {
          providers: {
            providers: [{ id: "nvidia", baseUrl: "https://integrate.api.nvidia.com", protocol: "openai", models: [] }],
            rejected: [],
          },
        },
        catalog,
      );
      expect(list.length).toBeGreaterThan(10);
      const msg = formatModelsNotice("nvidia", list);
      expect(msg).toContain("models for nvidia");
      expect(msg).toMatch(/mistralai\/|meta\//);
    } finally {
      if (prev === undefined) delete process.env.HZ_NO_COMMITTED_SNAPSHOT;
      else process.env.HZ_NO_COMMITTED_SNAPSHOT = prev;
    }
  });
});
