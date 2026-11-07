/**
 * scope.test.ts — workspace scoping must follow symlinks for the part of the
 * path that exists, or a link inside the workspace can hide a target outside it.
 * (This was a real finding: `scopeFor` only resolved lexically, so
 * `ws/link -> /tmp/out` classified `ws/link/secret.txt` as workspace and the
 * kernel — which trusts the caller's scope — allowed it.)
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { pathInsideWorkspace, scopeFor } from "../../src/core/loop";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(() => cleanupTemps());

describe("pathInsideWorkspace", () => {
  test("classifies plain paths by where they resolve", () => {
    const ws = tempDir("hz-scope-ws-");
    expect(pathInsideWorkspace(path.join(ws, "a", "b.txt"), ws)).toBe(true);
    expect(pathInsideWorkspace(ws, ws)).toBe(true);
    expect(pathInsideWorkspace("../outside.txt", ws)).toBe(false);
    expect(pathInsideWorkspace("/etc/hosts", ws)).toBe(false);
    expect(pathInsideWorkspace("", ws)).toBe(false);
  });

  test("a file named '..notes.md' stays inside", () => {
    const ws = tempDir("hz-scope-dots-");
    writeFileSync(path.join(ws, "..notes.md"), "x", "utf8");
    expect(pathInsideWorkspace(path.join(ws, "..notes.md"), ws)).toBe(true);
  });

  test("a symlink pointing outside the workspace is outside", () => {
    const ws = tempDir("hz-scope-ws-");
    const outside = tempDir("hz-scope-out-");
    writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
    symlinkSync(outside, path.join(ws, "link"));
    expect(pathInsideWorkspace(path.join(ws, "link", "secret.txt"), ws)).toBe(false);
    // a path that does not exist yet under the link resolves through it too
    expect(pathInsideWorkspace(path.join(ws, "link", "new-file.txt"), ws)).toBe(false);
  });

  test("a symlink that stays inside the workspace is inside", () => {
    const ws = tempDir("hz-scope-ws-");
    mkdirSync(path.join(ws, "real"));
    writeFileSync(path.join(ws, "real", "f.txt"), "x", "utf8");
    symlinkSync(path.join(ws, "real"), path.join(ws, "alias"));
    expect(pathInsideWorkspace(path.join(ws, "alias", "f.txt"), ws)).toBe(true);
  });

  test("scopeFor classifies fs actions through symlinks and never for commands", () => {
    const ws = tempDir("hz-scope-ws-");
    const outside = tempDir("hz-scope-out-");
    symlinkSync(outside, path.join(ws, "escape"));
    expect(scopeFor({ kind: "fs.read", target: path.join(ws, "a.txt") }, ws)).toBe("workspace");
    expect(scopeFor({ kind: "fs.write", target: path.join(ws, "escape", "x.txt") }, ws)).toBe("outside");
    expect(scopeFor({ kind: "shell.exec", target: "ls" }, ws)).toBe("*");
  });
});
