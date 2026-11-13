import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { appendJsonl, appendJsonlSync, jsonlFsyncEnabled } from "../../src/core/jsonl-append";

describe("jsonl-append", () => {
  test("jsonlFsyncEnabled defaults on; 0/false/off disable", () => {
    expect(jsonlFsyncEnabled({})).toBe(true);
    expect(jsonlFsyncEnabled({ HZ_JSONL_FSYNC: "0" })).toBe(false);
    expect(jsonlFsyncEnabled({ HZ_JSONL_FSYNC: "false" })).toBe(false);
    expect(jsonlFsyncEnabled({ HZ_JSONL_FSYNC: "off" })).toBe(false);
    expect(jsonlFsyncEnabled({ HZ_JSONL_FSYNC: "1" })).toBe(true);
  });

  test("appendJsonlSync writes a durable line", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-jsonl-"));
    try {
      const file = path.join(dir, "x.jsonl");
      appendJsonlSync(file, '{"a":1}\n', { HZ_JSONL_FSYNC: "0" });
      appendJsonlSync(file, '{"b":2}\n', { HZ_JSONL_FSYNC: "1" });
      expect(readFileSync(file, "utf8")).toBe('{"a":1}\n{"b":2}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appendJsonl async writes a durable line", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-jsonl-a-"));
    try {
      const file = path.join(dir, "y.jsonl");
      await appendJsonl(file, "one\n", { HZ_JSONL_FSYNC: "1" });
      expect(readFileSync(file, "utf8")).toBe("one\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("HZ_JSONL_FSYNC=0 skips fsyncSync", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-jsonl-off-"));
    const fsyncSpy = spyOn(fs, "fsyncSync");
    try {
      const file = path.join(dir, "z.jsonl");
      appendJsonlSync(file, '{"off":true}\n', { HZ_JSONL_FSYNC: "0" });
      expect(readFileSync(file, "utf8")).toBe('{"off":true}\n');
      expect(fsyncSpy).not.toHaveBeenCalled();
    } finally {
      fsyncSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("default append fsyncs file and parent directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-jsonl-on-"));
    const fsyncSpy = spyOn(fs, "fsyncSync");
    try {
      const file = path.join(dir, "w.jsonl");
      appendJsonlSync(file, "line\n", { HZ_JSONL_FSYNC: "1" });
      expect(fsyncSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      fsyncSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
