import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  clearAbortedComposerDraft,
  saveAbortedComposerDraft,
  takeAbortedComposerDraft,
} from "../../src/tui/composer-draft";

let workspace: string;

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("composer-draft", () => {
  test("save then take restores draft once", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-composer-draft-"));
    saveAbortedComposerDraft(workspace, "sess-1", "hello while busy");
    expect(takeAbortedComposerDraft(workspace, "sess-1")).toBe("hello while busy");
    expect(takeAbortedComposerDraft(workspace, "sess-1")).toBeUndefined();
  });

  test("clear removes stash", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-composer-draft-"));
    saveAbortedComposerDraft(workspace, "sess-2", "draft");
    clearAbortedComposerDraft(workspace, "sess-2");
    expect(takeAbortedComposerDraft(workspace, "sess-2")).toBeUndefined();
  });
});
