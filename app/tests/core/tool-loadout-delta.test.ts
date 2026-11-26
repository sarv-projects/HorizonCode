/**
 * tool-loadout-delta.test.ts — Group B dynamic tool loadout delta (pi port).
 */
import { describe, expect, test } from "bun:test";
import { diffToolLoadout, renderToolLoadoutDelta } from "../../src/core/tool-loadout-delta";

describe("tool loadout delta (prefix-safe)", () => {
  test("diff is deterministic and names added/removed tools", () => {
    const d = diffToolLoadout(["read", "write", "shell"], ["read", "grep", "shell"]);
    expect(d.toolsAdded).toEqual(["grep"]);
    expect(d.toolsRemoved).toEqual(["write"]);
  });

  test("an unchanged loadout renders no delta (prefix untouched)", () => {
    expect(diffToolLoadout(["read"], ["read"])).toEqual({ toolsAdded: [], toolsRemoved: [] });
    expect(renderToolLoadoutDelta({ toolsAdded: [], toolsRemoved: [] })).toBeUndefined();
  });

  test("a change renders a bounded system delta without rewriting the prefix", () => {
    const delta = diffToolLoadout(["read"], ["read", "agent"]);
    const text = renderToolLoadoutDelta(delta);
    expect(text).toContain("<system-tool-loadout>");
    expect(text).toContain("toolsAdded: agent");
    expect(text).not.toContain("toolsRemoved");
  });

  test("duplicate names collapse; ordering is lexical", () => {
    const d = diffToolLoadout([], ["z", "a", "z"]);
    expect(d.toolsAdded).toEqual(["a", "z"]);
  });
});
