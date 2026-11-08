/**
 * ignore-parity.test.ts — glob and grep must agree about what the repository
 * contains. ripgrep has always obeyed `.gitignore`; glob listed the same paths
 * anyway, and grep's JS fallback searched them too — so `glob` could hand the
 * model files `grep` would never find. Both now filter through git itself
 * (`tools/ignore.ts`), and a non-repository workspace filters nothing.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { globTool } from "../../src/tools/glob";
import { grepTool } from "../../src/tools/grep";
import { gitIgnoredPaths } from "../../src/tools/ignore";
import { makeWorkspace, mockToolContext, withoutRipgrep } from "./helpers";

const GIT = Bun.which("git");

/** A repo with one kept and one git-ignored match. */
function fixture(): string {
  const ws = makeWorkspace({
    ".gitignore": "skip/\n",
    "keep/a.txt": "needle here\n",
    "skip/b.txt": "needle there\n",
  });
  const init = spawnSync(GIT as string, ["init", "-q"], { cwd: ws, encoding: "utf8" });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  return ws;
}

describe("git-ignore parity between glob and grep", () => {
  test("glob does not list a git-ignored path", async () => {
    if (!GIT) return; // no git: the fail-open path is covered below
    const ws = fixture();
    const r = await globTool.execute({ pattern: "**/*.txt" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("keep/a.txt");
    expect(r.output).not.toContain("skip/b.txt");
  }, 30000);

  test("grep finds the kept file and not the ignored one", async () => {
    if (!GIT) return;
    const ws = fixture();
    const r = await grepTool.execute({ pattern: "needle" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("keep/a.txt:1: needle here");
    expect(r.output).not.toContain("skip/b.txt");
  }, 30000);

  test("grep's JS fallback (no ripgrep) filters the same way", async () => {
    if (!GIT) return;
    const ws = fixture();
    const r = await withoutRipgrep(() => grepTool.execute({ pattern: "needle" }, mockToolContext({ cwd: ws })));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("keep/a.txt:1: needle here");
    expect(r.output).not.toContain("skip/b.txt");
  }, 30000);

  test("outside a git repository nothing is filtered (fail-open)", async () => {
    const ws = makeWorkspace({
      ".gitignore": "skip/\n",
      "keep/a.txt": "needle here\n",
      "skip/b.txt": "needle there\n",
    });
    const r = await globTool.execute({ pattern: "**/*.txt" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("keep/a.txt");
    expect(r.output).toContain("skip/b.txt");
  }, 30000);

  test("the helper itself: empty input costs no spawn, a non-repo filters nothing", async () => {
    const ws = makeWorkspace({ "a.txt": "x\n" });
    expect((await gitIgnoredPaths(ws, [], `${ws}/.hz`)).size).toBe(0);
    const set = await gitIgnoredPaths(ws, [`${ws}/a.txt`], `${ws}/.hz`);
    expect(set.size).toBe(0);
  }, 30000);
});
