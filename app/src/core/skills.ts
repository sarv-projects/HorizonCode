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
 * A folder skill is `skills/<name>/SKILL.md`; the other files in the folder are
 * listed as resources when it is active. `~/.agents/skills`, `~/.claude/skills`
 * and `<workspace>/.claude/skills` are read-only sources. Precedence: project >
 * global (horizon dirs beat foreign ones at the same level).
 *
 * The workspace copy shadows a home skill with the same name. The human
 * activates a skill by starting a message with `/<name>`; `resolveSkillForMessage`
 * splits that into the skill plus the stripped action, and the loop injects the
 * skill body into the system prompt for that turn.
 *
 * Parsing is deliberately forgiving: an unreadable or malformed file is skipped
 * silently — a bad skill file must never break a chat turn.
 */

import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { skillsDir as resolveWorkspaceSkillsDir, userSkillsDir } from "./paths";
import { digestWorkspaceSkills, resolveWorkspaceProjectSkillsTrust, type WorkspaceTrustOptions } from "./trust";

export interface Skill {
  name: string;
  description: string;
  body: string;
  /** The file the skill was read from. */
  source: string;
  /** Folder skills only: the skill folder; other files in it are resources. */
  dir?: string;
  /** Folder skills only: resource files, relative to `dir` (capped). */
  resources?: string[];
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
function readSkillFile(file: string, fallbackName?: string): Skill | undefined {
  try {
    if (!lstatSync(file).isFile()) return undefined; // symlinks are refused
    const raw = readFileSync(file, "utf8");
    const { meta, body } = splitFrontmatter(raw);
    const name = (meta.name ?? fallbackName ?? path.basename(file, path.extname(file))).trim();
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

/**
 * Lowest precedence first, so a later directory shadows an earlier one:
 * foreign global (~/.agents, ~/.claude, read-only), horizon global, foreign
 * project (.claude/skills, read-only), horizon project.
 */
function skillDirs(workspace: string, home?: string): string[] {
  const dirs: string[] = [];
  let resolvedHome = typeof home === "string" ? home : "";
  if (resolvedHome === "") {
    try {
      resolvedHome = os.homedir();
    } catch {
      resolvedHome = "";
    }
  }
  if (resolvedHome !== "") {
    dirs.push(
      path.join(resolvedHome, ".agents", "skills"),
      path.join(resolvedHome, ".claude", "skills"),
      userSkillsDir(resolvedHome),
    );
  }
  dirs.push(
    path.join(workspace, ".claude", "skills"),
    path.join(workspace, ".hz", "skills"),
    resolveWorkspaceSkillsDir(workspace),
  );
  return dirs;
}

const RESOURCE_CAP = 40;

/** Files under a skill folder other than SKILL.md, relative, bounded depth and count. */
function folderResources(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, rel: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(current).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (out.length >= RESOURCE_CAP) return;
      if (n.startsWith(".")) continue;
      const full = path.join(current, n);
      const r = rel === "" ? n : rel + "/" + n;
      try {
        const st = lstatSync(full);
        if (st.isDirectory()) {
          if (depth < 3) walk(full, r, depth + 1);
        } else if (st.isFile() && r !== "SKILL.md") out.push(r);
      } catch {
        /* unreadable entry */
      }
    }
  };
  walk(dir, "", 0);
  return out;
}

/** Every skill visible from a workspace, workspace copy winning by name. */
export function listSkills(workspace: string, trust?: WorkspaceTrustOptions): Skill[] {
  const projectSkillsOk =
    trust === undefined
      ? true
      : resolveWorkspaceProjectSkillsTrust(
          workspace,
          trust.trustedWorkspaceHooks,
          trust.home ?? "",
          trust.onNotice,
        );
  const byName = new Map<string, Skill>();
  const projectDir = resolveWorkspaceSkillsDir(workspace);
  const hzCompatDir = path.join(workspace, ".hz", "skills");
  const claudeProjectDir = path.join(workspace, ".claude", "skills");
  for (const dir of skillDirs(workspace, trust?.home)) {
    const gateClaude = trust?.trustedWorkspaceHooks !== undefined && dir === claudeProjectDir;
    const isHzCompat = dir === hzCompatDir;
    if (!projectSkillsOk && (dir === projectDir || isHzCompat || gateClaude)) {
      if (dir === projectDir && digestWorkspaceSkills(workspace) !== null) {
        trust?.onNotice?.("workspace skills ignored (untrusted workspace or digest changed)");
      }
      continue;
    }
    try {
      const dirStat = lstatSync(dir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
    } catch {
      continue; // no skills directory here
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // no skills directory here
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const file = path.join(dir, entry);
      try {
        const st = lstatSync(file);
        if (st.isDirectory()) {
          // skills/<name>/SKILL.md, with the rest of the folder as resources
          const skill = readSkillFile(path.join(file, "SKILL.md"), entry);
          if (skill) byName.set(skill.name, { ...skill, dir: file, resources: folderResources(file) });
          continue;
        }
        if (!entry.endsWith(".md") || !st.isFile()) continue;
      } catch {
        continue;
      }
      const skill = readSkillFile(file);
      if (skill) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Skills shipped with the binary (T-19). They are not listed in the system
 * prompt (the prompt budget is fixed); they answer to `/<name>` and `getSkill`,
 * and a user or workspace skill of the same name shadows them.
 */
export const BUILTIN_SKILLS: readonly Skill[] = [
  {
    name: "execute-plan",
    description: "Carry out a plan file from .hz/plans/ task by task, checking each one off",
    source: "builtin:execute-plan",
    body: [
      "Execute a plan file. The argument is a path, a name under .hz/plans/, or empty (use the newest file in .hz/plans/).",
      "",
      "1. Read the plan. Tasks are `- [ ]` lines; verification criteria sit under a `## Verification` heading.",
      "2. Take the first unchecked task. Do only that task, with the normal tools (every write and command still goes through the guard).",
      "3. When the task is done, edit the plan file and change that line to `- [x]`.",
      "4. Repeat until no `- [ ]` is left, or stop and say why if a task is blocked or the plan is wrong.",
      "5. Run each verification criterion and report which passed. Never tick a task you did not do or a criterion you did not run.",
      "6. Finish with a short summary: tasks done, tasks left, verification results.",
    ].join("\n"),
  },
];

/** The skill with this exact name, if any. */
export function getSkill(workspace: string, name: string, trust?: WorkspaceTrustOptions): Skill | undefined {
  const wanted = typeof name === "string" ? name.trim() : "";
  if (wanted === "") return undefined;
  return listSkills(workspace, trust).find((skill) => skill.name === wanted) ?? BUILTIN_SKILLS.find((skill) => skill.name === wanted);
}

/**
 * The system-prompt section listing available skills; empty string when the
 * workspace has none, so callers can append it unconditionally.
 */
export function skillsPromptSection(workspace: string, trust?: WorkspaceTrustOptions): string {
  const skills = listSkills(workspace, trust);
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
  trust?: WorkspaceTrustOptions,
): { skill: Skill; action: string } | undefined {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value.startsWith("/")) return undefined;
  const match = /^\/([A-Za-z0-9._-]+)(?:\s+([\s\S]*))?$/.exec(value);
  if (!match) return undefined;
  const skill = getSkill(workspace, match[1], trust);
  if (!skill) return undefined;
  return { skill, action: (match[2] ?? "").trim() };
}

/** The per-turn system-prompt block for an activated skill (body capped). */
export function activeSkillSection(skill: Skill): string {
  const body = typeof skill?.body === "string" ? skill.body : "";
  const capped =
    body.length > ACTIVE_SKILL_BODY_CAP ? body.slice(0, ACTIVE_SKILL_BODY_CAP) + "\n[skill truncated]" : body;
  const res = skill.dir && skill.resources && skill.resources.length > 0
    ? `\n\nSkill folder: ${skill.dir}\nResources (read on demand):\n${skill.resources.map((r) => "- " + r).join("\n")}`
    : "";
  return `## Active skill: ${skill.name}\n\n${capped}${res}`;
}

/** Compatibility alias for listSkills(). */
export const loadSkills = listSkills;

/* ---------------- Pillar 6: Host-Controlled Skill Crystallization ---------------- */

/** Strict skill name grammar for host-promoted skills (no traversal, lowercase slug). */
export const VERIFIED_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Strip invisible Unicode tag characters (`U+E0000–U+E007F`) and bidi/zero-width
 * control characters that could conceal injected instructions inside saved skills.
 */
function stripSkillInvisibleUnicode(text: string): string {
  if (typeof text !== "string" || text === "") return "";
  return text
    .replace(/[\u{E0000}-\u{E007F}]/gu, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\u061C\uFEFF]/g, "");
}

function assertNoSymlink(target: string): void {
  try {
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error(`saveVerifiedSkill: refusing to traverse or overwrite symlink: ${target}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

export interface SaveVerifiedSkillOptions {
  name: string;
  description: string;
  script: string;
  language?: string;
}

export interface SaveVerifiedSkillResult {
  skillDir: string;
  skillMdPath: string;
  scriptPath: string;
}

/**
 * Pillar 6 — Host-Controlled Skill Crystallization (human/host command ONLY;
 * explicitly NOT registered as an LLM-callable tool to prevent self-promotion
 * skill poisoning).
 *
 * Writes `<workspace>/.hz/state/skills/<name>/SKILL.md` and
 * `<workspace>/.hz/state/skills/<name>/scripts/run.ts` with `0600` permissions,
 * validating `name`, refusing symlinks, and stripping invisible Unicode.
 */
export function saveVerifiedSkill(
  workspace: string,
  opts: SaveVerifiedSkillOptions,
): SaveVerifiedSkillResult {
  const name = typeof opts?.name === "string" ? opts.name.trim() : "";
  if (!VERIFIED_SKILL_NAME_RE.test(name)) {
    throw new Error(
      `saveVerifiedSkill: invalid skill name ${JSON.stringify(name)} (must match ${String(VERIFIED_SKILL_NAME_RE)})`,
    );
  }
  const cleanDescription = stripSkillInvisibleUnicode(opts.description ?? "")
    .replace(/\r?\n+/g, " ")
    .trim();
  const cleanScript = stripSkillInvisibleUnicode(opts.script ?? "");
  const cleanLang = stripSkillInvisibleUnicode(opts.language ?? "ts")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .trim() || "ts";

  const resolvedWorkspace = path.resolve(workspace);
  const hzDir = path.join(resolvedWorkspace, ".hz");
  const stateDir = path.join(hzDir, "state");
  const skillsRoot = path.join(stateDir, "skills");
  const skillDir = path.join(skillsRoot, name);
  const scriptsDir = path.join(skillDir, "scripts");
  const skillMdPath = path.join(skillDir, "SKILL.md");
  const scriptPath = path.join(scriptsDir, "run.ts");

  for (const p of [resolvedWorkspace, hzDir, stateDir, skillsRoot, skillDir, scriptsDir, skillMdPath, scriptPath]) {
    assertNoSymlink(p);
  }

  mkdirSync(scriptsDir, { recursive: true, mode: 0o700 });

  const backtickRuns = cleanScript.match(/`+/g);
  const maxBackticks = backtickRuns ? Math.max(...backtickRuns.map((run) => run.length)) : 0;
  const fence = "`".repeat(Math.max(4, maxBackticks + 1));

  const skillMd = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(cleanDescription)}`,
    "---",
    "",
    `# ${name}`,
    "",
    cleanDescription !== "" ? cleanDescription : "Host-verified reusable Code Mode skill.",
    "",
    "Run the verified script at `scripts/run.ts`:",
    "",
    `${fence}${cleanLang}`,
    cleanScript.trimEnd(),
    fence,
    "",
  ].join("\n");

  writeFileSync(skillMdPath, skillMd, { encoding: "utf8", mode: 0o600 });
  writeFileSync(scriptPath, cleanScript, { encoding: "utf8", mode: 0o600 });

  try {
    chmodSync(skillMdPath, 0o600);
    chmodSync(scriptPath, 0o600);
  } catch {
    /* best-effort on filesystems without POSIX chmod */
  }

  return { skillDir, skillMdPath, scriptPath };
}
