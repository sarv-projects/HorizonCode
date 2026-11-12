import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { activeSkillSection, getSkill, listSkills } from "../../src/core/skills";
import type { WorkspaceTrustOptions } from "../../src/core/trust";

let ws: string;
let home: string;
let saved: string | undefined;
beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), "hz-sf-ws-"));
  home = mkdtempSync(path.join(tmpdir(), "hz-sf-home-"));
  saved = process.env.HOME;
  process.env.HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.HOME;
  else process.env.HOME = saved;
  rmSync(ws, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});
function put(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function skillOpts(trusted = false): WorkspaceTrustOptions {
  return trusted ? { home, trustedWorkspaceHooks: [path.resolve(ws)] } : { home };
}

test("folder skill loads SKILL.md and lists resources", () => {
  const dir = path.join(ws, ".claude", "skills", "deploy");
  put(path.join(dir, "SKILL.md"), "---\ndescription: Ship it\n---\nRun the steps.");
  put(path.join(dir, "scripts", "go.sh"), "echo");
  const skill = getSkill(ws, "deploy", skillOpts())!;
  expect(skill.description).toBe("Ship it");
  expect(skill.resources).toEqual(["scripts/go.sh"]);
  expect(activeSkillSection(skill)).toContain("- scripts/go.sh");
});

test("precedence: project hz > project .claude", () => {
  put(path.join(ws, ".claude", "skills", "a", "SKILL.md"), "project claude");
  expect(getSkill(ws, "a", skillOpts())!.body).toBe("project claude");
  put(path.join(ws, ".hz", "state", "skills", "a", "SKILL.md"), "project hz");
  expect(getSkill(ws, "a", skillOpts(true))!.body).toBe("project hz");
  expect(listSkills(ws, skillOpts(true)).filter((s) => s.name === "a")).toHaveLength(1);
});

test("symlinked skill files and folders are refused", () => {
  const secret = path.join(ws, "secret.txt");
  put(secret, "TOP SECRET");
  const dir = path.join(ws, ".claude", "skills");
  mkdirSync(dir, { recursive: true });
  symlinkSync(secret, path.join(dir, "flat.md"));
  mkdirSync(path.join(dir, "fold"), { recursive: true });
  symlinkSync(secret, path.join(dir, "fold", "SKILL.md"));
  const outside = path.join(ws, "outside");
  put(path.join(outside, "SKILL.md"), "body");
  symlinkSync(outside, path.join(dir, "linked"));
  expect(listSkills(ws, skillOpts()).map((s) => s.name)).toEqual([]);
});

test("the built-in execute-plan skill resolves but is not listed, and a workspace skill shadows it", () => {
  expect(getSkill(ws, "execute-plan", skillOpts())?.source).toBe("builtin:execute-plan");
  expect(listSkills(ws, skillOpts()).map((s) => s.name)).not.toContain("execute-plan");
  put(path.join(ws, ".hz", "state", "skills", "execute-plan.md"), "---\ndescription: mine\n---\nmine");
  expect(getSkill(ws, "execute-plan", skillOpts(true))?.body).toBe("mine");
});
