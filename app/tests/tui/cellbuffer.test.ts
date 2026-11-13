import { describe, expect, test } from "bun:test";
import { bufferFromLines, diffBuffers, encodeBufferFull, encodeDiffRuns } from "../../src/tui/cellbuffer";

describe("cellbuffer", () => {
  test("diff emits goto+set only for changed cells", () => {
    const a = bufferFromLines(["hello", "world"], 8, 2);
    const b = bufferFromLines(["hello!", "world"], 8, 2);
    const runs = diffBuffers(a, b);
    expect(runs.some((r) => r.kind === "clear")).toBe(false);
    expect(runs.filter((r) => r.kind === "set").length).toBe(1);
  });

  test("size change clears full screen", () => {
    const a = bufferFromLines(["a"], 4, 1);
    const b = bufferFromLines(["a", "b"], 4, 2);
    const runs = diffBuffers(a, b);
    expect(runs[0]?.kind).toBe("clear");
    const encoded = encodeDiffRuns(runs);
    expect(encoded).toContain("\u001b[2J");
  });

  test("golden identical frames encode empty diff on incremental", () => {
    const buf = bufferFromLines(["ok"], 4, 1);
    const runs = diffBuffers(buf, buf);
    expect(runs.length).toBe(0);
  });

  test("encodeBufferFull preserves interior spaces", () => {
    const buf = bufferFromLines(["a b"], 5, 1);
    expect(encodeBufferFull(buf)).toContain("a b");
  });
});
