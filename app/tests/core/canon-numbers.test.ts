/**
 * canon-numbers.test.ts — the canonical number form (docs/05 D40).
 *
 * Numbers are the one JSON value whose serialization can silently change
 * meaning: JSON.stringify rewrites NaN and ±Infinity as `null`, and it prints
 * integers at or beyond ±2^53 as decimal literals whose digits imply a
 * precision a double cannot carry. The canonical serializer must refuse those
 * values — naming the path — instead of emitting a record that reads as valid
 * and hashes as something else.
 */

import { describe, expect, test } from "bun:test";
import {
  CanonicalNumberError,
  canonicalJson,
  digestOf,
  hashEnvelope,
  validateCanonicalNumbers,
} from "../../src/core/canon";

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53 - 1

function refusal(run: () => unknown): CanonicalNumberError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CanonicalNumberError);
    return error as CanonicalNumberError;
  }
  throw new Error("expected a CanonicalNumberError");
}

describe("canonical numbers (docs/05 D40)", () => {
  test("NaN is refused, never silently serialized as null", () => {
    // The failure mode this rule closes: the default JSON.stringify emits `null`.
    expect(JSON.stringify({ n: NaN })).toBe('{"n":null}');
    expect(() => canonicalJson(NaN)).toThrow(CanonicalNumberError);
    expect(() => canonicalJson(NaN)).toThrow(/refuses NaN at \$/);
  });

  test("+Infinity is refused", () => {
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(CanonicalNumberError);
    expect(() => canonicalJson([1, Infinity])).toThrow(/refuses \+Infinity at \$\[1\]/);
  });

  test("-Infinity is refused", () => {
    expect(() => canonicalJson({ x: -Infinity })).toThrow(/refuses -Infinity at \$\.x/);
  });

  test("negative zero serializes as 0", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson({ a: -0 })).toBe('{"a":0}');
  });

  test("doubles use the JSON.stringify shortest-round-trip form", () => {
    expect(canonicalJson(0.1)).toBe("0.1");
    expect(canonicalJson(1e21)).toBe("1e+21");
    expect(canonicalJson({ ratio: 0.1, huge: 1e21 })).toBe('{"huge":1e+21,"ratio":0.1}');
  });

  test("2^53 - 1 is accepted; 2^53 is refused as an unsafe integer", () => {
    expect(canonicalJson(MAX_SAFE)).toBe("9007199254740991");
    expect(canonicalJson(-MAX_SAFE)).toBe("-9007199254740991");
    const error = refusal(() => canonicalJson(2 ** 53));
    expect(error.kind).toBe("unsafe integer");
    expect(error.message).toContain("refuses unsafe integer 9007199254740992 at $");
    expect(() => canonicalJson(-(2 ** 53))).toThrow(CanonicalNumberError);
  });

  test("a decimal-form integer above 2^53 is refused; the exponential form is not", () => {
    // 1e20 is exactly representable, but "100000000000000000000" claims a precision
    // the format does not promise for integers. 1e21 escapes only because
    // JSON.stringify prints it exponentially ("1e+21"), which claims no finite digits.
    expect(() => canonicalJson(1e20)).toThrow(/refuses unsafe integer 100000000000000000000 at \$/);
    expect(canonicalJson(1e21)).toBe(JSON.stringify(1e21));
    expect(canonicalJson(1.5e21)).toBe(JSON.stringify(1.5e21));
  });

  test("a nested-object path is named in the refusal message", () => {
    const error = refusal(() => canonicalJson({ payload: { limits: { count: 2 ** 53 } } }));
    expect(error.kind).toBe("unsafe integer");
    expect(error.path).toBe("$.payload.limits.count");
    expect(error.message).toBe("canonical JSON refuses unsafe integer 9007199254740992 at $.payload.limits.count");
  });

  test("the walk is invoked by the serializer and valid payloads stay byte-identical", () => {
    expect(() => validateCanonicalNumbers({ ok: [1, 2.5, null] })).not.toThrow();
    // No local re-implementation: the bytes still come from the frozen serializer.
    expect(canonicalJson({ z: [1, 2.5, -0, "x"], a: { b: true, c: null } })).toBe(
      '{"a":{"b":true,"c":null},"z":[1,2.5,0,"x"]}',
    );
    expect(canonicalJson({ z: [1], a: 2 })).toBe('{"a":2,"z":[1]}');
  });

  test("the hash helpers refuse invalid numbers too", () => {
    expect(() =>
      hashEnvelope({
        id: "evt_1",
        seq: 1,
        ts: "2026-11-07T00:00:00.000Z",
        stream: "session:x",
        type: "session.start",
        actor: { kind: "agent", id: "agent-1" },
        payload: { temperature: NaN },
        prevHash: null,
      }),
    ).toThrow(/refuses NaN at \$\.payload\.temperature/);
    expect(() => digestOf({ nested: { count: 2 ** 53 } })).toThrow(CanonicalNumberError);
  });
});
