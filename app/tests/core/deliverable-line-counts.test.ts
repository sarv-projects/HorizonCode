import { describe, expect, test } from "bun:test";
import { deliverableLineStats } from "../../src/core/deliverable-line-counts";
import { makeWorkspace } from "../tools/helpers";

describe("deliverableLineStats", () => {
  test("counts file lines", () => {
    const ws = makeWorkspace({ "a.txt": "one\ntwo\n" });
    const stats = deliverableLineStats(ws, ["a.txt"]);
    expect(stats[0]?.lines).toBe(3);
  });
});
