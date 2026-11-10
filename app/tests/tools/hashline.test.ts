/**
 * hashline.test.ts, docs/28 ruling 64: opt-in `read` anchors and the anchored `edit` mode.
 * Host-independent: fixtures in a temp dir, no clock, no network.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { editTool } from "../../src/tools/edit";
import { DEFAULT_SEARCH_RADIUS, anchorAt, findShifted, lineHash, parseAnchor, resolveAnchor, validateAnchor } from "../../src/tools/hashline";
import { readTool } from "../../src/tools/read";
import { makeWorkspace, mockToolContext, numberedLines, readFixture } from "./helpers";

const FILE = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"].join("\n") + "\n";

/** The anchor `read anchors:true` printed for 1-based `line`. */
async function anchorOf(ws: string, rel: string, line: number): Promise<string> {
  const r = await readTool.execute({ path: rel, anchors: true }, mockToolContext({ cwd: ws }));
  expect(r.ok).toBe(true);
  const row = r.output.split("\n")[line - 1] as string;
  return row.slice(0, row.indexOf("|"));
}

describe("read anchors (opt-in)", () => {
  test("default output is byte-identical: no anchors, six-column numbers", async () => {
    const ws = makeWorkspace({ "a.txt": numberedLines(3) });
    const plain = await readTool.execute({ path: "a.txt" }, mockToolContext({ cwd: ws }));
    expect(plain.output).toBe("     1| line 1\n     2| line 2\n     3| line 3");
    const off = await readTool.execute({ path: "a.txt", anchors: false }, mockToolContext({ cwd: ws }));
    expect(off.output).toBe(plain.output);
  });

  test("anchors:true renders LINE:abc:def| text and honours offset", async () => {
    const ws = makeWorkspace({ "a.txt": FILE });
    const r = await readTool.execute({ path: "a.txt", anchors: true, offset: 3, limit: 2 }, mockToolContext({ cwd: ws }));
    const rows = r.output.split("\n");
    expect(rows[0]).toMatch(/^3:[a-z]{3}:[a-z]{3}\| gamma$/);
    expect(rows[1]).toMatch(/^4:[a-z]{3}:[a-z]{3}\| delta$/);
  });

  test("the local hash ignores whitespace, so an indent change keeps the line valid locally", () => {
    expect(lineHash("  return x;")).toBe(lineHash("return x;"));
    expect(lineHash("a")).not.toBe(lineHash("b"));
  });
});

describe("anchor parsing and validation", () => {
  test("malformed anchors do not parse", () => {
    for (const bad of ["", "0:abc:def", "abc", "3", "3:ab:def", "3:ABC:def", "3:abc:de", "3:abc:def:ghi", "-1:abc:def"]) {
      expect(parseAnchor(bad)).toBeNull();
    }
    expect(parseAnchor("12:abc:def")).toEqual({ line: 12, local: "abc", context: "def" });
    expect(parseAnchor("12:abc")).toEqual({ line: 12, local: "abc", context: null });
  });

  test("valid, stale, out of range", () => {
    const lines = ["one", "two", "three"];
    const a = parseAnchor(`2:${lineHash("two")}:${resolveCtx(lines, 1)}`);
    expect(a).not.toBeNull();
    expect(validateAnchor(a!, lines)).toBe("valid");
    expect(validateAnchor(a!, ["one", "TWO!", "three"])).toBe("stale");
    expect(validateAnchor({ ...a!, line: 9 }, lines)).toBe("out_of_range");
  });

  test("a truncated anchor (no context) is stale even when the line matches", () => {
    const lines = ["one", "two", "three"];
    expect(validateAnchor({ line: 2, local: lineHash("two"), context: null }, lines)).toBe("stale");
    const r = resolveAnchor(`2:${lineHash("two")}`, lines);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toContain("truncated");
  });

  test("shift recovery is bounded by the radius", () => {
    const base = Array.from({ length: 60 }, (_, i) => `row ${i}`);
    const anchor = parseAnchor(`30:${lineHash(base[29] as string)}:${resolveCtx(base, 29)}`)!;
    const within = [...Array(DEFAULT_SEARCH_RADIUS).fill("pad"), ...base];
    expect(findShifted(anchor, within)).toEqual({ kind: "found", line: 30 + DEFAULT_SEARCH_RADIUS });
    const beyond = [...Array(DEFAULT_SEARCH_RADIUS + 1).fill("pad"), ...base];
    expect(findShifted(anchor, beyond)).toEqual({ kind: "not_found" });
  });
});

/** The context component of the anchor the production code emits. */
function resolveCtx(lines: string[], idx: number): string {
  return anchorAt(lines, idx).split(":")[2] as string;
}

describe("anchored edit", () => {
  test("replaces a single line and a range, writes via the preimage discipline", async () => {
    const ws = makeWorkspace({ "f.txt": FILE });
    const ctx = mockToolContext({ cwd: ws });
    const a = await anchorOf(ws, "f.txt", 2);
    const r = await editTool.execute({ path: "f.txt", start_anchor: a, new: "BETA" }, ctx);
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "f.txt")).toBe(FILE.replace("beta", "BETA"));
    expect(ctx.guardCalls.some((g) => g.kind === "fs.write")).toBe(true);

    const s = await anchorOf(ws, "f.txt", 4);
    const e = await anchorOf(ws, "f.txt", 5);
    const r2 = await editTool.execute({ path: "f.txt", start_anchor: s, end_anchor: e, new: "D1\nD2\nD3\n" }, ctx);
    expect(r2.ok).toBe(true);
    expect(readFixture(ws, "f.txt")).toBe("alpha\nBETA\ngamma\nD1\nD2\nD3\nzeta\neta\ntheta\n");
  });

  test("empty new deletes the lines; CRLF endings are preserved", async () => {
    const ws = makeWorkspace({ "c.txt": "a\r\nb\r\nc\r\n" });
    const a = await anchorOf(ws, "c.txt", 2);
    const r = await editTool.execute({ path: "c.txt", start_anchor: a, new: "" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "c.txt")).toBe("a\r\nc\r\n");
    const a3 = await anchorOf(ws, "c.txt", 1);
    const r2 = await editTool.execute({ path: "c.txt", start_anchor: a3, new: "X\nY" }, mockToolContext({ cwd: ws }));
    expect(r2.ok).toBe(true);
    expect(readFixture(ws, "c.txt")).toBe("X\r\nY\r\nc\r\n");
  });

  test("a small shift is recovered and reported", async () => {
    const ws = makeWorkspace({ "f.txt": FILE });
    const a = await anchorOf(ws, "f.txt", 5); // epsilon
    writeFileSync(path.join(ws, "f.txt"), "new1\nnew2\nnew3\n" + FILE);
    const r = await editTool.execute({ path: "f.txt", start_anchor: a, new: "EPS" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("anchors shifted: 5 -> 8");
    expect(readFixture(ws, "f.txt")).toBe("new1\nnew2\nnew3\n" + FILE.replace("epsilon", "EPS"));
  });

  test("a stale anchor with no nearby match refuses and writes nothing", async () => {
    const ws = makeWorkspace({ "f.txt": FILE });
    const a = await anchorOf(ws, "f.txt", 3);
    const changed = FILE.replace("gamma", "something else entirely");
    writeFileSync(path.join(ws, "f.txt"), changed);
    const r = await editTool.execute({ path: "f.txt", start_anchor: a, new: "x" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("stale");
    expect(readFixture(ws, "f.txt")).toBe(changed);
  });

  test("an out-of-range anchor refuses", async () => {
    const ws = makeWorkspace({ "f.txt": FILE });
    const a = await anchorOf(ws, "f.txt", 8);
    writeFileSync(path.join(ws, "f.txt"), "alpha\n");
    const r = await editTool.execute({ path: "f.txt", start_anchor: a, new: "x" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("out of range");
    expect(readFixture(ws, "f.txt")).toBe("alpha\n");
  });

  test("a truncated or malformed anchor refuses", async () => {
    const ws = makeWorkspace({ "f.txt": FILE });
    const a = await anchorOf(ws, "f.txt", 2);
    const truncated = a.split(":").slice(0, 2).join(":");
    const t = await editTool.execute({ path: "f.txt", start_anchor: truncated, new: "x" }, mockToolContext({ cwd: ws }));
    expect(t.ok).toBe(false);
    expect(t.error).toContain("truncated");
    const m = await editTool.execute({ path: "f.txt", start_anchor: "2:zz", new: "x" }, mockToolContext({ cwd: ws }));
    expect(m.ok).toBe(false);
    expect(m.error).toContain("malformed");
    expect(readFixture(ws, "f.txt")).toBe(FILE);
  });

  test("an ambiguous recovery refuses and names every candidate", async () => {
    const rep = ["a", "b", "c", "a", "b", "c", "a", "b", "c"];
    const ws = makeWorkspace({ "r.txt": rep.join("\n") + "\n" });
    const a = await anchorOf(ws, "r.txt", 5);
    const edited = rep.slice();
    edited[4] = "zzz";
    writeFileSync(path.join(ws, "r.txt"), edited.join("\n") + "\n");
    const r = await editTool.execute({ path: "r.txt", start_anchor: a, new: "x" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ambiguous");
    expect(r.error).toContain("2, 8");
    expect(readFixture(ws, "r.txt")).toBe(edited.join("\n") + "\n");
  });

  test("end before start, mixing with old, and a deny or declined approval write nothing", async () => {
    const ws = makeWorkspace({ "f.txt": FILE });
    const a2 = await anchorOf(ws, "f.txt", 2);
    const a4 = await anchorOf(ws, "f.txt", 4);
    const back = await editTool.execute({ path: "f.txt", start_anchor: a4, end_anchor: a2, new: "x" }, mockToolContext({ cwd: ws }));
    expect(back.ok).toBe(false);
    const mixed = await editTool.execute({ path: "f.txt", start_anchor: a2, old: "beta", new: "x" }, mockToolContext({ cwd: ws }));
    expect(mixed.ok).toBe(false);
    const denied = await editTool.execute({ path: "f.txt", start_anchor: a2, new: "x" }, mockToolContext({ cwd: ws, decision: "deny" }));
    expect(denied.ok).toBe(false);
    const declined = await editTool.execute(
      { path: "f.txt", start_anchor: a2, new: "x" },
      mockToolContext({ cwd: ws, decision: "ask", approve: false }),
    );
    expect(declined.ok).toBe(false);
    expect(declined.error).toContain("declined");
    expect(readFixture(ws, "f.txt")).toBe(FILE);
  });

  test("string mode is unchanged: old still required without start_anchor", async () => {
    const ws = makeWorkspace({ "f.txt": FILE });
    const r = await editTool.execute({ path: "f.txt", new: "x" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("old is required");
  });
});
