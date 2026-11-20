import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import {
  ANALYTICS_LOG_FILE,
  admitAnalyticsLogWrite,
  analyticsEventCatalogue,
  analyticsFieldCatalogue,
  analyticsLogEnabled,
  analyticsRowFields,
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
  test("off by default — no path, no file", async () => {
    const ws = freshWorkspace();
    expect(analyticsLogEnabled(ws, {})).toBe(false);
    expect(resolveAnalyticsLogPath(ws, {})).toBeUndefined();
    expect(await appendAnalyticsEvent({ workspace: ws, event: "session.start", env: {} })).toBeUndefined();
    expect(existsSync(defaultAnalyticsLogPath(ws))).toBe(false);
  });

  test("HZ_ANALYTICS_LOG=1 writes NDJSON under workspace state", async () => {
    const ws = freshWorkspace();
    const env = { HZ_ANALYTICS_LOG: "1", HZ_JSONL_FSYNC: "0" };
    const expected = join(workspaceStateDir(ws), ANALYTICS_LOG_FILE);
    expect(resolveAnalyticsLogPath(ws, env)).toBe(expected);

    const written = await appendAnalyticsEvent({
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

  test("append is best-effort and stacks multiple events", async () => {
    const ws = freshWorkspace();
    mkdirSync(workspaceStateDir(ws), { recursive: true });
    const env = { HZ_ANALYTICS_LOG: "1", HZ_JSONL_FSYNC: "0" };
    await appendAnalyticsEvent({ workspace: ws, event: "cli.flag", flag: "show-repo-map", env });
    await appendAnalyticsEvent({ workspace: ws, event: "session.end", sessionId: "s1", env });
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

  test("I-4 catalogue: local event names and scalar fields are fixed data", () => {
    const events = analyticsEventCatalogue();
    expect(events.length).toBeGreaterThan(3);
    expect(events).toContain("session.start");
    expect(events).toContain("batch.row");
    expect(events).toContain("eval.completed");
    const fields = analyticsFieldCatalogue();
    expect(fields.sessionId).toBe("string");
    expect(fields.costMicroUsd).toBe("number");
    expect(fields.batchDone).toBe("number");
    // Never a content/key/path field.
    for (const forbidden of ["content", "task", "apiKey", "message", "path"]) {
      expect(fields).not.toHaveProperty(forbidden);
    }
  });

  test("I-4 richer rows: scalar facts are recorded, unknown fields are dropped", async () => {
    const ws = freshWorkspace();
    const env = { HZ_ANALYTICS_LOG: "1", HZ_JSONL_FSYNC: "0" };
    // A caller cannot declare these in the typed options; spread a plain map so
    // the runtime allowlist is what stands between them and the log.
    const smuggled: Record<string, unknown> = { content: "the secret chat text", apiKey: "sk-LEAK" };
    const written = await appendAnalyticsEvent({
      ...smuggled,
      workspace: ws,
      event: "batch.row",
      sessionId: "s9",
      terminal: "succeeded",
      toolCount: 3,
      stepCount: 7,
      batchSize: 10,
      batchDone: 4,
      batchFailed: 1,
      durationMs: 1234,
      costMicroUsd: 1500.6,
      env,
      now: () => "2026-11-16T00:00:00.000Z",
    });
    expect(written).toBeDefined();
    const row = JSON.parse(readFileSync(written!, "utf8").trim());
    expect(row).toEqual({
      v: 1,
      ts: "2026-11-16T00:00:00.000Z",
      event: "batch.row",
      sessionId: "s9",
      terminal: "succeeded",
      toolCount: 3,
      stepCount: 7,
      batchSize: 10,
      batchDone: 4,
      batchFailed: 1,
      durationMs: 1234,
      costMicroUsd: 1501,
    });
    expect(row).not.toHaveProperty("content");
    expect(row).not.toHaveProperty("apiKey");
  });

  test("I-4 allowlist rejects badly typed values and blank strings", () => {
    expect(analyticsRowFields({ toolCount: -1, stepCount: Number.NaN, durationMs: Infinity })).toEqual({});
    expect(analyticsRowFields({ sessionId: "  ", flag: "" })).toEqual({});
    expect(analyticsRowFields({ provider: "mock", costMicroUsd: 12 })).toEqual({ provider: "mock", costMicroUsd: 12 });
  });

  test("admitAnalyticsLogWrite refuses deny before persist (ruling 600)", async () => {
    const ws = freshWorkspace();
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(ws, "no-such-hz-kernel");
    try {
      const kernelState = path.join(ws, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-analytics" }]),
        "utf8",
      );
      const file = defaultAnalyticsLogPath(ws);
      const refused = await admitAnalyticsLogWrite(file, ws);
      expect(refused).toMatch(/denied|test-deny-analytics|analytics-log/i);
      const written = await appendAnalyticsEvent({
        workspace: ws,
        event: "session.start",
        env: { HZ_ANALYTICS_LOG: "1", HZ_JSONL_FSYNC: "0" },
      });
      expect(written).toBeUndefined();
      expect(existsSync(file)).toBe(false);
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  }, 20_000);

  test("admitAnalyticsLogWrite treats ask as allow (opt-in is consent)", async () => {
    const ws = freshWorkspace();
    const kernelState = path.join(ws, ".hzcode", "kernel");
    mkdirSync(kernelState, { recursive: true });
    writeFileSync(
      path.join(kernelState, "policy.json"),
      JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "ask" }]),
      "utf8",
    );
    const file = path.join(ws, "analytics-ask.ndjson");
    expect(await admitAnalyticsLogWrite(file, ws)).toBeUndefined();
    const written = await appendAnalyticsEvent({
      workspace: ws,
      event: "session.start",
      env: { HZ_ANALYTICS_LOG: file, HZ_JSONL_FSYNC: "0" },
    });
    expect(written).toBe(file);
    expect(existsSync(file)).toBe(true);
  }, 20_000);

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
