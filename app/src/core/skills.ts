/**
 * skills.ts — user-authored skills (markdown, optional frontmatter).
 *
 * A skill is a markdown file under `<workspace>/.hz/state/skills/*.md`
 * (canonical) or `<workspace>/.hzcode/skills/*.md` (legacy, in place), and under
 * `~/.config/horizon/skills/*.md` or `~/.hzcode/skills/*.md` correspondingly:
 *
 *   ---
 *   name: deploy
 *   description: Ship the app to staging and verify it came up
 *   ---
 *   Body: free-form instructions the model reads when the skill is active.
 *
 * The workspace copy shadows a home skill with the same name. The human
 * activates a skill by starting a message with `/<name>`; `resolveSkillForMessage`
 * splits that into the skill plus the stripped action, and the loop injects the
 * skill body into the system prompt for that turn.
 *
 * Parsing is deliberately forgiving: an unreadable or malformed file is skipped
 * silently — a bad skill file must never break a chat turn.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { skillsDir as resolveWorkspaceSkillsDir, userSkillsDir } from "./paths";

export interface Skill {
  name: string;
  description: string;
  body: string;
  /** The file the skill was read from. */
  source: string;
}

/** Skills listed in the system-prompt directory. */
const PROMPT_SKILL_CAP = 12;
const DESCRIPTION_CAP = 140;
/** Body size injected for the active skill (contract for the chat bar). */
export const ACTIVE_SKILL_BODY_CAP = 8000;

interface Frontmatter {
  name?: string;
  description?: string;
}

/** Split `---` delimited frontmatter (simple `key: value` lines) from the body. */
function splitFrontmatter(raw: string): { meta: Frontmatter; body: string } {
  const lines = raw.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start += 1;
  if (start >= lines.length || lines[start].trim() !== "---") return { meta: {}, body: raw };
  let end = -1;
  for (let i = start + 1; i < Math.min(lines.length, start + 60); i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return { meta: {}, body: raw };
  const meta: Frontmatter = {};
  for (const line of lines.slice(start + 1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (key === "name" && value !== "") meta.name = value;
    if (key === "description" && value !== "") meta.description = value;
  }
  return { meta, body: lines.slice(end + 1).join("\n") };
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** One skill file, or undefined when it cannot be read or is malformed. */
function readSkillFile(file: string): Skill | undefined {
  try {
    const raw = readFileSync(file, "utf8");
    const { meta, body } = splitFrontmatter(raw);
    const name = (meta.name ?? path.basename(file, path.extname(file))).trim();
    if (name === "" || name.startsWith(".") || !SAFE_NAME.test(name)) return undefined;
    return {
      name,
      description: (meta.description ?? "").trim(),
      body: body.trim(),
      source: file,
    };
  } catch {
    return undefined;
  }
}

/** Home first, then the workspace, so a workspace skill shadows a global one. */
function skillDirs(workspace: string): string[] {
  const dirs: string[] = [];
  try {
    const home = os.homedir();
    if (home !== "") dirs.push(userSkillsDir(home));
  } catch {
    /* no home directory: workspace skills only */
  }
  dirs.push(resolveWorkspaceSkillsDir(workspace));
  return dirs;
}

/** Every skill visible from a workspace, workspace copy winning by name. */
export function listSkills(workspace: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const dir of skillDirs(workspace)) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // no skills directory here
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
      const file = path.join(dir, entry);
      try {
        if (!statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      const skill = readSkillFile(file);
      if (skill) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The skill with this exact name, if any. */
export function getSkill(workspace: string, name: string): Skill | undefined {
  const wanted = typeof name === "string" ? name.trim() : "";
  if (wanted === "") return undefined;
  return listSkills(workspace).find((skill) => skill.name === wanted);
}

/**
 * The system-prompt section listing available skills; empty string when the
 * workspace has none, so callers can append it unconditionally.
 */
export function skillsPromptSection(workspace: string): string {
  const skills = listSkills(workspace);
  if (skills.length === 0) return "";
  const lines = skills.slice(0, PROMPT_SKILL_CAP).map((skill) => {
    const description =
      skill.description.length > DESCRIPTION_CAP
        ? skill.description.slice(0, DESCRIPTION_CAP - 3) + "..."
        : skill.description;
    return description === "" ? `- ${skill.name}` : `- ${skill.name} — ${description}`;
  });
  const more =
    skills.length > PROMPT_SKILL_CAP ? `\n(${skills.length - PROMPT_SKILL_CAP} more not listed)` : "";
  return `## Available skills\nStart a message with /<name> to activate one.\n${lines.join("\n")}${more}`;
}

/** `/<skill-name> rest of the message` -> the skill plus the stripped action. */
export function resolveSkillForMessage(
  workspace: string,
  text: string,
): { skill: Skill; action: string } | undefined {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value.startsWith("/")) return undefined;
  const match = /^\/([A-Za-z0-9._-]+)(?:\s+([\s\S]*))?$/.exec(value);
  if (!match) return undefined;
  const skill = getSkill(workspace, match[1]);
  if (!skill) return undefined;
  return { skill, action: (match[2] ?? "").trim() };
}

/** The per-turn system-prompt block for an activated skill (body capped). */
export function activeSkillSection(skill: Skill): string {
  const body = typeof skill?.body === "string" ? skill.body : "";
  const capped =
    body.length > ACTIVE_SKILL_BODY_CAP ? body.slice(0, ACTIVE_SKILL_BODY_CAP) + "\n[skill truncated]" : body;
  return `## Active skill: ${skill.name}\n\n${capped}`;
}
