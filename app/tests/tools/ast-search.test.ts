/** ast_search — self-contained matcher, guard, and the guarded external path. */

import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { GuardAction } from "../../src/contracts";
import { astSearchTool, externalLimits } from "../../src/tools/ast-search";
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

  test("shell.exec DENIED: no spawn, degrades to the matcher with a notice (review issue 7)", async () => {
    const ws = makeWorkspace(TREE);
    const marker = path.join(ws, "spawned.marker");
    const fake = writeFixture(ws, "fake-ast-grep", `#!/usr/bin/bash\ntouch ${marker}\n`);
    chmodSync(fake, 0o755);
    const ctx = mockToolContext({
      cwd: ws,
      decision: (action) => (action.kind === "shell.exec" ? { decision: "deny", reason: "no exec" } : { decision: "allow" }),
    });
    const r = await withFakeAstGrep(fake, () => astSearchTool.execute({ pat: "foo($A)", glob: "*.ts" }, ctx));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("src/a.ts:1:11: foo(bar)");
    expect(r.output).toContain("shell.exec denied by policy: no exec");
    expect(ctx.guardCalls.some((g) => g.kind === "shell.exec")).toBe(true);
    expect(existsSync(marker)).toBe(false); // admission precedes spawn: denied means never started
  });

  test("external nonzero exit with empty stdout degrades instead of 'No matches.' (review issue 5)", async () => {
    const ws = makeWorkspace(TREE);
    const fake = writeFixture(ws, "fake-ast-grep", "#!/usr/bin/bash\nexit 2\n");
    chmodSync(fake, 0o755);
    const r = await withFakeAstGrep(fake, () =>
      astSearchTool.execute({ pat: "foo($A)", glob: "*.ts" }, mockToolContext({ cwd: ws })),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("src/a.ts:1:11: foo(bar)");
    expect(r.output).toContain("exited with code 2");
  });

  test("external malformed JSON degrades to the matcher (review issue 5)", async () => {
    const ws = makeWorkspace(TREE);
    const fake = writeFixture(ws, "fake-ast-grep", "#!/usr/bin/bash\nprintf 'not json'\n");
    chmodSync(fake, 0o755);
    const r = await withFakeAstGrep(fake, () =>
      astSearchTool.execute({ pat: "foo($A)", glob: "*.ts" }, mockToolContext({ cwd: ws })),
    );
    expect(r.output).toContain("not parseable");
    expect(r.output).toContain("src/a.ts:1:11: foo(bar)");
  });

  test("external results honour glob and SKIP_DIRS like the built-in path (review issue 5)", async () => {
    const ws = makeWorkspace(TREE);
    const items = [
      { file: "src/a.ts", text: "foo(bar)", range: { start: { line: 0, column: 10 } } },
      { file: "node_modules/pkg/i.ts", text: "foo(x)", range: { start: { line: 0, column: 0 } } },
      { file: ".hz/state.ts", text: "foo(y)", range: { start: { line: 0, column: 0 } } },
      { file: "docs/notes.md", text: "foo(ignored)", range: { start: { line: 0, column: 0 } } },
    ];
    const fake = writeFixture(ws, "fake-ast-grep", `#!/usr/bin/bash\nprintf '%s' '${JSON.stringify(items)}'\n`);
    chmodSync(fake, 0o755);
    const r = await withFakeAstGrep(fake, () =>
      astSearchTool.execute({ pat: "foo($A)", glob: "*.ts" }, mockToolContext({ cwd: ws })),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe("src/a.ts:1:11: foo(bar)");
  });

  test("external child that hangs is killed at the timeout and degrades (review issue 6)", async () => {
    const ws = makeWorkspace(TREE);
    const fake = writeFixture(ws, "fake-ast-grep", "#!/usr/bin/bash\nexec sleep 30\n");
    chmodSync(fake, 0o755);
    const saved = externalLimits.timeoutMs;
    externalLimits.timeoutMs = 300;
    try {
      const t0 = Date.now();
      const r = await withFakeAstGrep(fake, () =>
        astSearchTool.execute({ pat: "foo($A)", glob: "*.ts" }, mockToolContext({ cwd: ws })),
      );
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(r.output).toContain("timed out");
      expect(r.output).toContain("src/a.ts:1:11: foo(bar)");
    } finally {
      externalLimits.timeoutMs = saved;
    }
  });

  test("external output over the byte cap is cut off and degrades (review issue 6)", async () => {
    const ws = makeWorkspace(TREE);
    const fake = writeFixture(ws, "fake-ast-grep", "#!/usr/bin/bash\nexec yes xxxxxxxxxxxxxxxx\n");
    chmodSync(fake, 0o755);
    const saved = externalLimits.maxBytes;
    externalLimits.maxBytes = 4096;
    try {
      const r = await withFakeAstGrep(fake, () =>
        astSearchTool.execute({ pat: "foo($A)", glob: "*.ts" }, mockToolContext({ cwd: ws })),
      );
      expect(r.output).toContain("exceeded 4096 bytes");
      expect(r.output).toContain("src/a.ts:1:11: foo(bar)");
    } finally {
      externalLimits.maxBytes = saved;
    }
  });

  test("built-in path skips SKIP_DIRS and honours glob", async () => {
    const ws = makeWorkspace({
      "src/a.ts": "foo(1)\n",
      "node_modules/p/i.ts": "foo(2)\n",
      ".hz/s.ts": "foo(3)\n",
      "src/b.py": "foo(4)\n",
    });
    const r = await withoutRipgrep(() =>
      astSearchTool.execute({ pat: "foo($A)", glob: "*.ts" }, mockToolContext({ cwd: ws })),
    );
    expect(r.output).toBe("src/a.ts:1:1: foo(1)\nmeta: A=1");
  });

  test("more than MAX_RESULTS matches shows the truncation notice", async () => {
    const ws = makeWorkspace({ "a.ts": "foo(1);\n".repeat(300) });
    const r = await withoutRipgrep(() => astSearchTool.execute({ pat: "foo($A)" }, mockToolContext({ cwd: ws })));
    expect(r.output).toContain("[truncated: first 200 matches shown]");
    expect(r.output.split("\n").filter((l) => l.startsWith("a.ts:")).length).toBe(200);
  });

  test("a file too large for the matcher is reported, not silently 'No matches.' (review issue 4)", async () => {
    const ws = makeWorkspace({ "big.ts": `foo(1);${" ".repeat(4 * 1024 * 1024 + 10)}`, "small.ts": "bar(1)\n" });
    const r = await withoutRipgrep(() => astSearchTool.execute({ pat: "foo($A)" }, mockToolContext({ cwd: ws })));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("No matches.");
    expect(r.output).toContain("skipped: 1 file(s) too large");
  });

  test("Rust lifetimes do not hide later matches in search (review issue 3)", async () => {
    const ws = makeWorkspace({ "x.rs": "fn x<'a>(v:&'a str){ foo(1) } fn y<'b>(){ foo(2) }\n" });
    const r = await withoutRipgrep(() => astSearchTool.execute({ pat: "foo($A)" }, mockToolContext({ cwd: ws })));
    expect(r.output).toContain("foo(1)");
    expect(r.output).toContain("foo(2)");
  });

  test("requires a pattern", async () => {
    const r = await astSearchTool.execute({}, mockToolContext());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("pat is required");
  });

  test("a budget-cut scan prints a notice instead of 'No matches.'", async () => {
    const ws = makeWorkspace({ "big.ts": "a b c d e f g h ".repeat(300) });
    const r = await withoutRipgrep(() =>
      astSearchTool.execute({ pat: "$$$A $$$B zzz" }, mockToolContext({ cwd: ws })),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("work budget");
    expect(r.output).toContain("results are incomplete");
  });

  test("files with unterminated strings get a lexing-uncertain notice", async () => {
    const ws = makeWorkspace({ "l.lisp": "(foo 'bar)\n(foo baz)\n" });
    const r = await withoutRipgrep(() => astSearchTool.execute({ pat: "foo($A)" }, mockToolContext({ cwd: ws })));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("[lexing uncertain in 1 file(s)");
    const clean = makeWorkspace({ "c.ts": "foo(bar)\n" });
    const r2 = await withoutRipgrep(() => astSearchTool.execute({ pat: "foo($A)" }, mockToolContext({ cwd: clean })));
    expect(r2.output).not.toContain("lexing uncertain");
  });

  test("lang description mentions the lexer family", () => {
    const d = (astSearchTool.parameters as any).properties.lang.description as string;
    expect(d).toContain("lexer family");
    expect(d).not.toContain("for an external ast-grep backend");
  });
});
