import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseModelsPollIntervalMs, startModelsCatalogPoll } from "../../src/core/catalog/catalog-poll";
import { createRuntime } from "../../src/core/index";

describe("models catalog poll", () => {
  test("disabled unless HZ_MODELS_POLL_MS is at least 60s", () => {
    expect(parseModelsPollIntervalMs({})).toBeUndefined();
    expect(parseModelsPollIntervalMs({ HZ_MODELS_POLL_MS: "1000" })).toBeUndefined();
    expect(parseModelsPollIntervalMs({ HZ_MODELS_POLL_MS: "120000" })).toBe(120_000);
  });

  test("start returns stop without network when disabled", () => {
    const stop = startModelsCatalogPoll({ intervalMs: undefined });
    expect(typeof stop).toBe("function");
    stop();
  });
});

describe("createRuntime catalog poll wire", () => {
  let workspace = "";
  const prev = process.env.HZ_MODELS_POLL_MS;
  afterEach(async () => {
    delete process.env.HZ_MODELS_POLL_MS;
    if (prev !== undefined) process.env.HZ_MODELS_POLL_MS = prev;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = "";
  });

  test("poll is off by default; enabled when HZ_MODELS_POLL_MS is set", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-poll-rt-"));
    const off = await createRuntime({ workspace, mock: true });
    await off.close();
    process.env.HZ_MODELS_POLL_MS = "120000";
    const on = await createRuntime({ workspace, mock: true });
    await on.close();
  });
});
