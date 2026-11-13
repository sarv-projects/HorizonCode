import { describe, expect, test } from "bun:test";
import { effectiveRepoMapBudget, buildRepoMapWithLadder } from "../../src/tools/repo-map-ladder";
import { makeWorkspace } from "./helpers";

describe("repo-map ladder (B-2 reduced)", () => {
  test("expands default budget when no focus", () => {
    expect(effectiveRepoMapBudget(undefined, 4000)).toBe(8000);
    expect(effectiveRepoMapBudget(["src/a.ts"], 4000)).toBe(4000);
  });

  test("annotates ladder step on map output", () => {
    const ws = makeWorkspace({ "src/a.ts": "export function alpha() {}\n" });
    const result = buildRepoMapWithLadder({ root: ws, cwd: ws, indexFile: undefined });
    expect("empty" in result).toBe(false);
    if ("empty" in result) return;
    expect(result.map).toContain("ladder:");
    expect(result.ladderStep).toBe("repo");
  });
});
