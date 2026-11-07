/**
 * hostile-read.test.ts — item 8's hostile-read fixtures (docs/30 §4): the
 * read tool against FIFOs, devices, symlink escapes, lexical escapes and
 * oversized files. Each fixture asserts the bounded, safe outcome — nothing
 * here may hang, load unbounded data, or guard a different path than the one
 * whose bytes are read.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { realpathSync, symlinkSync, truncateSync } from "node:fs";
import * as path from "node:path";
import { readTool } from "../../src/tools/read";
import { makeWorkspace, mockToolContext, tempRoot, writeFixture } from "./helpers";

/** Policy: allow reads whose REAL target is inside `root`, deny everything else. */
function insideOnly(root: string) {
  return (action: { kind: string; target: string }) =>
    action.target === root || action.target.startsWith(root + "/")
      ? ({ decision: "allow" } as const)
      : ({ decision: "deny", reason: "outside workspace" } as const);
}

describe("hostile read fixtures", () => {
  test("a FIFO is refused promptly instead of blocking forever", async () => {
    const ws = makeWorkspace({});
    execFileSync("mkfifo", [path.join(ws, "pipe")]);
    const started = Date.now();
    const r = await readTool.execute({ path: "pipe" }, mockToolContext({ cwd: ws }));
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not a regular file");
    expect(elapsed).toBeLessThan(2000);
  }, 5000);

  test("a device file is refused (unbounded source)", async () => {
    const ws = makeWorkspace({});
    const r = await readTool.execute({ path: "/dev/zero" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not a regular file");
  });

  test("a symlink to a device is resolved before Guard and still refused", async () => {
    const ws = makeWorkspace({});
    symlinkSync("/dev/zero", path.join(ws, "zlink"));
    const ctx = mockToolContext({ cwd: ws });
    const r = await readTool.execute({ path: "zlink" }, ctx);
    // The guard saw the real target, not the symlink's lexical path…
    expect(ctx.guardCalls.length).toBe(1);
    expect(ctx.guardCalls[0]?.target).toBe("/dev/zero");
    // …and the read was refused as a non-regular file.
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not a regular file");
  });

  test("a symlink escaping the workspace is denied by policy on its real target", async () => {
    const outside = tempRoot();
    const secret = writeFixture(outside, "secret.txt", "TOP SECRET\n");
    const ws = makeWorkspace({ "inside.txt": "inside\n" });
    symlinkSync(secret, path.join(ws, "escape"));

    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realpathSync(ws)) });
    const r = await readTool.execute({ path: "escape" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("denied by policy");
    expect(r.error).toContain("outside workspace");
    expect(ctx.guardCalls[0]?.target).toBe(secret);
  });

  test("a lexical ../ escape is denied by policy", async () => {
    const outside = tempRoot();
    writeFixture(outside, "secret.txt", "TOP SECRET\n");
    const ws = makeWorkspace({});
    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realpathSync(ws)) });
    const r = await readTool.execute({ path: `../${path.basename(outside)}/secret.txt` }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("denied by policy");
  });

  test("a file inside the workspace still guards its real path and reads", async () => {
    const ws = makeWorkspace({ "a.txt": "hello\n" });
    const ctx = mockToolContext({ cwd: ws });
    const r = await readTool.execute({ path: "a.txt" }, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.guardCalls[0]?.target).toBe(path.join(realpathSync(ws), "a.txt"));
  });

  test("an oversized file is refused instead of loaded whole", async () => {
    const ws = makeWorkspace({ "big.txt": "" });
    const big = path.join(ws, "big.txt");
    truncateSync(big, 40 * 1024 * 1024); // sparse: instant
    const r = await readTool.execute({ path: "big.txt" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("file too large to read safely");
  });

  test("the not-found message is unchanged for a missing symlink target", async () => {
    const ws = makeWorkspace({});
    symlinkSync(path.join(ws, "gone.txt"), path.join(ws, "dangling"));
    const r = await readTool.execute({ path: "dangling" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("file not found");
  });
});
