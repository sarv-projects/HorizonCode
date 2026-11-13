import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectPreCommitHookIds, harnessAutomationSection } from "../../src/core/pre-commit-hooks";

describe("pre-commit hooks (F-2 reduced)", () => {
  test("parses hook ids from config", () => {
    const ws = mkdtempSync(join(tmpdir(), "hz-pc-"));
    writeFileSync(
      join(ws, ".pre-commit-config.yaml"),
      `repos:\n- repo: local\n  hooks:\n  - id: eslint\n  - id: prettier\n`,
    );
    expect(detectPreCommitHookIds(ws)).toEqual(["eslint", "prettier"]);
    expect(harnessAutomationSection(ws)).toContain("eslint");
  });
});
