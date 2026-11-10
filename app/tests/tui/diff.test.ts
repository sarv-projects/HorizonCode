import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RICH_DIFF_LINE_CAP, richDiff, richDiffLines } from "../../src/tui/diff";
import { createRenderer } from "../../src/tui/render";
import { colorEnabled, setColorEnabled, strip } from "../../src/tui/style";

let was = false;
beforeAll(() => {
  was = colorEnabled();
  setColorEnabled(false);
});
afterAll(() => setColorEnabled(was));

const DIFF = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -40,4 +40,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
  " const d = 5;",
].join("\n");

describe("rich diff", () => {
  test("file header, hunk range and numbered +/- gutter", () => {
    const plain = richDiffLines(DIFF, { width: 60, level: 0 }).map(strip);
    expect(plain[0]).toBe("  \u258e src/app.ts");
    expect(plain[1]).toContain("\u22ef lines 40-43");
    expect(plain[2]).toBe("   40 \u2502  const a = 1;");
    expect(plain[3]).toBe("   41 \u2502- const b = 2;");
    expect(plain[4]).toBe("   41 \u2502+ const b = 3;");
    expect(plain[5]).toBe("   42 \u2502  const c = 4;");
  });

  test("long unchanged runs fold; backgrounds only at level 2+", () => {
    const ctx = Array.from({ length: 12 }, (_, i) => ` line ${i}`).join("\n");
    const d = `@@ -1,13 +1,13 @@\n${ctx}\n+added`;
    const plain = richDiffLines(d, { level: 0 }).map(strip).join("\n");
    expect(plain).toContain("8 unchanged lines");
    expect(richDiffLines("@@ -1 +1 @@\n+x", { level: 2 })[1]).toContain("\u001b[48;5;");
    expect(richDiffLines("@@ -1 +1 @@\n+x", { level: 1 })[1]).not.toContain("\u001b[48");
  });

  test("cap adds the N more lines footer", () => {
    const body = Array.from({ length: 100 }, (_, i) => `+row ${i}`).join("\n");
    const view = richDiff(`@@ -0,0 +1,100 @@\n${body}`, { level: 0, cap: 10 });
    expect(view.length).toBe(11);
    expect(strip(view[10]!)).toBe("  \u2026 91 more lines");
    expect(RICH_DIFF_LINE_CAP).toBe(40);
  });

  test("renderer: rich turn.diff uses the gutter, plain stays the old format", () => {
    const run = (rich: boolean): string => {
      const chunks: string[] = [];
      const r = createRenderer({ wrap: false, rich, out: (c) => void chunks.push(c) });
      r.handle({ type: "turn.diff", files: 1, diff: DIFF } as never);
      return strip(chunks.join(""));
    };
    expect(run(true)).toContain("   41 \u2502- const b = 2;");
    const plain = run(false);
    expect(plain).toContain("  -const b = 2;");
    expect(plain).not.toContain("\u2502");
  });
});
