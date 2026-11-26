/**
 * hunk-tracker.test.ts — grok xai-hunk-tracker ADAPT (VCS surface).
 * Pure per-hunk agent-vs-external attribution + path rewrite on cwd change.
 */
import { describe, expect, test } from "bun:test";
import {
  rewriteSinglePath,
  HunkTracker,
  type HunkSource,
} from "../../src/core/hunk-tracker";

describe("hunk tracker (grok port)", () => {
  test("rewriteSinglePath handles raw + canonical prefix variants (macOS /var→/private/var)", () => {
    expect(rewriteSinglePath("/old/cwd/sub/a.ts", "/old/cwd", "/old/cwd", "/new/cwd"))
      .toBe("/new/cwd/sub/a.ts");
    expect(rewriteSinglePath("/private/var/folders/a.ts", "/var/folders", "/private/var/folders", "/new/cwd"))
      .toBe("/new/cwd/a.ts");
    expect(rewriteSinglePath("/other/a.ts", "/old/cwd", "/old/cwd", "/new/cwd"))
      .toBeUndefined(); // outside old cwd
  });

  test("identity rewrite is a no-op value", () => {
    expect(rewriteSinglePath("/same/cwd/a.ts", "/same/cwd", "/same/cwd", "/same/cwd"))
      .toBe("/same/cwd/a.ts");
  });

  test("hunks are attributed agent vs external and indexed per prompt", () => {
    const t = new HunkTracker();
    t.record("a.ts", { type: "agent_edit", promptIndex: 3 });
    t.record("a.ts", { type: "external_edit_on_agent_file" });
    t.record("b.ts", { type: "external" });
    const a = t.forFile("a.ts");
    expect(a.map((h) => h.source.type)).toEqual(["agent_edit", "external_edit_on_agent_file"]);
    expect(t.forPrompt(3)).toHaveLength(1);
    expect(t.forPrompt(3)[0]!.path).toBe("a.ts");
  });

  test("cwd rewrite updates every tracked hunk path", () => {
    const t = new HunkTracker();
    t.record("/old/cwd/a.ts", { type: "agent_edit", promptIndex: 0 });
    t.rewritePaths("/old/cwd", "/old/cwd", "/new/cwd");
    expect(t.forFile("/new/cwd/a.ts")).toHaveLength(1);
    expect(t.forFile("/old/cwd/a.ts")).toHaveLength(0);
  });
});
