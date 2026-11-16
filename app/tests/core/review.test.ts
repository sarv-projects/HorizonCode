/** review — distill-time invisible/bidi hygiene at the review fork (G-6, ruling draft 501). */

import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../../src/core/canon";
import { INVISIBLE_BIDI_RE, sanitizeForDistill, stripInvisibleControls } from "../../src/core/distill-sanitize";
import {
  buildReviewFork,
  parentPrefixRecord,
  parseReviewProposals,
  ReviewForkError,
  reviewRequestTail,
} from "../../src/core/review";

function specWith(summary: string, id = "evt_1") {
  return buildReviewFork({
    parentPrefix: parentPrefixRecord("compiled system prefix"),
    transcript: [{ id, type: "message", summary }],
    workspace: "/tmp/hz-workspace",
    stateDir: "/tmp/hz-state",
  });
}

describe("distill sanitizer (G-6, ruling draft 501)", () => {
  test("strips zero-width characters that split tokens", () => {
    expect(sanitizeForDistill("a\u200Bllow \u200Call\u200Dowed \uFEFFgrant")).toBe("allow allowed grant");
    expect(stripInvisibleControls("a\u200Bllow").stripped).toBe(1);
    expect(stripInvisibleControls("a\u200Bllow").changed).toBe(true);
    expect(stripInvisibleControls("clean text").changed).toBe(false);
  });

  test("strips bidi embedding/override/isolate controls (Trojan-Source reorder)", () => {
    // The displayed line reads differently from its bytes until the controls
    // are removed; after sanitization the literal order is what a human sees.
    const trojan = "# safe\u202E trojan: rm -rf /\u202C done \u2066bidi\u2069";
    const clean = sanitizeForDistill(trojan);
    expect(clean).toBe("# safe trojan: rm -rf / done bidi");
    expect(clean).not.toMatch(INVISIBLE_BIDI_RE);
  });

  test("never strips meaningful whitespace or visible script characters", () => {
    const text = "a b\tc\nd\re\u2028f\u2029g\u2003h 世界🙂 مرحبا";
    expect(sanitizeForDistill(text)).toBe(text);
    expect(INVISIBLE_BIDI_RE.test(text)).toBe(false);
  });

  test("handles non-strings and invisible-only input without throwing", () => {
    expect(sanitizeForDistill(undefined)).toBe("");
    expect(sanitizeForDistill(null)).toBe("");
    expect(sanitizeForDistill(42)).toBe("");
    expect(sanitizeForDistill("\u200b\u2066\ufeff")).toBe("");
  });
});

describe("review fork distill path (G-6, ruling draft 501)", () => {
  test("transcript summaries are sanitized before entering the spec and tail", () => {
    const spec = specWith("user asked for a\u200Bllow\u202Eed access");
    expect(spec.transcript[0]!.summary).toBe("user asked for allowed access");
    const tail = reviewRequestTail(spec);
    expect(tail).toContain("user asked for allowed access");
    expect(tail).not.toMatch(INVISIBLE_BIDI_RE);
  });

  test("a transcript id made only of invisible controls is refused", () => {
    expect(() => specWith("summary", "\u200b\ufeff")).toThrow(ReviewForkError);
  });

  test("a hand-built spec is sanitized defensively in the request tail", () => {
    const spec = specWith("clean");
    const tampered = { ...spec, transcript: [{ id: "evt_1", summary: "hi\u200bdden\u202e text" }] };
    const tail = reviewRequestTail(tampered);
    expect(tail).toContain("hidden text");
    expect(tail).not.toMatch(INVISIBLE_BIDI_RE);
  });

  test("model output is sanitized before proposal parsing", () => {
    const output = '[{"ki\u200bnd":"memory","title":"T","body":"B","evidence":["ev\u200bt_1"],"reads":[]}]';
    const parsed = parseReviewProposals(output);
    expect(parsed).toHaveLength(1);
    expect((parsed![0] as { kind: string }).kind).toBe("memory");
    expect((parsed![0] as { evidence: string[] }).evidence).toEqual(["evt_1"]);
  });

  test("the cached system prefix is NOT sanitized (byte-for-byte parity is preserved)", () => {
    const system = "prefix\u200bwith\u202eformat";
    const spec = buildReviewFork({
      parentPrefix: { bytes: system, sha256: sha256Hex(system) },
      transcript: [],
      workspace: "/tmp/hz-workspace",
      stateDir: "/tmp/hz-state",
    });
    expect(spec.systemPrefix).toBe(system);
    expect(spec.cacheParity.identical).toBe(true);
  });
});
