/** `grep` — match format, skip dirs, caps, glob filter, fallback walker. */

import path from "node:path";
import { describe, expect, test } from "bun:test";
import { grepTool } from "../../src/tools/grep";
import { makeWorkspace, mockToolContext, numberedLines, withoutRipgrep } from "./helpers";

const TREE: Record<string, string> = {
  "src/app.ts": "const needle = 1;\nother line\n",
  "src/util.ts": "// needle here\nnothing\n",
  "src/literal.ts": "call widget (x)\n",
  "README.md": "needle in docs\n",
  "node_modules/pkg/index.ts": "needle decoy node_modules\n",
  ".git/hooks/pre-commit": "needle decoy git\n",
  "target/gen.ts": "needle decoy target\n",
  "dist/bundle.js": "needle decoy dist\n",
};

/** Match lines only, dropping the truncation marker line. */
function matchLines(output: string): string[] {
  return output.split("\n").filter((l) => !l.startsWith("[truncated:"));
}

/** A fixture whose single file holds `count` matching lines. */
function matchFixture(count: number): string {
  return makeWorkspace({ "hits.txt": numberedLines(count, (n) => `hit ${n}`) });
}

describe("grep tool", () => {
  test("finds matches as path:line: text", async () => {
    const ws = makeWorkspace(TREE);
    const r = await grepTool.execute({ pattern: "needle" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    const lines = matchLines(r.output).sort();
    expect(lines).toEqual([
      "README.md:1: needle in docs",
      "src/app.ts:1: const needle = 1;",
      "src/util.ts:1: // needle here",
    ]);
    for (const line of lines) expect(line).toMatch(/^[^:]+:\d+: /);
  });

  test("skips node_modules, .git, target and dist", async () => {
    const ws = makeWorkspace(TREE);
    const r = await grepTool.execute({ pattern: "needle" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).not.toContain("decoy");
    expect(r.output).not.toContain("node_modules");
    expect(r.output).not.toContain(".git");
    expect(r.output).not.toContain("target/");
    expect(r.output).not.toContain("dist/");
  });

  test("honours the path argument", async () => {
    const ws = makeWorkspace(TREE);
    const r = await grepTool.execute({ pattern: "needle", path: "src" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    const lines = matchLines(r.output).sort();
    expect(lines).toEqual(["src/app.ts:1: const needle = 1;", "src/util.ts:1: // needle here"]);
  });

  test("honours the glob filter", async () => {
    const ws = makeWorkspace(TREE);
    const r = await grepTool.execute({ pattern: "needle", glob: "*.md" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(matchLines(r.output)).toEqual(["README.md:1: needle in docs"]);
  });

  test("supports regular expressions", async () => {
    const ws = makeWorkspace(TREE);
    const r = await grepTool.execute({ pattern: "^const" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(matchLines(r.output)).toEqual(["src/app.ts:1: const needle = 1;"]);
  });

  test("falls back to literal text when the pattern is not a valid regex", async () => {
    const ws = makeWorkspace(TREE);
    const r = await grepTool.execute({ pattern: "widget (" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(matchLines(r.output)).toEqual(["src/literal.ts:1: call widget (x)"]);
  });

  test("reports no matches as a successful empty result", async () => {
    const ws = makeWorkspace(TREE);
    const r = await grepTool.execute({ pattern: "no-such-token-anywhere" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("No matches.");
  });

  test("caps the result set at 200 matches and reports the cap", async () => {
    const ws = matchFixture(250);
    const r = await grepTool.execute({ pattern: "hit" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    const lines = r.output.split("\n");
    expect(lines.length).toBe(201);
    expect(lines[200]).toBe("[truncated: first 200 matches shown]");
    expect(matchLines(r.output).length).toBe(200);
    expect(matchLines(r.output)[0]).toBe("hits.txt:1: hit 1");
  });

  test("requires a pattern", async () => {
    const r = await grepTool.execute({}, mockToolContext());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("pattern is required");
  });

  test("asks for approval and honours a decline", async () => {
    const ws = makeWorkspace(TREE);
    const ctx = mockToolContext({ cwd: ws, decision: "ask", approve: false });
    const r = await grepTool.execute({ pattern: "needle" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("declined by user");
    expect(ctx.guardCalls).toEqual([{ kind: "fs.read", target: ws }]);
    expect(ctx.approveCalls.length).toBe(1);
    expect(ctx.approveCalls[0].title).toBe(`Search ${path.basename(ws)}`);
    expect(ctx.approveCalls[0].detail).toBe(ws);
  });

  test("reports a policy denial", async () => {
    const ws = makeWorkspace(TREE);
    const ctx = mockToolContext({ cwd: ws, decision: "deny", decisionReason: "no reads" });
    const r = await grepTool.execute({ pattern: "needle" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("denied by policy: no reads");
    expect(ctx.approveCalls.length).toBe(0);
  });

  test("without ripgrep: finds matches and skips the same directories", async () => {
    const ws = makeWorkspace(TREE);
    const r = await withoutRipgrep(() => grepTool.execute({ pattern: "needle" }, mockToolContext({ cwd: ws })));
    expect(r.ok).toBe(true);
    const lines = matchLines(r.output).sort();
    expect(lines).toEqual([
      "README.md:1: needle in docs",
      "src/app.ts:1: const needle = 1;",
      "src/util.ts:1: // needle here",
    ]);
    expect(r.output).not.toContain("decoy");
  });

  test("without ripgrep: honours the 200-match cap", async () => {
    const ws = matchFixture(250);
    const r = await withoutRipgrep(() => grepTool.execute({ pattern: "hit" }, mockToolContext({ cwd: ws })));
    expect(r.ok).toBe(true);
    expect(matchLines(r.output).length).toBe(200);
    expect(r.output.split("\n").at(-1)).toBe("[truncated: first 200 matches shown]");
  });
});
