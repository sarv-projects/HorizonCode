/**
 * json-repair.test.ts - NF-069 tolerant tool-argument decoding (T-1).
 *
 * The corpus is ported from forgecode's forge_json_repair fixtures
 * (truncation.rs, special_quotes.rs, quotes.rs, punctuation.rs,
 * special_values.rs, error_cases.rs). Forge guesses aggressively (a cut value
 * becomes null, a bare word becomes a string). HorizonCode repairs only
 * syntactic defects and fails closed, so the divergent fixtures are asserted as
 * the safer outcome in the "fail closed" block below rather than skipped.
 */

import { describe, expect, test } from "bun:test";
import { coerceToSchema, parseToolArguments, repairJson } from "../../src/core/json-repair";
import { parseArguments } from "../../src/core/loop";

function repaired(input: string): unknown {
  const out = repairJson(input);
  if (!out.ok) throw new Error(`expected ${JSON.stringify(input)} to repair, got: ${out.error}`);
  return out.value;
}

describe("ported forge fixtures: truncation", () => {
  const cases: Array<[string, unknown]> = [
    ["{", {}],
    ['{"a":2', { a: 2 }],
    ['{"a":2,', { a: 2 }],
    ["[", []],
    ["[1,2,3", [1, 2, 3]],
    ["[1,2,3,", [1, 2, 3]],
    ['"foo', "foo"],
    ['["foo', ["foo"]],
    ['["foo",', ["foo"]],
    ['{"foo":"bar"', { foo: "bar" }],
    ['{"foo":"bar', { foo: "bar" }],
    ["2.", 2],
    ["2e", 2],
    ["2e+", 2],
    ["2e-", 2],
    ['"café ', "café"], // the blob is trimmed first
    ['{"a":{"b":[1,2', { a: { b: [1, 2] } }],
  ];
  for (const [input, expected] of cases) {
    test(`closes ${JSON.stringify(input)}`, () => {
      expect(repaired(input)).toEqual(expected);
      expect(repairJson(input).truncated).toBe(true);
    });
  }
  test("a member whose value was cut off is dropped, never completed with null", () => {
    for (const input of ['{"foo":', '{"foo"', '{"foo', '{"a":1,"b":']) {
      const out = repairJson(input);
      expect(out.ok).toBe(true);
      expect(out.truncated).toBe(true);
      expect(Object.values(out.value as object)).not.toContain(null);
    }
    expect(repaired('{"a":1,"b":')).toEqual({ a: 1 });
  });
});

describe("ported forge fixtures: quotes", () => {
  const cases: Array<[string, unknown]> = [
    ["{'a':2}", { a: 2 }],
    ["{'a':'foo'}", { a: "foo" }],
    [`{"a":'foo'}`, { a: "foo" }],
    ["{a:2}", { a: 2 }],
    ["{a: 2}", { a: 2 }],
    ["{true: 2}", { true: 2 }],
    ["{a:'foo',b:'bar'}", { a: "foo", b: "bar" }],
    ["\u2018foo\u2019", "foo"],
    ["\u201Cfoo\u201D", "foo"],
    ['{\u201Ca\u201D: \u201Cb\u201D}', { a: "b" }],
    ["{\u2018a\u2019: \u2018b\u2019}", { a: "b" }],
    ["{'msg': 'it's fine'}", { msg: "it's fine" }],
    ['{"msg": "it\u2019s \u201Cfine\u201D"}', { msg: "it\u2019s \u201Cfine\u201D" }],
  ];
  for (const [input, expected] of cases) {
    test(`reads ${JSON.stringify(input)}`, () => {
      expect(repaired(input)).toEqual(expected);
      expect(repairJson(input).truncated).toBe(false);
    });
  }
});

describe("ported forge fixtures: punctuation and special values", () => {
  const cases: Array<[string, unknown]> = [
    ["[1,2,3,]", [1, 2, 3]],
    ['{"a":2,}', { a: 2 }],
    ['{"a":[1,],}', { a: [1] }],
    ["True", true],
    ["False", false],
    ["None", null],
    ['{"a":undefined}', { a: null }],
    ["[undefined]", [null]],
  ];
  for (const [input, expected] of cases) {
    test(`repairs ${JSON.stringify(input)}`, () => {
      expect(repaired(input)).toEqual(expected);
    });
  }
  test("a stray code fence is stripped (complete or cut)", () => {
    expect(repaired('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(repaired('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(repairJson('```json\n{"a":1}\n```').repairs).toContain("stripped a code fence");
    const cut = repairJson('```json\n{"a":1');
    expect(cut.value).toEqual({ a: 1 });
    expect(cut.truncated).toBe(true);
  });
  test("raw newlines and tabs inside a string are escaped, not lost", () => {
    const out = repairJson('{"content":"a\nb\tc"}');
    expect(out.value).toEqual({ content: "a\nb\tc" });
    expect(out.repairs).toContain("escaped a raw control character");
  });
  test("an invalid escape keeps its backslash (a regex like \\d stays \\d)", () => {
    expect(repaired('{"pattern":"\\d+\\.js"}')).toEqual({ pattern: "\\d+\\.js" });
  });
  test("valid escapes decode normally", () => {
    expect(repaired('{"a":"x\\ny\\u0041\\"q\\""}')).toEqual({ a: 'x\nyA"q"' });
  });
});

describe("fail closed: where forge guesses, HorizonCode refuses", () => {
  const refused = [
    "", // forge: error too
    "{:2}", // forge: error too
    '{"a":2}{}', // forge: error too
    "hello world", // forge: a string; we: a bare word is not a value
    "{greeting: hello world}", // forge: guesses a string
    "{url:https://www.example.com/}", // forge: guesses a string
    "[1,foo,4]", // forge: guesses "foo"
    '{"a":}', // forge: null
    '{"a":2"b":3}', // forge: inserts a comma
    '{"a" "b"}', // forge: inserts a colon
    "{,}", // forge: strips
  ];
  for (const input of refused) {
    test(`does not guess ${JSON.stringify(input)}`, () => {
      expect(repairJson(input).ok).toBe(false);
    });
  }
  test("a cut tail is flagged so the caller can refuse it", () => {
    expect(repairJson('{"command":"rm -rf /tmp/x').truncated).toBe(true);
    expect(repairJson('{"command":"echo hi"}').truncated).toBe(false);
  });
  test("pathological nesting is an error, not a stack overflow", () => {
    expect(repairJson("[".repeat(5000)).ok).toBe(false);
  });
});

describe("schema coercion", () => {
  const schema = {
    type: "object",
    properties: {
      limit: { type: "integer" },
      ratio: { type: "number" },
      flag: { type: "boolean" },
      path: { type: "string" },
      names: { type: "array", items: { type: "string" } },
      nested: { type: "object", properties: { n: { type: "integer" } } },
    },
  };
  test("converts unambiguous scalars", () => {
    const out = coerceToSchema({ limit: "42", ratio: "1.5", flag: "true", path: "7" }, schema);
    expect(out.args).toEqual({ limit: 42, ratio: 1.5, flag: true, path: "7" });
    expect(out.coercions.length).toBe(3);
  });
  test("leaves ambiguous values alone", () => {
    const input = { limit: "4.5", ratio: "abc", flag: "yes", path: 7 };
    const out = coerceToSchema(input, schema);
    expect(out.args).toEqual(input);
    expect(out.coercions).toEqual([]);
  });
  test("decodes a JSON-encoded array or object passed as a string, and nested members", () => {
    const out = coerceToSchema({ names: '["a","b"]', nested: { n: "3" } }, schema);
    expect(out.args).toEqual({ names: ["a", "b"], nested: { n: 3 } });
  });
  test("a string-typed field is never touched, whatever it looks like", () => {
    const strSchema = { type: "object", properties: { content: { type: "string" }, command: { type: "string" } } };
    const input = { content: "42", command: "true" };
    expect(coerceToSchema(input, strSchema).args).toBe(input);
  });
  test("no schema, no coercion", () => {
    const input = { limit: "42" };
    expect(coerceToSchema(input, undefined).args).toBe(input);
  });
});

describe("parseToolArguments policy", () => {
  test("valid JSON is untouched and unmarked", () => {
    const out = parseToolArguments('{"path":"a.ts"}', "read");
    expect(out).toEqual({ args: { path: "a.ts" } });
    expect(out.repaired).toBeUndefined();
  });
  test("empty is an empty object", () => {
    expect(parseToolArguments("  ", "read")).toEqual({ args: {} });
  });
  test("a syntactic repair is counted and marked", () => {
    const out = parseToolArguments("{'command': 'ls',}", "shell");
    expect(out.args).toEqual({ command: "ls" });
    expect(out.repaired).toBe(true);
    expect(out.repairs?.length).toBe(3); // two single-quoted strings + one trailing comma
  });
  test("a truncated read-only call is completed and marked", () => {
    const out = parseToolArguments('{"path":"src/a.ts"', "read");
    expect(out.args).toEqual({ path: "src/a.ts" });
    expect(out.repaired).toBe(true);
  });
  test("a truncated command or content is REFUSED for every side-effecting tool", () => {
    const blobs: Array<[string, string]> = [
      ["shell", '{"command":"rm -rf build && echo done'],
      ["shell", '{"command":"ls","timeout":'],
      ["write", '{"path":"a.txt","content":"half a fi'],
      ["edit", '{"path":"a.txt","old_string":"a","new_string":"b'],
      ["apply_patch", '{"input":"*** Begin Patch\\n*** Add File: a\\n+x'],
      ["some_mcp_tool", '{"x":"y'],
    ];
    for (const [tool, blob] of blobs) {
      const out = parseToolArguments(blob, tool);
      expect(out.error).toContain("cut off");
      expect(out.args).toEqual({});
    }
    // No tool name at all fails closed too.
    expect(parseToolArguments('{"command":"ls', undefined).error).toContain("cut off");
  });
  test("a closed-form repair on a side-effecting tool keeps the string bytes", () => {
    const out = parseToolArguments("{'path': 'a.txt', 'content': 'line1\nline2',}", "write");
    expect(out.args).toEqual({ path: "a.txt", content: "line1\nline2" });
  });
  test("unrepairable input keeps the strict parser's error", () => {
    const out = parseToolArguments("not json at all", "read");
    expect(out.error).toBeDefined();
    expect(out.args).toEqual({});
  });
  test("a non-object top level is rejected", () => {
    expect(parseToolArguments("[1,2]", "read").error).toBe("arguments must be a JSON object");
    expect(parseToolArguments("[1,2,", "read").error).toBe("arguments must be a JSON object");
  });
  test("coerces against the registered tool's own schema via loop.parseArguments", () => {
    const out = parseArguments('{"path":"a.ts","limit":"20"}', "read");
    expect(out.args).toEqual({ path: "a.ts", limit: 20 });
    expect(out.repaired).toBe(true);
    expect(out.repairs?.[0]).toContain("limit");
  });
});
