/**
 * memory-index-watermark.test.ts — V-20 watermark on a rebuilt recall index.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  memoryIndexMeta,
  memoryIndexWatermark,
  replaceMemoryIndex,
  rememberMemoryFact,
  forgetMemoryFacts,
  modelVersionFingerprint,
} from "../../src/core/memory/store";

test("rebuilt memory index records a deterministic watermark and fingerprint", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "hz-memwm-"));
  try {
    const fingerprint = "model:test-v1";
    replaceMemoryIndex(ws, ["alpha fact", "beta fact"], "project", undefined, { modelFingerprint: fingerprint });
    const meta = memoryIndexMeta(ws, "project");
    expect(meta?.modelFingerprint).toBe(fingerprint);
    expect(meta?.watermark).toBe(memoryIndexWatermark(["alpha fact", "beta fact"], fingerprint));

    replaceMemoryIndex(ws, ["alpha fact", "delta fact"], "project", undefined, { modelFingerprint: fingerprint });
    const next = memoryIndexMeta(ws, "project");
    expect(next?.watermark).not.toBe(meta?.watermark);
    expect(memoryIndexWatermark(["alpha fact"], fingerprint)).not.toBe(
      memoryIndexWatermark(["beta fact"], fingerprint),
    );
    expect(memoryIndexWatermark(["alpha fact"], "model:other")).not.toBe(
      memoryIndexWatermark(["alpha fact"], fingerprint),
    );
  // Incremental writers refresh the same watermark inside their transaction.
  const beforeIncremental = memoryIndexMeta(ws, "project")?.watermark;
  expect(rememberMemoryFact(ws, "epsilon fact").ok).toBe(true);
  const afterRemember = memoryIndexMeta(ws, "project")?.watermark;
  expect(afterRemember).not.toBe(beforeIncremental);
  expect(afterRemember).toBe(memoryIndexWatermark(["alpha fact", "delta fact", "epsilon fact"], fingerprint));
  // FTS5 DELETE reports token-row changes; the exact count is not a row count.
  expect(forgetMemoryFacts(ws, { content: "epsilon fact" }).deleted).toBeGreaterThanOrEqual(1);
  expect(memoryIndexMeta(ws, "project")?.watermark).toBe(beforeIncremental);
  const beforeNoop = memoryIndexMeta(ws, "project")?.watermark;
  expect(rememberMemoryFact(ws, "alpha fact").ok).toBe(false); // still present: duplicate
  expect(memoryIndexMeta(ws, "project")?.watermark).toBe(beforeNoop);
  expect(memoryIndexMeta(ws, "project")?.watermark).toBe(beforeIncremental);
  } finally {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* windows handle */
    }
  }
});

test("a full rebuild derives the model fingerprint from the active provider/model env", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "hz-memfp-"));
  const previousProvider = process.env.HZ_PROVIDER;
  const previousModel = process.env.HZ_MODEL;
  try {
    process.env.HZ_PROVIDER = "openai";
    process.env.HZ_MODEL = "gpt-test-1";
    replaceMemoryIndex(ws, ["fact one"]);
    const meta = memoryIndexMeta(ws, "project");
    expect(meta?.modelFingerprint).toBe(modelVersionFingerprint("openai", "gpt-test-1"));
    expect(meta?.watermark).toBe(
      memoryIndexWatermark(["fact one"], modelVersionFingerprint("openai", "gpt-test-1")),
    );
    expect(modelVersionFingerprint("openai", "gpt-test-1")).not.toBe(
      modelVersionFingerprint("anthropic", "gpt-test-1"),
    );
    expect(modelVersionFingerprint("openai", "gpt-test-1")).not.toBe(
      modelVersionFingerprint("openai", "gpt-test-2"),
    );
  } finally {
    if (previousProvider === undefined) delete process.env.HZ_PROVIDER;
    else process.env.HZ_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.HZ_MODEL;
    else process.env.HZ_MODEL = previousModel;
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* windows handle */
    }
  }
});
