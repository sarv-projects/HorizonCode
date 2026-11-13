import { describe, expect, test } from "bun:test";
import { resolveThinkingEffort, ultrathinkInText } from "../../src/core/thinking-effort";

describe("thinking-effort explicit only", () => {
  test("ultrathink forces xhigh", () => {
    expect(ultrathinkInText("please ultrathink this")).toBe(true);
    expect(resolveThinkingEffort({ userText: "ultrathink now" }).effort).toBe("xhigh");
  });

  test("env default when no keyword", () => {
    const r = resolveThinkingEffort({ userText: "hello", envValue: "medium" });
    expect(r.effort).toBe("medium");
    expect(r.source).toBe("env");
  });

  test("ultrathink beats env", () => {
    const r = resolveThinkingEffort({ userText: "ultrathink", envValue: "low" });
    expect(r.effort).toBe("xhigh");
    expect(r.source).toBe("ultrathink");
  });
});
