/** `read` — line-numbered output, offset/limit windows, caps, refusals. */

import { describe, expect, test } from "bun:test";
import { readTool } from "../../src/tools/read";
import { makeWorkspace, mockToolContext, numberedLines, tempRoot, writeFixture } from "./helpers";

describe("read tool", () => {
  test("renders 1-based line numbers padded to six columns", async () => {
    const ws = makeWorkspace({ "a.txt": numberedLines(12) });
    const r = await readTool.execute({ path: "a.txt" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    const lines = r.output.split("\n");
    expect(lines.length).toBe(12);
    expect(lines[0]).toBe("     1| line 1");
    expect(lines[11]).toBe("    12| line 12");
  });

  test("strips a trailing CR from CRLF files", async () => {
    const ws = makeWorkspace({ "crlf.txt": "one\r\ntwo\r\n" });
    const r = await readTool.execute({ path: "crlf.txt" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("     1| one\n     2| two");
  });

  test("reports an empty file without failing", async () => {
    const ws = makeWorkspace({ "empty.txt": "" });
    const r = await readTool.execute({ path: "empty.txt" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("(empty file) empty.txt");
  });

  test("honours offset and limit", async () => {
    const ws = makeWorkspace({ "ten.txt": numberedLines(10) });
    const r = await readTool.execute({ path: "ten.txt", offset: 3, limit: 2 }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output.startsWith("     3| line 3\n     4| line 4\n")).toBe(true);
    expect(r.output).toContain("[truncated: lines 3-4 of 10; use offset/limit to continue]");
  });

  test("returns the tail for an offset near the end without claiming truncation", async () => {
    const ws = makeWorkspace({ "ten.txt": numberedLines(10) });
    const r = await readTool.execute({ path: "ten.txt", offset: 8 }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("     8| line 8\n     9| line 9\n    10| line 10");
  });

  test("reports an offset past the end of the file", async () => {
    const ws = makeWorkspace({ "ten.txt": numberedLines(10) });
    const r = await readTool.execute({ path: "ten.txt", offset: 50 }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("(no lines at offset 50; file has 10 lines) ten.txt");
  });

  test("caps output at 2000 lines and reports the cap", async () => {
    const ws = makeWorkspace({ "many.txt": numberedLines(2500) });
    // limit above the maximum proves the requested limit is clamped
    const r = await readTool.execute({ path: "many.txt", limit: 5000 }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    const lines = r.output.split("\n");
    expect(lines.length).toBe(2001);
    expect(lines[0]).toBe("     1| line 1");
    expect(lines[1999]).toBe("  2000| line 2000");
    expect(lines[2000]).toBe("[truncated: lines 1-2000 of 2500; use offset/limit to continue]");
  });

  test("caps output at 200KB and reports the byte cap", async () => {
    const ws = makeWorkspace({ "big.txt": numberedLines(3000, () => "x".repeat(100)) });
    const r = await readTool.execute({ path: "big.txt" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("reached the 204800 byte limit");
    const lines = r.output.split("\n");
    // the byte budget runs out before the 2000-line budget
    expect(lines.length).toBeLessThan(2000);
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThan(210_000);
  });

  test("refuses a binary file (contains a NUL byte)", async () => {
    const ws = makeWorkspace({ "bin.dat": new Uint8Array([0x68, 0x69, 0x00, 0x21]) });
    const r = await readTool.execute({ path: "bin.dat" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(false);
    expect(r.output).toBe("");
    expect(r.error).toBe("binary file (contains a NUL byte): bin.dat");
  });

  test("returns ok:false for a missing file", async () => {
    const ws = makeWorkspace();
    const r = await readTool.execute({ path: "nope.txt" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("file not found: nope.txt");
  });

  test("refuses a directory", async () => {
    const ws = makeWorkspace({ "dir/keep.txt": "inside\n" });
    const r = await readTool.execute({ path: "dir" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("is a directory: dir");
  });

  test("requires a path", async () => {
    const r = await readTool.execute({}, mockToolContext());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("path is required");
  });

  test("guards with fs.read and denies before touching the disk", async () => {
    const ws = makeWorkspace({ "a.txt": "hello\n" });
    const ctx = mockToolContext({ cwd: ws, decision: "deny", decisionReason: "outside scope" });
    const r = await readTool.execute({ path: "a.txt" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("denied by policy: outside scope");
    expect(ctx.guardCalls).toEqual([{ kind: "fs.read", target: `${ws}/a.txt` }]);
    expect(ctx.approveCalls.length).toBe(0);
  });

  test("asks before reading a file outside the workspace", async () => {
    const ws = makeWorkspace();
    const outside = writeFixture(tempRoot(), "outside.txt", "outside\n");
    const ctx = mockToolContext({ cwd: ws, decision: "ask", approve: false });
    const r = await readTool.execute({ path: outside }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("declined by user");
    expect(ctx.approveCalls.length).toBe(1);
    expect(ctx.approveCalls[0].kind).toBe("fs.read");
    expect(ctx.approveCalls[0].title).toBe(`Read ${outside}`);
    expect(ctx.approveCalls[0].detail).toBe(outside);
  });

  test("reads when an ask is approved", async () => {
    const ws = makeWorkspace();
    const outside = writeFixture(tempRoot(), "approved.txt", "approved\n");
    const ctx = mockToolContext({ cwd: ws, decision: "ask", approve: true });
    const r = await readTool.execute({ path: outside }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toBe("     1| approved");
  });
});
