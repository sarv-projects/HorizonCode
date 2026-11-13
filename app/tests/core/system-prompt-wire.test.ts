import { describe, expect, test } from "bun:test";
import { appendSystemPromptUpdate, wireSystemPromptInHistory, SYSTEM_UPDATE_TAG } from "../../src/core/system-prompt-wire";

describe("systemPromptUpdate in-history", () => {
  test("moves volatile tail into a trailing user envelope", () => {
    const req = {
      model: "m",
      system: "Static block\n\nEnvironment:\n- workspace",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: new AbortController().signal,
    };
    const wired = wireSystemPromptInHistory(req);
    expect(wired.system).toContain("Static");
    expect(wired.messages.at(-1)?.content).toContain(SYSTEM_UPDATE_TAG);
    expect(wired.messages.at(-1)?.content).toContain("Environment:");
  });

  test("appendSystemPromptUpdate appends tagged user envelope only", () => {
    const base = [{ role: "user" as const, content: "hi" }];
    const next = appendSystemPromptUpdate(base, "Environment:\n- cwd changed");
    expect(next).toHaveLength(2);
    expect(next.at(-1)?.role).toBe("user");
    expect(next.at(-1)?.content).toContain(SYSTEM_UPDATE_TAG);
    expect(base).toHaveLength(1);
  });
});
