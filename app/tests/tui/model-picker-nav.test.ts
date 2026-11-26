/**
 * model-picker-nav.test.ts -- arrow-key model picker navigation (docs/28 §14).
 * Pure selection state: filtering, wrapping and query edits, no TTY required.
 */
import { describe, expect, test } from "bun:test";
import {
  filterModelOptions,
  moveModelIndex,
  updateModelQuery,
  type ModelNavState,
} from "../../src/tui/model-picker-nav";
import { CURATED_MODELS } from "../../src/tui/interactive-model-picker";

const label = (m: (typeof CURATED_MODELS)[number]) => `${m.name} ${m.id} ${m.providerName}`;

describe("model picker navigation", () => {
  test("empty query keeps registry order", () => {
    expect(filterModelOptions(CURATED_MODELS, "", label)).toEqual([...CURATED_MODELS]);
  });

  test("fuzzy query filters and ranks matching models", () => {
    const hits = filterModelOptions(CURATED_MODELS, "gemini", label);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((m) => label(m).toLowerCase().includes("gemini"))).toBe(true);
    expect(filterModelOptions(CURATED_MODELS, "zzzz-not-a-model", label)).toEqual([]);
  });

  test("arrow keys wrap and home/end clamp", () => {
    expect(moveModelIndex({ query: "", index: 0 }, "down", 3)).toBe(1);
    expect(moveModelIndex({ query: "", index: 2 }, "down", 3)).toBe(0);
    expect(moveModelIndex({ query: "", index: 0 }, "up", 3)).toBe(2);
    expect(moveModelIndex({ query: "", index: 1 }, "home", 3)).toBe(0);
    expect(moveModelIndex({ query: "", index: 1 }, "end", 3)).toBe(2);
    expect(moveModelIndex({ query: "", index: 0 }, "down", 0)).toBe(0);
  });

  test("query edits append, backspace and clamp the selection", () => {
    const typed = updateModelQuery({ query: "", index: 0 }, "g");
    expect(typed.query).toBe("g");
    const erased = updateModelQuery(typed, "\x7f");
    expect(erased.query).toBe("");
    const clamped = updateModelQuery({ query: "gem", index: 5 }, "x");
    expect(clamped.query).toBe("gemx");
    expect(clamped.index).toBe(0);
  });
});
