/**
 * prompt-working-directory.test.ts — port of grok prompt_working_directory
 * (Tier 3): hide the real worktree path from the model, show a display cwd.
 */
import { describe, expect, test } from "bun:test";
import { displayWorkingDir, redactWorktreePath } from "../../src/core/prompt-working-directory";

describe("prompt working directory redaction (grok port)", () => {
  test("displayWorkingDir prefers the display path and falls back to the real one", () => {
    expect(displayWorkingDir("/home/me/project", "/workspace")).toBe("/workspace");
    expect(displayWorkingDir("/home/me/project")).toBe("/home/me/project");
    expect(displayWorkingDir("/home/me/project", "  ")).toBe("/home/me/project");
  });

  test("redactWorktreePath replaces the real path everywhere in prompt text", () => {
    const text = "Read /home/me/project/src/a.ts from /home/me/project (cwd /home/me/project)";
    expect(redactWorktreePath(text, "/home/me/project", "/workspace")).toBe(
      "Read /workspace/src/a.ts from /workspace (cwd /workspace)",
    );
  });

  test("an absent display path leaves the text unchanged", () => {
    const text = "file at /home/me/project/a.ts";
    expect(redactWorktreePath(text, "/home/me/project")).toBe(text);
  });

  test("no real-path occurrence is a no-op (no fabricated edits)", () => {
    expect(redactWorktreePath("nothing here", "/home/me/project", "/workspace")).toBe("nothing here");
  });
});
