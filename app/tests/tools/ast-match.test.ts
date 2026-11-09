/** ast-match — the pure, bounded structural matcher (tokenize/match/rewrite). */

import { describe, expect, test } from "bun:test";
import { matchPattern, rewriteMatches, tokenize } from "../../src/tools/ast-match";

describe("ast-match tokenizer", () => {
  test("splits source into structural tokens, not raw substrings", () => {
    const toks = tokenize("foo(bar)").map((t) => t.text);
    expect(toks).toEqual(["foo", "(", "bar", ")"]);
  });

  test("whitespace separates tokens but is not itself a token", () => {
    const toks = tokenize("foo ( bar )").map((t) => t.text);
    expect(toks).toEqual(["foo", "(", "bar", ")"]);
  });

  test("recognises string literals and numbers as single tokens", () => {
    const toks = tokenize('x = "a b" + 42').map((t) => ({ k: t.kind, t: t.text }));
    expect(toks).toEqual([
      { k: "identifier", t: "x" },
      { k: "punct", t: "=" },
      { k: "string", t: '"a b"' },
      { k: "punct", t: "+" },
      { k: "number", t: "42" },
    ]);
  });
});

describe("ast-match matchPattern", () => {
  test("a literal structural match is found regardless of whitespace", () => {
    expect(matchPattern("foo( $A )", "foo(bar)").map((m) => m.metaVariables.A)).toEqual(["bar"]);
    expect(matchPattern("foo( $A )", "foo ( bar )").map((m) => m.metaVariables.A)).toEqual(["bar"]);
  });

  test("the match is token-level, so `foobar` is NOT a match for `foo( $A )`", () => {
    // Proof the matcher is structural, not substring: `foobar` is one token.
    expect(matchPattern("foo( $A )", "foobar")).toEqual([]);
  });

  test("$NAME captures exactly one token", () => {
    const hits = matchPattern("foo($A)", "foo(x); foo(y)");
    expect(hits.map((m) => m.metaVariables.A)).toEqual(["x", "y"]);
    // A two-token argument does not fit a single-token capture.
    expect(matchPattern("foo($A)", "foo(a b)")).toEqual([]);
  });

  test("$$$NAME captures a (possibly empty) run of tokens across an argument list", () => {
    const hit = matchPattern("f($$$A)", "f(a, b, c)");
    expect(hit.length).toBe(1);
    expect(hit[0].metaVariables.A).toBe("a, b, c");
    // Empty variadic: zero tokens between the parens still matches.
    const empty = matchPattern("f($$$A)", "f()");
    expect(empty.length).toBe(1);
    expect(empty[0].metaVariables.A).toBe("");
  });

  test("same-metavariable identity: a repeated $A binds only to equal captures", () => {
    expect(matchPattern("$A && $A()", "if (x && x()) {}").map((m) => m.text)).toEqual(["x && x()"]);
    expect(matchPattern("$A && $A()", "if (x && y()) {}")).toEqual([]);
  });

  test("matches report line/column ranges", () => {
    const hit = matchPattern("foo($A)", "line1\nfoo(z)\n");
    expect(hit.length).toBe(1);
    expect(hit[0].startLine).toBe(2);
    expect(hit[0].startColumn).toBe(1);
    expect(hit[0].text).toBe("foo(z)");
  });

  test("an empty pattern yields no matches", () => {
    expect(matchPattern("", "anything")).toEqual([]);
  });
});

describe("ast-match rewriteMatches", () => {
  test("substitutes captures into the template and reports the count", () => {
    const r = rewriteMatches("foo(1); foo(2)", "foo($A)", "bar($A)");
    expect(r.count).toBe(2);
    expect(r.text).toBe("bar(1); bar(2)");
    expect(r.changes.length).toBe(2);
    expect(r.changes[0]).toMatchObject({ before: "foo(1)", after: "bar(1)" });
  });

  test("expands a variadic capture in the template", () => {
    const r = rewriteMatches("call(a, b, c)", "call($$$A)", "invoke($$$A)");
    expect(r.count).toBe(1);
    expect(r.text).toBe("invoke(a, b, c)");
  });

  test("zero matches returns count 0 and the text unchanged", () => {
    const r = rewriteMatches("hello world", "foo($A)", "bar($A)");
    expect(r.count).toBe(0);
    expect(r.text).toBe("hello world");
    expect(r.changes).toEqual([]);
  });

  test("an unknown template metavariable is left verbatim", () => {
    const r = rewriteMatches("foo(1)", "foo($A)", "bar($A, $B)");
    expect(r.count).toBe(1);
    expect(r.text).toBe("bar(1, $B)");
  });
});
