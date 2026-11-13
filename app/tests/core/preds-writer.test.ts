import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPredsFile, upsertPredsRecord } from "../../src/core/preds-writer";

describe("preds.json writer (J-1 reduced)", () => {
  test("upserts instances atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "hz-preds-"));
    const file = join(dir, "preds.json");
    upsertPredsRecord(file, {
      instance_id: "case-1",
      model_name_or_path: "mock",
      model_patch: "diff\n",
      exit_status: "succeeded",
    });
    const map = loadPredsFile(file);
    expect(map["case-1"]?.model_patch).toBe("diff\n");
    upsertPredsRecord(file, {
      instance_id: "case-2",
      model_name_or_path: "mock",
      model_patch: "other",
    });
    const next = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(next).sort()).toEqual(["case-1", "case-2"]);
  });
});
