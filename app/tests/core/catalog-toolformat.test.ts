import { describe, expect, test } from "bun:test";
import { loadConfig, toolFormatForCatalogModel } from "../../src/core/config";
import { decodeCatalog, loadCatalog } from "../../src/core/catalog/catalog";

describe("catalog tools:false selects xml toolFormat", () => {
  test("toolFormatForCatalogModel returns xml when native tools are disabled", () => {
    const catalog = decodeCatalog({
      providers: {
        mock: {
          id: "mock",
          defaultModel: "no-tools-model",
          models: {
            "no-tools-model": {
              id: "no-tools-model",
              provider: "mock",
              limit: { context: 8192 },
              capabilities: { tools: false },
            },
          },
        },
      },
    });
    expect(toolFormatForCatalogModel({ ...catalog, source: "curated" }, "mock", "no-tools-model")).toBe("xml");
    expect(toolFormatForCatalogModel({ ...catalog, source: "curated" }, "mock", "mock-1")).toBeUndefined();
  });

  test("loadConfig leaves toolFormat unset when the curated model supports tools", () => {
    const env = {
      HOME: "/tmp",
      USERPROFILE: "/tmp",
      HZ_PROVIDER: "mock",
      HZ_MODEL: "mock-1",
    };
    expect(loadConfig(env).toolFormat).toBeUndefined();
  });

  test("HZ_TOOL_FORMAT wins over the catalog", () => {
    const env = {
      HOME: "/tmp",
      USERPROFILE: "/tmp",
      HZ_PROVIDER: "mock",
      HZ_MODEL: "mock-1",
      HZ_TOOL_FORMAT: "xml",
    };
    expect(loadConfig(env).toolFormat).toBe("xml");
  });

  test("HZ_TOOL_FORMAT=hermes selects the Hermes dialect", () => {
    const env = {
      HOME: "/tmp",
      USERPROFILE: "/tmp",
      HZ_PROVIDER: "mock",
      HZ_MODEL: "mock-1",
      HZ_TOOL_FORMAT: "hermes",
    };
    expect(loadConfig(env).toolFormat).toBe("hermes");
  });

  test("curated mock-1 advertises native tools", () => {
    const catalog = loadCatalog({});
    expect(toolFormatForCatalogModel(catalog, "mock", "mock-1")).toBeUndefined();
  });
});
