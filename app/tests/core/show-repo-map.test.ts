import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { buildShowRepoMap } from "../../src/core/show-repo-map";

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
});
