import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { candidates, complete, ghostFor } from "../../src/tui/completion";

const ws = mkdtempSync(path.join(tmpdir(), "hz-complete-"));
mkdirSync(path.join(ws, "src", "deep"), { recursive: true });
mkdirSync(path.join(ws, "node_modules"));
mkdirSync(path.join(ws, ".git"));
writeFileSync(path.join(ws, "src", "app.ts"), "x");
writeFileSync(path.join(ws, "src", "apple.ts"), "x");
writeFileSync(path.join(ws, "README.md"), "x");
writeFileSync(path.join(ws, ".env"), "x");
writeFileSync(path.join(ws, "evil\u001b[2Jname.txt"), "x");
afterAll(() => rmSync(ws, { recursive: true, force: true }));

const ctx = { workspace: ws, commands: ["help", "?", "model", "mode", "plan", "review", "think"] };

describe("slash completion", () => {
  test("built-in and custom names, sorted, slash kept", () => {
    expect(complete("/mo", ctx)).toEqual([["/mode", "/model"], "/mo"]);
    expect(complete("/re", ctx)[0]).toEqual(["/review"]);
    expect(complete("/", ctx)[0]).toEqual(["/help", "/mode", "/model", "/plan", "/review", "/think"]);
  });
  test("no completion once arguments start", () => {
    expect(complete("/model gp", ctx)[0]).toEqual([]);
    expect(complete("hello", ctx)[0]).toEqual([]);
  });
  test("ghost is the rest of the first candidate", () => {
    expect(ghostFor("/pl", ctx)).toBe("an");
    expect(ghostFor("/mo", ctx)).toBe("de");
    expect(ghostFor("/plan", ctx)).toBe("");
    expect(ghostFor("/", ctx)).toBe("");
    expect(ghostFor("/zzz", ctx)).toBe("");
  });
});

describe("@file completion", () => {
  test("lists the workspace, dirs first, skipping .git/node_modules and dotfiles", () => {
    expect(candidates("look at @", ctx).hits).toEqual(["@src/", "@README.md"]);
    expect(candidates("@.", ctx).hits).toEqual(["@.env"]);
  });
  test("descends into directories and filters by prefix", () => {
    expect(candidates("see @src/ap", ctx).hits).toEqual(["@src/app.ts", "@src/apple.ts"]);
    expect(ghostFor("see @src/appl", ctx)).toBe("e.ts");
    expect(ghostFor("see @READ", ctx)).toBe("ME.md");
  });
  test("cannot climb out of the workspace", () => {
    expect(candidates("@../", ctx).hits).toEqual([]);
    expect(candidates("@/etc/", ctx).hits).toEqual([]);
  });
});

describe("unsafe file names", () => {
  test("a name with an escape character is never offered", () => {
    const hits = candidates("@e", ctx).hits;
    expect(hits.some((h) => h.includes("\u001b"))).toBe(false);
    expect(ghostFor("@evil", ctx)).toBe("");
  });
});
