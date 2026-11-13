import { afterEach, describe, expect, test } from "bun:test";
import { anthropicSystemField } from "../../src/core/providers/anthropic-cache";

describe("anthropic cache marker", () => {
  afterEach(() => {
    delete process.env.HZ_ANTHROPIC_CACHE_SYSTEM;
  });

  test("default leaves system as plain string", () => {
    expect(anthropicSystemField("sys")).toBe("sys");
    expect(anthropicSystemField("")).toBe("");
  });

  test("HZ_ANTHROPIC_CACHE_SYSTEM=1 wraps one ephemeral block", () => {
    process.env.HZ_ANTHROPIC_CACHE_SYSTEM = "1";
    expect(anthropicSystemField("sys")).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
  });
});
