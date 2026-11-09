/** ast_search — self-contained matcher, guard, and the guarded external path. */

import { chmodSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { GuardAction } from "../../src/contracts";
import { astSearchTool } from "../../src/tools/ast-search";
import { makeWorkspace, mockToolContext, withoutRipgrep, writeFixture } from "./helpers";

const TREE: Record<string, string> = {
  "src/a.ts": "const r = foo(bar);\nbaz();\n",
  "src/b.ts": "foo(qux)\n",
  "docs/notes.md": "foo(ignored)\n",
};

/** Run `fn` with `Bun.which` returning `fakePath` for `ast-grep` (and `sg`). */
async function withFakeAstGrep<T>(fakePath: string, fn: () => Promise<T>): Promise<T> {
  const original = Bun.which;
  try {
    (Bun as unknown as { which: unknown }).which = (name: string) => (name === "ast-grep" ? fakePath : null);
    return await fn();
  } finally {
    (Bun as unknown as { which: unknown }).which = original;
  }
}

describe("ast_search tool", () => {
  test("finds structural matches via the self-contained backend", async () => {
    const ws = makeWorkspace(TREE);
    const r = await withoutRipgrep(() =>
      astSearchTool.execute({ pat: "foo($A)", glob: "*.ts" }, mockToolContext({ cwd: ws })),
    );
    expect(r.ok).toBe(true);
    const lines = r.output.split("\n").filter((l) => l.includes("foo")).sort();
    // Output is `rel:line:col: <matched span>` — the structural match text,
    // not the whole source line (col 11 is where `foo` begins in a.ts).
    expect(lines).toEqual(["src/a.ts:1:11: foo(bar)", "src/b.ts:1:1: foo(qux)"]);
  });

  test("emits a meta: line when a capture is present", async () => {
    const ws = makeWorkspace({ "x.ts": "foo(theArg)\n" });
    const r = await withoutRipgrep(() => astSearchTool.execute({ pat: "foo($A)" }, mockToolContext({ cwd: ws })));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("meta: A=theArg");
  });

  test("reports no matches as a successful 'No matches.'", async () => {
    const ws = makeWorkspace(TREE);
    const r = await withoutRipgrep(() =>
      astSearchTool.execute({ pat: "nope($A)" }, mockToolContext({ cwd: ws })),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe("No matches.");
  });

  test("guard DENY on fs.read fails and performs no search", async () => {
    const ws = makeWorkspace(TREE);
    const ctx = mockToolContext({ cwd: ws, decision: "deny", decisionReason: "no reads" });
    const r = await withoutRipgrep(() => astSearchTool.execute({ pat: "foo($A)" }, ctx));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("denied by policy: no reads");
    expect(ctx.guardCalls).toEqual([{ kind: "fs.read", target: ws }]);
    expect(ctx.approveCalls.length).toBe(0);
  });

  test("backend-absent: degrades gracefully to the matcher and never throws", async () => {
    const ws = makeWorkspace(TREE);
    // Bun.which stubbed to null (no external ast-grep): the self-contained path.
    const r = await withoutRipgrep(() =>
      astSearchTool.execute({ pat: "foo($A)", glob: "*.ts" }, mockToolContext({ cwd: ws })),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("foo(bar)");
  });

  test("external backend present: the spawn is admitted through a shell.exec guard", async () => {
    const ws = makeWorkspace(TREE);
    // A real, harmless executable standing in for ast-grep: it prints one
    // JSON match so the guarded-spawn path is exercised end to end.
    const fake = writeFixture(
      ws,
      "fake-ast-grep",
      "#!/usr/bin/bash\n" + `printf '%s' '[{"file":"src/a.ts","text":"foo(bar)","range":{"start":{"line":0,"column":10}}}]'\n`,
    );
    chmodSync(fake, 0o755);

    const seen: GuardAction[] = [];
    const ctx = mockToolContext({
      cwd: ws,
      decision: (action) => {
        seen.push(action);
        return { decision: "allow" };
      },
    });

    const r = await withFakeAstGrep(fake, () => astSearchTool.execute({ pat: "foo($A)", lang: "ts" }, ctx));
    expect(r.ok).toBe(true);
    // The read guard, then the shell.exec admission, BOTH before any spawn.
    const kinds = ctx.guardCalls.map((g) => g.kind);
    expect(kinds).toContain("fs.read");
    expect(kinds).toContain("shell.exec");
    const shellExec = ctx.guardCalls.find((g) => g.kind === "shell.exec");
    expect(shellExec?.target).toContain("fake-ast-grep");
    expect(shellExec?.target).toContain("--pattern");
    // The external output was parsed into a grep-style line.
    expect(r.output).toContain("src/a.ts:1:11: foo(bar)");
  });

  test("external backend present but DENIED at the shell.exec guard: no spawn, failure", async () => {
    const ws = makeWorkspace(TREE);
    const fake = path.join(ws, "fake-ast-grep");
    const ctx = mockToolContext({
      cwd: ws,
      decision: (action) => (action.kind === "shell.exec" ? { decision: "deny", reason: "no exec" } : { decision: "allow" }),
    });
    const r = await withFakeAstGrep(fake, () => astSearchTool.execute({ pat: "foo($A)" }, ctx));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("denied by policy: no exec");
    // The shell.exec guard was consulted (admission precedes any spawn).
    expect(ctx.guardCalls.some((g) => g.kind === "shell.exec")).toBe(true);
  });

  test("requires a pattern", async () => {
    const r = await astSearchTool.execute({}, mockToolContext());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("pat is required");
  });
});
