import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { learnKbRoot, renderLearnChapter, renderLearnIndex } from "../../src/core/learn-kb";

describe("/learn reduced (G-5)", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-learn-"));
    const root = path.join(learnKbRoot(workspace), "chapters");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "intro.md"), "# Intro\n\nHello chapter.\n", "utf8");
    writeFileSync(
      path.join(learnKbRoot(workspace), "index.json"),
      JSON.stringify({
        chapters: [{ id: "intro", title: "Introduction", file: "chapters/intro.md", seeAlso: [] }],
      }),
      "utf8",
    );
  });

  test("index lists chapter ids", () => {
    const text = renderLearnIndex(workspace);
    expect(text).toContain("intro");
    expect(text).toContain("Introduction");
  });

  test("chapter render returns body only for one id", () => {
    const text = renderLearnChapter(workspace, "intro");
    expect(text).toContain("Hello chapter.");
    expect(text).toContain("# Introduction");
  });
});
