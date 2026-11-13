import { describe, expect, test } from "bun:test";
import { buildShowPromptsRequest, renderShowPrompts } from "../../src/core/show-prompts";
import { loadConfig } from "../../src/core/config";
import { makeWorkspace } from "../tools/helpers";

describe("--show-prompts payload", () => {
  test("builds a synthetic Hello! user turn and tool specs without calling a provider", () => {
    const prev = { p: process.env.HZ_PROVIDER, m: process.env.HZ_MODEL };
    process.env.HZ_PROVIDER = "mock";
    process.env.HZ_MODEL = "mock-1";
    try {
      const ws = makeWorkspace();
      const config = loadConfig(process.env);
      const req = buildShowPromptsRequest({ workspace: ws, config, model: "mock-1" });
      expect(req.messages).toEqual([{ role: "user", content: "Hello!" }]);
      expect(req.model).toBe("mock-1");
      expect(req.system.length).toBeGreaterThan(100);
      expect(req.tools.length).toBeGreaterThan(5);
      const text = renderShowPrompts(req);
      expect(text).toContain('"Hello!"');
      expect(text).toContain('"tools"');
    } finally {
      if (prev.p === undefined) delete process.env.HZ_PROVIDER;
      else process.env.HZ_PROVIDER = prev.p;
      if (prev.m === undefined) delete process.env.HZ_MODEL;
      else process.env.HZ_MODEL = prev.m;
    }
  });
});
