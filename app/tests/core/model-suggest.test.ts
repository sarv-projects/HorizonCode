import { describe, expect, test } from "bun:test";
import {
  filterModelIds,
  formatDidYouMean,
  isKnownModel,
  suggestModelIds,
} from "../../src/core/catalog/model-suggest";

describe("model-suggest", () => {
  test("suggestModelIds ranks close typos", () => {
    const pool = ["gpt-4o-mini", "gpt-4o", "claude-sonnet-4-5"];
    expect(suggestModelIds("gpt-4o-min", pool)[0]).toBe("gpt-4o-mini");
    expect(suggestModelIds("claude-sonet", pool)[0]).toBe("claude-sonnet-4-5");
  });

  test("filterModelIds applies case-insensitive substring", () => {
    const ids = ["gpt-4o-mini", "gpt-4o", "claude-3-haiku"];
    expect(filterModelIds(ids, "GPT-4")).toEqual(["gpt-4o-mini", "gpt-4o"]);
  });

  test("formatDidYouMean lists suggestions", () => {
    expect(formatDidYouMean("typo", ["gpt-4o-mini"])).toContain("Did you mean: gpt-4o-mini");
  });

  test("isKnownModel accepts catalog and registry ids", () => {
    const catalog = {
      providers: {
        openai: {
          id: "openai",
          defaultModel: "gpt-4o-mini",
          models: { "gpt-4o-mini": { id: "gpt-4o-mini", provider: "openai", limit: { context: 128000 } } },
        },
      },
    };
    expect(isKnownModel("openai", "gpt-4o-mini", { providers: undefined }, catalog)).toBe(true);
    expect(isKnownModel("openai", "not-a-model", { providers: undefined }, catalog)).toBe(false);
  });
});
