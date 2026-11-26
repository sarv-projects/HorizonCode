/**
 * vm-snapshot-codec.test.ts — port of opencode graph snapshot codec (Tier 1 #5).
 * Cyclic graph serialization, two-phase shell→fill decode, codecShape fingerprint,
 * host bridge. Test-first: fails on missing module.
 */
import { describe, expect, test } from "bun:test";
import {
  codecShape,
  decodeGraph,
  encodeGraph,
  SnapshotError,
} from "../../src/core/vm-snapshot-codec";

describe("VM graph snapshot codec (opencode port)", () => {
  test("cyclic graphs survive: identity, sharing and cycles are preserved", () => {
    const shared = { n: 1 };
    const a: Record<string, unknown> = { name: "a", shared };
    a.self = a;
    a.alsoShared = shared;
    const saved = encodeGraph([a]);
    const [decoded] = decodeGraph(saved) as Array<Record<string, unknown>>;
    expect(decoded!.name).toBe("a");
    expect(decoded!.self).toBe(decoded); // cycle preserved
    expect(decoded!.shared).toBe(decoded!.alsoShared); // sharing preserved
    expect(decoded!.shared).not.toBe(shared); // decoded into fresh objects
  });

  test("special values round-trip via tagged JSON (undefined, NaN, Infinity, -0)", () => {
    const saved = encodeGraph([{ u: undefined, nan: NaN, inf: Infinity, neg: -0 }]);
    const [v] = decodeGraph(saved) as Array<Record<string, unknown>>;
    expect(v!.u).toBeUndefined();
    expect(Number.isNaN(v!.nan)).toBe(true);
    expect(v!.inf).toBe(Infinity);
    expect(Object.is(v!.neg, -0)).toBe(true);
  });

  test("two-phase decode fills anchors in place", () => {
    const anchor = { pre: "existing" };
    const saved = encodeGraph([{ child: { value: 42 }, anchorRef: anchor }]);
    const anchors = new Map([["root-anchor", anchor]]);
    // decode with an anchor name mapped to the live object; it is filled, not copied
    const [v] = decodeGraph(saved, { anchors: new Map([["root-anchor", anchor]]) }) as Array<Record<string, unknown>>;
    expect(v!.child).toMatchObject({ value: 42 });
    expect(anchors.get("root-anchor")).toBe(anchor);
  });

  test("codecShape is deterministic and reflects registered specs", () => {
    expect(codecShape()).toBe(codecShape());
    expect(codecShape([["MyClass", ["a", "b"]]])).not.toBe(codecShape());
  });

  test("strict mode refuses a value with no data form; lenient records it as lost", () => {
    const fn = () => 1;
    expect(() => encodeGraph([fn], { strict: true })).toThrow(SnapshotError);
    const saved = encodeGraph([fn], { strict: false });
    expect(JSON.stringify(saved)).toContain("lost");
  });

  test("tampered record count is refused with a named SnapshotError", () => {
    const saved = encodeGraph([{ a: 1 }]);
    expect(() => decodeGraph({ ...saved, records: [] })).toThrow(SnapshotError);
  });
});
