/** `glob` — pattern matching, skip dirs, ordering, caps. */

import { describe, expect, test } from "bun:test";
import { globTool } from "../../src/tools/glob";
import { makeWorkspace, mockToolContext } from "./helpers";

const TREE: Record<string, string> = {
  "a.txt": "a\n",
  "b.ts": "b\n",
  "sub/c.ts": "c\n",
  "sub/deep/d.ts": "d\n",
  "docs/readme.md": "docs\n",
  "node_modules/pkg/index.ts": "decoy\n",
  ".git/hooks/pre-commit": "decoy\n",
  "dist/bundle.ts": "decoy\n",
  "target/gen.ts": "decoy\n",
};

describe("glob tool", () => {
  test("matches a recursive pattern and sorts the output", async () => {
    const ws = makeWorkspace(TREE);
    const r = await globTool.execute({ pattern: "**/*.ts" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("b.ts\nsub/c.ts\nsub/deep/d.ts");
  });

  test("treats a slash-less pattern as recursive", async () => {
    const ws = makeWorkspace(TREE);
    const r = await globTool.execute({ pattern: "*.ts" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("b.ts\nsub/c.ts\nsub/deep/d.ts");
  });

  test("matches a directory branch", async () => {
    const ws = makeWorkspace(TREE);
    const r = await globTool.execute({ pattern: "sub/**" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("sub/c.ts\nsub/deep/d.ts");
  });

  test("skips node_modules, .git, dist and target", async () => {
    const ws = makeWorkspace(TREE);
    const r = await globTool.execute({ pattern: "**/*" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("a.txt\nb.ts\ndocs/readme.md\nsub/c.ts\nsub/deep/d.ts");
    expect(r.output).not.toContain("decoy");
  });

  test("matches by extension at any depth", async () => {
    const ws = makeWorkspace(TREE);
    const r = await globTool.execute({ pattern: "*.md" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("docs/readme.md");
  });

  test("honours the path root and still reports workspace-relative paths", async () => {
    const ws = makeWorkspace(TREE);
    const r = await globTool.execute({ pattern: "*.ts", path: "sub" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("sub/c.ts\nsub/deep/d.ts");
  });

  test("reports no matches", async () => {
    const ws = makeWorkspace(TREE);
    const r = await globTool.execute({ pattern: "**/*.rs" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("No files matched.");
  });

  test("fails when the root does not exist", async () => {
    const ws = makeWorkspace(TREE);
    const r = await globTool.execute({ pattern: "**/*.ts", path: "nope" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("path not found: nope");
  });

  test("requires a pattern", async () => {
    const r = await globTool.execute({}, mockToolContext());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("pattern is required");
  });

  test("caps the output at 300 paths and reports the cap", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 340; i++) files[`bulk/f${String(i).padStart(4, "0")}.txt`] = `${i}\n`;
    const ws = makeWorkspace(files);
    const r = await globTool.execute({ pattern: "**/*.txt" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    const lines = r.output.split("\n");
    expect(lines.length).toBe(301);
    expect(lines[0]).toBe("bulk/f0000.txt");
    expect(lines[299]).toBe("bulk/f0299.txt");
    expect(lines[300]).toBe("[truncated: first 300 of 340 paths shown]");
  });

  test("asks for approval and honours a decline", async () => {
    const ws = makeWorkspace(TREE);
    const ctx = mockToolContext({ cwd: ws, decision: "ask", approve: false });
    const r = await globTool.execute({ pattern: "**/*.ts" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("declined by user");
    expect(ctx.guardCalls).toEqual([{ kind: "fs.read", target: ws }]);
    expect(ctx.approveCalls.length).toBe(1);
  });

  test("an incomplete walk says so instead of presenting a partial list as complete", async () => {
    // The walk stops after MAX_COLLECT (5000) matches; before the fix the marker only
    // covered the display cap (MAX_RESULTS), so a partial list read as a full one
    // (audit finding 8).
    const files: Record<string, string> = {};
    for (let i = 0; i < 5001; i++) files[`bulk/f${String(i).padStart(5, "0")}.txt`] = `${i}\n`;
    const ws = makeWorkspace(files);
    const r = await globTool.execute({ pattern: "**/*.txt" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("[incomplete: the walk stopped after collecting 5000 matches");
    expect(r.output).toContain("NOT exhaustive");
    expect(r.output).toContain("[truncated: first 300 of 5000 paths shown]");
  }, 60000);

  test("reports a policy denial", async () => {
    const ws = makeWorkspace(TREE);
    const ctx = mockToolContext({ cwd: ws, decision: "deny", decisionReason: "no reads" });
    const r = await globTool.execute({ pattern: "**/*.ts" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("denied by policy: no reads");
    expect(ctx.approveCalls.length).toBe(0);
  });
});
