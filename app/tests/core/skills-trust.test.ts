import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { skillsDir } from "../../src/core/paths";
import { getSkill, listSkills } from "../../src/core/skills";
import {
  bindWorkspaceTrustRecord,
  collectWorkspaceTrustDigests,
  digestWorkspaceSkills,
  loadTrustStore,
} from "../../src/core/trust";

let workspace: string;
let home: string;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  if (home) rmSync(home, { recursive: true, force: true });
});

function writeSkill(name: string, body = "do thing"): void {
  const dir = skillsDir(workspace);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: test\n---\n${body}`,
  );
}

describe("workspace skills trust", () => {
  test("unlisted workspace skills are hidden", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-skill-trust-"));
    home = mkdtempSync(path.join(tmpdir(), "hz-skill-home-"));
    writeSkill("deploy");
    const notes: string[] = [];
    const skills = listSkills(workspace, {
      trustedWorkspaceHooks: [],
      home,
      onNotice: (m) => notes.push(m),
    });
    expect(skills.some((s) => s.name === "deploy")).toBe(false);
    expect(notes.join("\n")).toContain("workspace skills ignored");
  });

  test("trusted workspace skills load and bind digest", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-skill-trust-"));
    home = mkdtempSync(path.join(tmpdir(), "hz-skill-home-"));
    writeSkill("deploy");
    const resolved = path.resolve(workspace);
    const skills = listSkills(workspace, { trustedWorkspaceHooks: [resolved], home });
    expect(skills.some((s) => s.name === "deploy")).toBe(true);
    const digest = digestWorkspaceSkills(workspace);
    expect(loadTrustStore(home).records[0]?.skillsDigest).toBe(digest);
  });

  test("skills digest change hides project skill until re-bind", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-skill-trust-"));
    home = mkdtempSync(path.join(tmpdir(), "hz-skill-home-"));
    writeSkill("deploy");
    const resolved = path.resolve(workspace);
    const currents = collectWorkspaceTrustDigests(workspace);
    bindWorkspaceTrustRecord(home, workspace, currents);
    writeSkill("deploy", "new body");
    const notes: string[] = [];
    expect(
      getSkill(workspace, "deploy", { trustedWorkspaceHooks: [resolved], home, onNotice: (m) => notes.push(m) }),
    ).toBeUndefined();
    expect(notes.join("\n")).toContain("digest changed");
  });
});
