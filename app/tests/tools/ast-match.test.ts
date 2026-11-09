/** ast-match — the pure, bounded structural matcher (tokenize/match/rewrite). */

import { describe, expect, test } from "bun:test";
import { MAX_MATCHES, matchBudget, MAX_SOURCE_BYTES, matchPattern, rewriteMatches, scanPattern, tokenize } from "../../src/tools/ast-match";

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

describe("ast-match $$$ balance (review issue 1)", () => {
  test("foo($$$A) stops at each call's own closer across sibling calls", () => {
    const src = "foo(a); bar(b);\nfoo(c);";
    const hits = matchPattern("foo($$$A)", src);
    expect(hits.map((h) => h.text)).toEqual(["foo(a)", "foo(c)"]);
    expect(hits.map((h) => h.metaVariables.A)).toEqual(["a", "c"]);
  });

  test("nested calls: the capture spans the balanced inner call", () => {
    const hits = matchPattern("foo($$$A)", "foo(bar(1, 2), [3, 4], {x: 5})");
    expect(hits.length).toBe(1);
    expect(hits[0]?.metaVariables.A).toBe("bar(1, 2), [3, 4], {x: 5}");
  });

  test("rewrite of sibling calls renames every call, not just the first span", () => {
    const r = rewriteMatches("foo(a); bar(b);\nfoo(c);\n", "foo($$$A)", "baz($$$A)");
    expect(r.count).toBe(2);
    expect(r.text).toBe("baz(a); bar(b);\nbaz(c);\n");
  });

  test("a variadic never escapes its enclosing group", () => {
    // No `)` after the unbalanced `(`: must not match by running off the end.
    expect(matchPattern("foo($$$A)", "x(foo(a, b")).toEqual([]);
  });
});

describe("ast-match caps and skips (review issues 2 and 4)", () => {
  test("rewriteMatches reports truncation when more than MAX_MATCHES exist", () => {
    const src = "foo(1);\n".repeat(MAX_MATCHES + 500);
    const r = rewriteMatches(src, "foo($A)", "bar($A)");
    expect(r.count).toBe(MAX_MATCHES);
    expect(r.truncated).toBe(true);
  });

  test("exactly MAX_MATCHES matches is not truncated", () => {
    const r = rewriteMatches("foo(1);\n".repeat(MAX_MATCHES), "foo($A)", "bar($A)");
    expect(r.count).toBe(MAX_MATCHES);
    expect(r.truncated).toBe(false);
  });

  test("oversize source is reported as skipped, not as no-match", () => {
    const big = `foo(1);${" ".repeat(MAX_SOURCE_BYTES)}`;
    const scan = scanPattern("foo($A)", big);
    expect(scan.skipped).toBe("too-large");
    expect(scan.matches).toEqual([]);
    expect(rewriteMatches(big, "foo($A)", "x").skipped).toBe("too-large");
  });
});

describe("ast-match lexer families (review issue 3)", () => {
  const rust = "fn x<'a>(v:&'a str){ foo(1) } fn y<'b>(){ foo(2) }";
  test("Rust lifetimes do not swallow later code", () => {
    expect(matchPattern("foo($A)", rust, { lang: "rs" }).map((h) => h.text)).toEqual(["foo(1)", "foo(2)"]);
  });

  test("Rust char literals are still strings", () => {
    const toks = tokenize("let c = 'x'; let e = '\\n';", { lang: "rust" });
    expect(toks.filter((t) => t.kind === "string").map((t) => t.text)).toEqual(["'x'", "'\\n'"]);
  });

  test("Python // is floor division and # starts a comment", () => {
    const src = "x = a // b\nfoo(1)  # foo(2)\n";
    const hits = matchPattern("foo($A)", src, { lang: "py" });
    expect(hits.map((h) => h.text)).toEqual(["foo(1)"]);
    expect(tokenize("a // b", { lang: "py" }).map((t) => t.text)).toEqual(["a", "/", "/", "b"]);
  });

  test("C-family // still comments out code", () => {
    expect(matchPattern("foo($A)", "// foo(1)\nfoo(2)", { lang: "ts" }).map((h) => h.text)).toEqual(["foo(2)"]);
  });

  test("unterminated quotes are counted instead of swallowing following lines", () => {
    const scan = scanPattern("foo($A)", "it's\nfoo(1)\n");
    expect(scan.lexIssues).toBe(1);
    expect(scan.matches.map((m) => m.text)).toEqual(["foo(1)"]);
  });

  test("Python triple-quoted strings may span lines without issues", () => {
    const scan = scanPattern("foo($A)", '"""doc\nit\'s"""\nfoo(1)\n', { lang: "py" });
    expect(scan.lexIssues).toBe(0);
    expect(scan.matches.map((m) => m.text)).toEqual(["foo(1)"]);
  });
});

describe("ast-match end positions (review issue 8)", () => {
  test("a match ending in a multi-line token reports the real end line and column", () => {
    const src = "foo(`a\nbc`)";
    const [m] = matchPattern("foo($A)", src);
    expect(m?.startLine).toBe(1);
    expect(m?.endLine).toBe(2);
    expect(m?.endColumn).toBe(5); // line 2 is "bc`)" -> one past the `)`
  });

  test("single-line end column is one past the last character", () => {
    const [m] = matchPattern("foo($A)", "  foo(bar)");
    expect(m?.endColumn).toBe(11);
  });

  test("work budget: a multi-variadic non-matching pattern returns promptly as skipped 'budget'", () => {
    const src = "a b c d e f g h ".repeat(300); // ~2400 tokens, no 'zzz'
    const t0 = Date.now();
    const scan = scanPattern("$$$A $$$B zzz", src);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(scan.skipped).toBe("budget");
    expect(scan.matches).toEqual([]);
  });

  test("work budget: shrinking maxSteps trips 'budget' and restoring it matches normally", () => {
    const saved = matchBudget.maxSteps;
    try {
      matchBudget.maxSteps = 5;
      expect(scanPattern("foo($$$A)", "foo(a, b, c); foo(d);").skipped).toBe("budget");
      expect(rewriteMatches("foo(a);", "foo($A)", "bar($A)").skipped).toBe("budget");
    } finally {
      matchBudget.maxSteps = saved;
    }
    expect(scanPattern("foo($$$A)", "foo(a, b, c);").skipped).toBeNull();
  });
});
