import { describe, expect, test } from "bun:test";
import { checkWebSearch, doctorFixSuggestion, type DoctorEnv } from "../../src/core/doctor";

function fakeEnv(overrides: Record<string, string> = {}): DoctorEnv {
  return {
    env: { HOME: "/tmp", ...overrides },
    stdinIsTTY: false,
    stdoutIsTTY: false,
    workspace: "/tmp/ws",
    home: "/tmp",
  };
}

describe("web_search doctor", () => {
  test("WARN when backend unset", () => {
    const line = checkWebSearch(fakeEnv());
    expect(line.id).toBe("tools.web_search");
    expect(line.status).toBe("warn");
    expect(line.detail).toMatch(/fails closed/i);
  });

  test("OK when HZ_WEB_SEARCH=1", () => {
    const line = checkWebSearch(fakeEnv({ HZ_WEB_SEARCH: "1" }));
    expect(line.status).toBe("ok");
    expect(line.detail).toMatch(/duckduckgo-html/i);
  });

  test("doctor fix lines export backend hints", () => {
    const lines = doctorFixSuggestion("tools.web_search", {});
    expect(lines?.some((l) => l.includes("HZ_WEB_SEARCH=1"))).toBe(true);
  });

  test("checkWebSearch is exported for egress doctor group", () => {
    expect(typeof checkWebSearch).toBe("function");
  });
});