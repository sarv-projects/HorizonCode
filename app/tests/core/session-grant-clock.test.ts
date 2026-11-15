import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  __resetSessionGrantClockForTests,
  hydrateSessionGrantFromKernel,
  recordSessionGrantExpiry,
  sessionGrantRemainingMs,
} from "../../src/core/session-grant-clock";
import { LocalKernel } from "../../src/core/kernel";

afterEach(() => __resetSessionGrantClockForTests());

describe("session grant clock", () => {
  test("records and reports remaining ms", () => {
    const expiry = new Date(Date.now() + 12 * 60_000).toISOString();
    recordSessionGrantExpiry("sess-1", "shell.exec", "npm test", expiry);
    const rem = sessionGrantRemainingMs("sess-1", "shell.exec", "npm test");
    expect(rem).toBeGreaterThan(11 * 60_000);
    expect(rem).toBeLessThanOrEqual(12 * 60_000);
  });

  test("hydrateSessionGrantFromKernel reads local grant mirror", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "hz-grant-hydr-"));
    const local = new LocalKernel({ stateDir });
    await local.makeGrant("shell.exec", "npm test", 90_000, "sess-hydr");
    const kernel = {
      queryActiveGrantForAction: async (action: Parameters<LocalKernel["queryGrantForAction"]>[0], sessionId?: string) =>
        local.queryGrantForAction(action, sessionId) ?? undefined,
    };
    expect(
      await hydrateSessionGrantFromKernel(kernel, "sess-hydr", "shell.exec", "npm test"),
    ).toBe(true);
    expect(sessionGrantRemainingMs("sess-hydr", "shell.exec", "npm test")).toBeGreaterThan(0);
  });

  test("compound shell records each segment", () => {
    const expiry = new Date(Date.now() + 60_000).toISOString();
    recordSessionGrantExpiry("sess-2", "shell.exec", "echo a && ls", expiry);
    expect(sessionGrantRemainingMs("sess-2", "shell.exec", "ls")).toBeGreaterThan(0);
  });
});