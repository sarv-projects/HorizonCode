import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANALYTICS_LOG_FILE,
  analyticsLogEnabled,
  appendAnalyticsEvent,
  applyAnalyticsLogCliFlag,
  defaultAnalyticsLogPath,
  resolveAnalyticsLogPath,
} from "../../src/core/analytics-log";
import { renderSettingsReport } from "../../src/core/settings-report";
import type { HzConfig } from "../../src/core/config";
import { workspaceStateDir } from "../../src/core/paths";

function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "hz-analytics-"));
}

const baseConfig: HzConfig = {
  provider: "mock",
  model: "mock-1",
  sources: { provider: "default", model: "default", baseUrl: "default", apiKey: "none" },
};

describe("analytics-log (I-4 / ruling 468)", () => {
  test("off by default — no path, no file", () => {
    const ws = freshWorkspace();
    expect(analyticsLogEnabled(ws, {})).toBe(false);
    expect(resolveAnalyticsLogPath(ws, {})).toBeUndefined();
    expect(appendAnalyticsEvent({ workspace: ws, event: "session.start", env: {} })).toBeUndefined();
    expect(existsSync(defaultAnalyticsLogPath(ws))).toBe(false);
  });

  test("HZ_ANALYTICS_LOG=1 writes NDJSON under workspace state", () => {
    const ws = freshWorkspace();
    const env = { HZ_ANALYTICS_LOG: "1", HZ_JSONL_FSYNC: "0" };
    const expected = join(workspaceStateDir(ws), ANALYTICS_LOG_FILE);
    expect(resolveAnalyticsLogPath(ws, env)).toBe(expected);

    const written = appendAnalyticsEvent({
      workspace: ws,
      event: "session.start",
      sessionId: "s1",
      provider: "mock",
      model: "mock-1",
      kernelMode: "untrusted",
      env,
      now: () => "2026-11-15T00:00:00.000Z",
    });
    expect(written).toBe(expected);
    const lines = readFileSync(expected, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!);
    expect(row).toEqual({
      v: 1,
      ts: "2026-11-15T00:00:00.000Z",
      event: "session.start",
      sessionId: "s1",
      provider: "mock",
      model: "mock-1",
      kernelMode: "untrusted",
    });
    // Privacy: no chat / keys fields on the row.
    expect(row).not.toHaveProperty("content");
    expect(row).not.toHaveProperty("apiKey");
    expect(row).not.toHaveProperty("message");
  });

  test("HZ_ANALYTICS_LOG=0 / false / off stay disabled", () => {
    const ws = freshWorkspace();
    for (const raw of ["0", "false", "off", "no"]) {
      expect(resolveAnalyticsLogPath(ws, { HZ_ANALYTICS_LOG: raw })).toBeUndefined();
    }
  });

  test("explicit path via env and CLI override", () => {
    const ws = freshWorkspace();
    const custom = join(ws, "custom-analytics.ndjson");
    expect(resolveAnalyticsLogPath(ws, { HZ_ANALYTICS_LOG: custom })).toBe(custom);

    const viaCli = resolveAnalyticsLogPath(ws, {}, custom);
    expect(viaCli).toBe(custom);

    const env: Record<string, string | undefined> = {};
    applyAnalyticsLogCliFlag(env, true);
    expect(env.HZ_ANALYTICS_LOG).toBe("1");
    applyAnalyticsLogCliFlag(env, custom);
    expect(env.HZ_ANALYTICS_LOG).toBe(custom);
  });

  test("append is best-effort and stacks multiple events", () => {
    const ws = freshWorkspace();
    mkdirSync(workspaceStateDir(ws), { recursive: true });
    const env = { HZ_ANALYTICS_LOG: "1", HZ_JSONL_FSYNC: "0" };
    appendAnalyticsEvent({ workspace: ws, event: "cli.flag", flag: "show-repo-map", env });
    appendAnalyticsEvent({ workspace: ws, event: "session.end", sessionId: "s1", env });
    const text = readFileSync(defaultAnalyticsLogPath(ws), "utf8");
    const rows = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.event).toBe("cli.flag");
    expect(rows[0]!.flag).toBe("show-repo-map");
    expect(rows[1]!.event).toBe("session.end");
  });

  test("/settings reports analytics log off or path", () => {
    const ws = freshWorkspace();
    const off = renderSettingsReport({ workspace: ws, home: ws, config: baseConfig, env: {} });
    expect(off).toContain("analyticsLog: off");
    expect(off).toContain(ANALYTICS_LOG_FILE);
    expect(off).not.toContain("Residual: local-only analytics log");

    const on = renderSettingsReport({
      workspace: ws,
      home: ws,
      config: baseConfig,
      env: { HZ_ANALYTICS_LOG: "1" },
    });
    expect(on).toContain(`analyticsLog: ${defaultAnalyticsLogPath(ws)}`);
  });
});
