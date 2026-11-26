import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  takeWorkspaceFsSnapshot,
  diffWorkspaceFsSnapshot,
  observeArbitraryShellWorkspacePostimage,
  computeReceiptPostimage,
  ABSENT_POSTIMAGE_DIGEST,
} from "../../src/core/receipt-postimage";

describe("arbitrary shell postimage observation via workspace manifest snapshot", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(path.join(tmpdir(), "hz-arb-shell-"));
  });

  afterEach(() => {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {}
  });

  test("diffWorkspaceFsSnapshot detects single-file creation from arbitrary command", () => {
    const pre = takeWorkspaceFsSnapshot(ws);
    // Arbitrary command creates a file
    writeFileSync(path.join(ws, "output.json"), JSON.stringify({ ok: true }));

    const diff = diffWorkspaceFsSnapshot(pre, ws);
    expect(diff.mutations.length).toBe(1);
    expect(diff.mutations[0]!.kind).toBe("added");
    expect(diff.mutations[0]!.relPath).toBe("output.json");
    expect(diff.observationStable).toBe(true);

    const postimage = observeArbitraryShellWorkspacePostimage(ws, pre);
    expect(postimage.path).toBe(path.resolve(ws, "output.json"));
    expect(postimage.digest).toBe(diff.mutations[0]!.digest);
    expect(postimage.observationStable).toBe(true);
  });

  test("diffWorkspaceFsSnapshot detects multiple-file mutations and produces combined digest", () => {
    writeFileSync(path.join(ws, "a.txt"), "hello");
    const pre = takeWorkspaceFsSnapshot(ws);

    // Arbitrary build command modifies a.txt, adds b.txt, creates sub/c.txt
    writeFileSync(path.join(ws, "a.txt"), "hello world updated");
    writeFileSync(path.join(ws, "b.txt"), "binary artifact");
    mkdirSync(path.join(ws, "sub"));
    writeFileSync(path.join(ws, "sub", "c.txt"), "nested");

    const diff = diffWorkspaceFsSnapshot(pre, ws);
    expect(diff.mutations.length).toBeGreaterThanOrEqual(3);
    expect(diff.observationStable).toBe(true);

    const postimage = observeArbitraryShellWorkspacePostimage(ws, pre);
    expect(postimage.path).toBe(path.resolve(ws));
    expect(postimage.digest).toBe(diff.combinedDigest);
    expect(postimage.observationStable).toBe(true);
  });

  test("diffWorkspaceFsSnapshot detects file deletion from arbitrary script", () => {
    writeFileSync(path.join(ws, "temp.log"), "temporary logs");
    const pre = takeWorkspaceFsSnapshot(ws);

    unlinkSync(path.join(ws, "temp.log"));

    const diff = diffWorkspaceFsSnapshot(pre, ws);
    expect(diff.mutations.length).toBe(1);
    expect(diff.mutations[0]!.kind).toBe("deleted");
    expect(diff.mutations[0]!.digest).toBe(ABSENT_POSTIMAGE_DIGEST);

    const postimage = observeArbitraryShellWorkspacePostimage(ws, pre);
    expect(postimage.path).toBe(path.resolve(ws, "temp.log"));
    expect(postimage.digest).toBe(ABSENT_POSTIMAGE_DIGEST);
    expect(postimage.observationStable).toBe(true);
  });

  test("depth-truncated pre-snapshot cannot yield a stable workspace observation", () => {
    const nested = path.join(ws, "nested");
    mkdirSync(nested);
    const pre = takeWorkspaceFsSnapshot(ws, { maxDepth: 0 });

    // This file is below the pre-snapshot's traversal boundary.
    writeFileSync(path.join(nested, "hidden.txt"), "changed outside scan");

    const diff = diffWorkspaceFsSnapshot(pre, ws);
    expect(diff.observationStable).toBe(false);
    const postimage = observeArbitraryShellWorkspacePostimage(ws, pre);
    expect(postimage.observationStable).toBe(false);
  });

  test("computeReceiptPostimage integrates arbitrary shell snapshot", () => {
    const pre = takeWorkspaceFsSnapshot(ws);
    // Simulate arbitrary script execution
    writeFileSync(path.join(ws, "result.csv"), "col1,col2\n1,2\n");

    // Non-reduced command (e.g. python data_gen.py)
    const postimage = computeReceiptPostimage(
      "shell",
      { command: "python data_gen.py", __preSnapshot: pre },
      ws,
      true,
    );

    expect(postimage).toBeDefined();
    expect(postimage?.path).toBe(path.resolve(ws, "result.csv"));
    expect(postimage?.observationStable).toBe(true);
  });
});
