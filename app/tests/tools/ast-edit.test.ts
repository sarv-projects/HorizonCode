/** ast_edit — structural replace with edit.ts's guard/preimage/atomic discipline. */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { GuardAction } from "../../src/contracts";
import { astEditTool } from "../../src/tools/ast-edit";
import { readTool } from "../../src/tools/read";
import { makeWorkspace, mockToolContext, readFixture } from "./helpers";
import type { MockToolContext } from "./helpers";

/**
 * The read ledger gate (wasRead) requires the session to have read the file.
 * The ledger is keyed by sessionId + realpath, so the read is done through a
 * SEPARATE allow-context that shares the edit context's sessionId — this keeps
 * the edit's own guard/approve recorder uncontaminated by the prior read.
 */
async function readFirst(ctx: MockToolContext, rel: string): Promise<void> {
  const reader = mockToolContext({ cwd: ctx.cwd, workspace: ctx.workspace, sessionId: ctx.sessionId });
  const r = await readTool.execute({ path: rel }, reader);
  expect(r.ok).toBe(true);
}

describe("ast_edit tool", () => {
  test("guard ALLOW: applies the structural replace and updates the file on disk", async () => {
    const ws = makeWorkspace({ "f.ts": "foo(a); foo(b);\n" });
    const ctx = mockToolContext({ cwd: ws });
    await readFirst(ctx, "f.ts");
    const r = await astEditTool.execute({ path: "f.ts", pat: "foo($A)", out: "bar($A)" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 2 structural match(es) in f.ts");
    expect(readFixture(ws, "f.ts")).toBe("bar(a); bar(b);\n");
    expect(ctx.guardCalls.some((g: GuardAction) => g.kind === "fs.write")).toBe(true);
  });

  test("guard DENY: fails and writes nothing", async () => {
    const ws = makeWorkspace({ "f.ts": "foo(a);\n" });
    const ctx = mockToolContext({ cwd: ws, decision: "deny", decisionReason: "no writes" });
    await readFirst(ctx, "f.ts");
    const r = await astEditTool.execute({ path: "f.ts", pat: "foo($A)", out: "bar($A)" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("denied by policy: no writes");
    expect(readFixture(ws, "f.ts")).toBe("foo(a);\n");
  });

  test("guard ASK declined: file unchanged", async () => {
    const ws = makeWorkspace({ "f.ts": "foo(a);\n" });
    const ctx = mockToolContext({ cwd: ws, decision: "ask", approve: false });
    await readFirst(ctx, "f.ts");
    const r = await astEditTool.execute({ path: "f.ts", pat: "foo($A)", out: "bar($A)" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("declined by user");
    expect(readFixture(ws, "f.ts")).toBe("foo(a);\n");
  });

  test("guard ASK approved: applied, and the approval is recorded", async () => {
    const ws = makeWorkspace({ "f.ts": "foo(a);\n" });
    const ctx = mockToolContext({ cwd: ws, decision: "ask", approve: true });
    await readFirst(ctx, "f.ts");
    const r = await astEditTool.execute({ path: "f.ts", pat: "foo($A)", out: "bar($A)" }, ctx);
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "f.ts")).toBe("bar(a);\n");
    expect(ctx.approveCalls.length).toBe(1);
    expect(ctx.approveCalls[0].kind).toBe("fs.write");
    expect(ctx.approveCalls[0].title).toBe("AST edit f.ts");
  });

  test("preimage safety: a file changed between read and write is refused, nothing overwritten", async () => {
    const ws = makeWorkspace({ "f.ts": "foo(a);\n" });
    const abs = path.join(ws, "f.ts");
    // The approval runs AFTER the preimage was read and BEFORE the pre-write
    // re-check: mutating the file here makes the preimage sha256 go stale, so
    // the pre-write check must refuse and write nothing.
    const ctx = mockToolContext({
      cwd: ws,
      decision: "ask",
      approve: () => {
        writeFileSync(abs, "foo(a); // changed on disk\n");
        return true;
      },
    });
    await readFirst(ctx, "f.ts");
    const r = await astEditTool.execute({ path: "f.ts", pat: "foo($A)", out: "bar($A)" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error.startsWith("HZ_PRECONDITION_FAILED: ast_edit refused: preimage changed")).toBe(true);
    // The concurrent writer's content survives; the rewrite is NOT applied.
    expect(readFixture(ws, "f.ts")).toBe("foo(a); // changed on disk\n");
  });

  test("no structural match: fails with a clear message and writes nothing", async () => {
    const ws = makeWorkspace({ "f.ts": "hello world\n" });
    const ctx = mockToolContext({ cwd: ws });
    await readFirst(ctx, "f.ts");
    const r = await astEditTool.execute({ path: "f.ts", pat: "foo($A)", out: "bar($A)" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no structural match for the pattern in f.ts (nothing written)");
    expect(readFixture(ws, "f.ts")).toBe("hello world\n");
  });

  test("read-before-write gate: refuses when the session has not read the file", async () => {
    const ws = makeWorkspace({ "f.ts": "foo(a);\n" });
    const ctx = mockToolContext({ cwd: ws });
    // No readFirst(): the structural rewrite cannot be trusted.
    const r = await astEditTool.execute({ path: "f.ts", pat: "foo($A)", out: "bar($A)" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HZ_PRECONDITION_FAILED: ast_edit refused: this session has not read");
    expect(readFixture(ws, "f.ts")).toBe("foo(a);\n");
  });

  test("file not found", async () => {
    const ws = makeWorkspace({});
    const ctx = mockToolContext({ cwd: ws });
    const r = await astEditTool.execute({ path: "missing.ts", pat: "foo($A)", out: "bar($A)" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("file not found: missing.ts");
  });

  test("requires path, pat and out", async () => {
    const ctx = mockToolContext();
    expect((await astEditTool.execute({ pat: "x", out: "y" }, ctx)).error).toBe("path is required");
    expect((await astEditTool.execute({ path: "f", out: "y" }, ctx)).error).toBe("pat is required");
    expect((await astEditTool.execute({ path: "f", pat: "x" }, ctx)).error).toBe("out is required");
  });

  test("sibling calls with $$$ are all rewritten correctly (review issue 1)", async () => {
    const ws = makeWorkspace({ "f.ts": "foo(a); bar(b);\nfoo(c);\n" });
    const ctx = mockToolContext({ cwd: ws });
    await readFirst(ctx, "f.ts");
    const r = await astEditTool.execute({ path: "f.ts", pat: "foo($$$A)", out: "baz($$$A)" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 2 structural match(es) in f.ts");
    expect(readFixture(ws, "f.ts")).toBe("baz(a); bar(b);\nbaz(c);\n");
  });

  test("more than 1000 matches fails and writes nothing (review issue 2)", async () => {
    const src = "foo(1);\n".repeat(1500);
    const ws = makeWorkspace({ "f.ts": src });
    const ctx = mockToolContext({ cwd: ws });
    await readFirst(ctx, "f.ts");
    const r = await astEditTool.execute({ path: "f.ts", pat: "foo($A)", out: "bar($A)" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("more than 1000 structural matches");
    expect(readFixture(ws, "f.ts")).toBe(src);
  });

  test("oversize file fails as skipped, not as no-match (review issue 4)", async () => {
    const src = `foo(1);\n${" ".repeat(4 * 1024 * 1024 + 10)}`;
    const ws = makeWorkspace({ "f.ts": src });
    const ctx = mockToolContext({ cwd: ws });
    await readFirst(ctx, "f.ts");
    const r = await astEditTool.execute({ path: "f.ts", pat: "foo($A)", out: "bar($A)" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("too large");
    expect(r.error).not.toContain("no structural match");
    expect(readFixture(ws, "f.ts")).toBe(src);
  });

  test("Rust lifetimes: every match is rewritten, none missed (review issue 3)", async () => {
    const src = "fn x<'a>(v:&'a str){ foo(1) } fn y<'b>(){ foo(2) }\n";
    const ws = makeWorkspace({ "f.rs": src });
    const ctx = mockToolContext({ cwd: ws });
    await readFirst(ctx, "f.rs");
    const r = await astEditTool.execute({ path: "f.rs", pat: "foo($A)", out: "bar($A)" }, ctx);
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "f.rs")).toBe(src.replace("foo(1)", "bar(1)").replace("foo(2)", "bar(2)"));
  });

  test("ambiguous quoting (unterminated string) refuses the rewrite (review issue 3)", async () => {
    const src = "it's\nfoo(1)\n";
    const ws = makeWorkspace({ "f.txt": src });
    const ctx = mockToolContext({ cwd: ws });
    await readFirst(ctx, "f.txt");
    const r = await astEditTool.execute({ path: "f.txt", pat: "foo($A)", out: "bar($A)" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("cannot close");
    expect(readFixture(ws, "f.txt")).toBe(src);
  });

  test("path outside the workspace is refused and nothing is written", async () => {
    const ws = makeWorkspace({ "f.ts": "foo(a);\n" });
    const outside = makeWorkspace({ "o.ts": "foo(a);\n" });
    const ctx = mockToolContext({ cwd: ws, decision: (a) => (a.target.startsWith(ws) ? { decision: "allow" } : { decision: "deny", reason: "outside workspace" }) });
    const r = await astEditTool.execute({ path: path.join(outside, "o.ts"), pat: "foo($A)", out: "bar($A)" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("denied by policy: outside workspace");
    expect(readFixture(outside, "o.ts")).toBe("foo(a);\n");
  });

  test("budget exhaustion fails and writes nothing", async () => {
    const src = "a b c d e f g h ".repeat(300);
    const ws = makeWorkspace({ "f.ts": src });
    const ctx = mockToolContext({ cwd: ws });
    await readFirst(ctx, "f.ts");
    const r = await astEditTool.execute({ path: "f.ts", pat: "$$$A $$$B zzz", out: "x" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("work budget");
    expect(readFixture(ws, "f.ts")).toBe(src);
  });

  test("lang descriptions mention the lexer family", () => {
    const d = (astEditTool.parameters as any).properties.lang.description as string;
    expect(d).toContain("lexer family");
    expect(d).not.toContain("language-agnostic");
  });
});
