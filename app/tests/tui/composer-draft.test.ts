import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  admitComposerDraftWrite,
  clearAbortedComposerDraft,
  saveAbortedComposerDraft,
  takeAbortedComposerDraft,
} from "../../src/tui/composer-draft";
import { stateRoot } from "../../src/core/paths";

let workspace: string;

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("composer-draft", () => {
  test("save then take restores draft once", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-composer-draft-"));
    await saveAbortedComposerDraft(workspace, "sess-1", "hello while busy");
    expect(takeAbortedComposerDraft(workspace, "sess-1")).toBe("hello while busy");
    expect(takeAbortedComposerDraft(workspace, "sess-1")).toBeUndefined();
  }, 20_000);

  test("clear removes stash", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-composer-draft-"));
    await saveAbortedComposerDraft(workspace, "sess-2", "draft");
    clearAbortedComposerDraft(workspace, "sess-2");
    expect(takeAbortedComposerDraft(workspace, "sess-2")).toBeUndefined();
  }, 20_000);

  test("admitComposerDraftWrite refuses deny before persist (ruling 586)", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-composer-deny-"));
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(workspace, "no-such-hz-kernel");
    try {
      const kernelState = path.join(workspace, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-draft" }]),
        "utf8",
      );
      const refused = await admitComposerDraftWrite(workspace, "sess-deny");
      expect(refused).toMatch(/denied|test-deny-draft|composer-draft/i);
      const saveRefused = await saveAbortedComposerDraft(workspace, "sess-deny", "should not land");
      expect(saveRefused).toMatch(/denied|test-deny-draft|composer-draft/i);
      expect(takeAbortedComposerDraft(workspace, "sess-deny")).toBeUndefined();
      expect(existsSync(stateRoot(workspace))).toBe(true);
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  }, 20_000);
});
