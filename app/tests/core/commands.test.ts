import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandCommand, listCommands, loadCommands, resolveCommandForMessage } from "../../src/core/commands";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function ws(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "hz-cmd-"));
  dirs.push(root);
  mkdirSync(path.join(root, ".hz", "commands"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(root, ".hz", "commands", name), body);
  return root;
}

test("loads front-matter description and expands {{args}}", () => {
  const root = ws({ "review.md": "---\ndescription: Review it\n---\nReview this. Focus: {{args}}\n" });
  const [c] = listCommands(root);
  expect(c.name).toBe("review");
  expect(c.description).toBe("Review it");
  expect(resolveCommandForMessage(root, "/review the auth code")?.prompt).toBe("Review this. Focus: the auth code");
});

test("no placeholder appends args; args stay literal", () => {
  const root = ws({ "x.md": "Do X." });
  expect(resolveCommandForMessage(root, "/x $& now")?.prompt).toBe("Do X.\n\n$& now");
  expect(expandCommand(listCommands(root)[0], "")).toBe("Do X.");
});

test("builtin names are shadowed, unknown and malformed are ignored", () => {
  const root = ws({ "help.md": "nope", "bad name.md": "x", "empty.md": "---\n---\n" });
  expect(loadCommands(root).commands.filter((c) => c.name === "help")).toEqual([]);
  expect(loadCommands(root).shadowed).toContain("help");
  expect(resolveCommandForMessage(root, "/help")).toBeUndefined();
  expect(resolveCommandForMessage(root, "/nothing")).toBeUndefined();
  expect(resolveCommandForMessage(root, "plain text")).toBeUndefined();
});
