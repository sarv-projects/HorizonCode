import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { activeSkillSection, getSkill, listSkills } from "../../src/core/skills";

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

test("folder skill loads SKILL.md and lists resources", () => {
  const dir = path.join(ws, ".claude", "skills", "deploy");
  put(path.join(dir, "SKILL.md"), "---\ndescription: Ship it\n---\nRun the steps.");
  put(path.join(dir, "scripts", "go.sh"), "echo");
  const skill = getSkill(ws, "deploy")!;
  expect(skill.description).toBe("Ship it");
  expect(skill.resources).toEqual(["scripts/go.sh"]);
  expect(activeSkillSection(skill)).toContain("- scripts/go.sh");
});

test("precedence: project hz > project .claude", () => {
  put(path.join(ws, ".claude", "skills", "a", "SKILL.md"), "project claude");
  expect(getSkill(ws, "a")!.body).toBe("project claude");
  put(path.join(ws, ".hz", "state", "skills", "a", "SKILL.md"), "project hz");
  expect(getSkill(ws, "a")!.body).toBe("project hz");
  expect(listSkills(ws).filter((s) => s.name === "a")).toHaveLength(1);
});
