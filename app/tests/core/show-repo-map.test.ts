import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { assertPublishedNumber, parsePublishedNumber } from "../../src/core/metrics";
import {
  buildShowRepoMap,
  buildShowRepoMapResult,
  showRepoMapPublication,
} from "../../src/core/show-repo-map";

describe("buildShowRepoMap", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-rm-show-"));
    mkdirSync(path.join(workspace, "src"), { recursive: true });
    writeFileSync(
      path.join(workspace, "src", "main.ts"),
      "export function main() { return 1; }\n",
      "utf8",
    );
  });

  test("renders repo_map header for a tiny tree", () => {
    const out = buildShowRepoMap({ workspace, maxTokens: 2000 });
    expect(out).toContain("[repo_map:");
    expect(out.toLowerCase()).toContain("main");
  });

  test("showRepoMapPublication contracts empty/budget/chars (ruling 618)", () => {
    const shown = buildShowRepoMapResult({ workspace, maxTokens: 2000 });
    expect(shown.empty).toBe(false);
    const blocks = showRepoMapPublication({
      empty: shown.empty,
      budgetTokens: shown.budgetTokens,
      mapChars: shown.mapChars,
    });
    expect(blocks).toHaveLength(3);
    for (const block of blocks) assertPublishedNumber(block);
    expect(Number(parsePublishedNumber(blocks[0]!).value)).toBe(0);
    expect(Number(parsePublishedNumber(blocks[1]!).value)).toBe(shown.budgetTokens);
    expect(Number(parsePublishedNumber(blocks[2]!).value)).toBe(shown.mapChars);
  });
});
