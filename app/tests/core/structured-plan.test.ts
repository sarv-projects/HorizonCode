/**
 * structured-plan.test.ts — port of plandex ParseSubtasks + step-scoped
 * context (Tier 1 #14). Test-first: fails on missing module.
 */
import { describe, expect, test } from "bun:test";
import {
  parseSubtasks,
  stepScopedContext,
  renderPlanSummary,
} from "../../src/core/structured-plan";

const REPLY = `Some preamble.

### Tasks

1. Refactor the parser
   - Split the token stream by line
   - Preserve byte offsets
   Uses: \`src/parse.ts\`, src/lexer.ts

2. Add the cache layer
   - LRU with 64-entry cap
   Uses: \`src/cache.ts\`

3. Write tests
   - Cover the parser and cache
`;

describe("structured plan model (plandex port)", () => {
  test("parses numbered tasks, Uses: files and descriptions", () => {
    const tasks = parseSubtasks(REPLY);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]!.title).toBe("Refactor the parser");
    expect(tasks[0]!.usesFiles).toEqual(["src/parse.ts", "src/lexer.ts"]);
    expect(tasks[0]!.description).toContain("Split the token stream");
    expect(tasks[1]!.usesFiles).toEqual(["src/cache.ts"]);
    expect(tasks[2]!.usesFiles).toEqual([]);
  });

  test("accepts singular '### Task' header and returns [] with no section", () => {
    expect(parseSubtasks("### Task\n\n1. One thing\nUses: a.ts").map((t) => t.title)).toEqual(["One thing"]);
    expect(parseSubtasks("no tasks here")).toEqual([]);
  });

  test("step-scoped context includes ONLY that subtask's Uses files", () => {
    const tasks = parseSubtasks(REPLY);
    const files = new Map([
      ["src/parse.ts", "PARSE BODY"],
      ["src/lexer.ts", "LEXER BODY"],
      ["src/cache.ts", "CACHE BODY"],
    ]);
    const ctx = stepScopedContext(tasks[0]!, files);
    expect(ctx).toContain("PARSE BODY");
    expect(ctx).toContain("LEXER BODY");
    expect(ctx).not.toContain("CACHE BODY");
  });

  test("missing files are named, never silently dropped", () => {
    const tasks = parseSubtasks(REPLY);
    const ctx = stepScopedContext(tasks[1]!, new Map());
    expect(ctx).toContain("src/cache.ts");
    expect(ctx).toMatch(/missing/i);
  });

  test("plan summary is deterministic and bounded", () => {
    const tasks = parseSubtasks(REPLY);
    expect(renderPlanSummary(tasks)).toBe(renderPlanSummary(tasks));
    expect(renderPlanSummary(tasks)).toContain("3 subtask");
    expect(renderPlanSummary([])).toContain("0 subtask");
  });
});
