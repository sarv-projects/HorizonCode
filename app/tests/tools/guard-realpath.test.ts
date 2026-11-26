/**
 * guard-realpath.test.ts — D-1: every read-side tool must guard the REAL target.
 *
 * A directory symlink inside the workspace can point at an arbitrary outside
 * tree. If a search tool guards the lexical "inside" spelling while reading
 * through the link, policy decides about a path whose bytes it never touches.
 * This fixture pins the rule for glob, ast_search, repo_map, lsp and lint: the
 * guard action names the resolved target, and a policy that denies outside
 * targets stops the tool before any byte is read.
 */

import { describe, expect, test } from "bun:test";
import { realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import type { GuardAction, GuardDecision } from "../../src/contracts";
import { astSearchTool } from "../../src/tools/ast-search";
import { globTool } from "../../src/tools/glob";
import { lintTool } from "../../src/tools/lint";
import { lspTool } from "../../src/tools/lsp";
import { repoMapTool } from "../../src/tools/repo-map";
import { makeWorkspace, mockToolContext, tempRoot, writeFixture } from "./helpers";

/** Allow only targets whose REAL path is inside root; deny everything else. */
function insideOnly(root: string) {
  return (action: GuardAction): GuardDecision =>
    action.target === root || action.target.startsWith(root + path.sep) || action.target.startsWith(root + "/")
      ? { decision: "allow" }
      : { decision: "deny", reason: "outside workspace" };
}

function realWorkspace(ws: string): string {
  return realpathSync(ws);
}

/** A workspace with `link` -> an outside directory holding secret.ts. */
function linkedWorkspace(): { ws: string; outside: string; secret: string } {
  const outside = realpathSync(tempRoot());
  const secret = writeFixture(outside, "secret.ts", "export const secret = 1;\n");
  const ws = makeWorkspace({ "inside.ts": "export const inside = 1;\n" });
  symlinkSync(outside, path.join(ws, "link"), "dir");
  return { ws, outside, secret };
}

describe("read tools guard the real target through a directory symlink", () => {
  test("glob guards the resolved root", async () => {
    const { ws, outside } = linkedWorkspace();
    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realWorkspace(ws)) });
    const r = await globTool.execute({ pattern: "*.ts", path: "link" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("denied by policy");
    expect(ctx.guardCalls[0]?.target).toBe(outside);
  });

  test("ast_search guards the resolved root", async () => {
    const { ws, outside } = linkedWorkspace();
    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realWorkspace(ws)) });
    const r = await astSearchTool.execute({ pat: "secret = $X", path: "link" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("denied by policy");
    expect(ctx.guardCalls[0]?.target).toBe(outside);
  });

  test("repo_map guards the resolved root", async () => {
    const { ws, outside } = linkedWorkspace();
    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realWorkspace(ws)) });
    const r = await repoMapTool.execute({ path: "link" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("denied by policy");
    expect(ctx.guardCalls[0]?.target).toBe(outside);
  });

  test("lsp guards the resolved file before reading it", async () => {
    const { ws, secret } = linkedWorkspace();
    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realWorkspace(ws)) });
    const r = await lspTool.execute({ op: "diagnostics", path: "link/secret.ts" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("denied by policy");
    expect(ctx.guardCalls[0]?.target).toBe(secret);
  });

  test("lint guards the resolved file before reading it", async () => {
    const { ws, secret } = linkedWorkspace();
    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realWorkspace(ws)) });
    const r = await lintTool.execute({ path: "link/secret.ts" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("denied by policy");
    expect(ctx.guardCalls[0]?.target).toBe(secret);
  });
});
