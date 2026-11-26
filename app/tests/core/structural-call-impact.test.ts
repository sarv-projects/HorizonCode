import { describe, expect, test } from "bun:test";
import { countStructuralCallSites } from "../../src/core/structural-call-impact";

describe("structural-call-impact (ruling 727)", () => {
  test("counts direct and generic call sites", () => {
    const text = `
import { helper } from "./x";
export function target<T>(x: T) { return x; }
const a = target(1);
const b = target<string>("x");
await target(2);
`;
    expect(countStructuralCallSites(text, "target")).toBe(3);
    expect(countStructuralCallSites(text, "helper")).toBe(0);
  });

  test("ignores comments, strings, and declarations", () => {
    const text = `
// target(ghost)
/* target(ghost) */
const s = "target(ghost)";
export function target() {}
const x = target;
`;
    expect(countStructuralCallSites(text, "target")).toBe(0);
  });

  test("counts method-style .name( chains", () => {
    const text = `obj.target();\nfoo?.target ( );`;
    expect(countStructuralCallSites(text, "target")).toBe(2);
  });

  test("counts optional calls, newline-separated calls, and template interpolations", () => {
    const text = [
      "target?.();",
      "target",
      "(1);",
      "const label = `saved ${target(2)}`;",
      "const plain = `target()`;",
    ].join("\n");
    expect(countStructuralCallSites(text, "target")).toBe(3);
  });
});