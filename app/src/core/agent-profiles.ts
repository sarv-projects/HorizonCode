/**
 * agent-profiles.ts: specialised subagent presets (CURRENT_RUN §5.0.1,
 * docs/30 §5.11; contract AgentProfileV1, docs/15 §2.6/§3.6, docs/05 §4.9).
 *
 * A preset is DATA: a tool allow-list, a prompt block, an optional model
 * override and a step cap. The invariant is the profile-level half of D17
 * measured against the PARENT: an allow-list must be a subset of the ceiling
 * (every registered tool except `agent` itself, which a child never holds), so
 * a preset naming anything outside it is refused with `profile_ceiling_widens`
 * (docs/15 §8). "Narrow" means relative to the parent, NOT to the generic
 * seven-tool child: `code` and user presets can hold tools (apply_patch,
 * ast_edit, undo, lsp, repo_map, ast_search) the generic child does not. The kernel guard still decides every
 * effect: a preset never grants a lease and never skips an approval.
 *
 * Built-ins: explore, plan, code, review. User presets come from
 * `<user config dir>/agents/*.md` and `<workspace>/.hz/agents/*.md`
 * (front-matter: name, description, tools, model, max_steps; body = prompt)
 * and from nowhere else: no plugin, no env var, no network. A malformed or
 * widening file is refused and listed; it never reaches a child.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { tools as registeredTools } from "../tools";
import { stateRoot, userConfigDir } from "./paths";
import { digestWorkspaceAgents, resolveWorkspaceProjectAgentsTrust, type WorkspaceTrustOptions } from "./trust";

export type PresetSource = "builtin" | "user" | "workspace";

export interface AgentPreset {
  name: string;
  description: string;
  /** Tool allow-list; a subset of the ceiling. */
  tools: readonly string[];
  /** Prompt block appended to the child prompt. */
  prompt: string;
  /** Optional model override (a model id for the same provider). */
  model?: string;
  /** Step cap; the generic clamp (1..20) still applies. */
  maxSteps?: number;
  source: PresetSource;
}

export const PROFILE_CEILING_WIDENS = "profile_ceiling_widens";

/** Longest prompt body and description a user preset may carry. */
export const PRESET_PROMPT_CAP = 4000;
export const PRESET_DESCRIPTION_CAP = 200;
/** Most user preset files read per directory. */
export const PRESET_FILE_CAP = 32;

/** The ceiling: every registered tool except `agent` (no recursion). */
export function presetCeiling(): string[] {
  return registeredTools.map((t) => t.name).filter((name) => name !== "agent");
}

const READ_ONLY = ["read", "grep", "glob", "repo_map", "ast_search", "lsp"] as const;

const READ_ONLY_RULES =
  "You are READ-ONLY: you have no write, edit or shell tool; do not try to change files or run commands. ";

const NEVER_RULES =
  "Never: you must not write, edit, run shell, start previews, delegate, or touch MCP. You only search and read text you can reach with grep/glob. ";

export const BUILTIN_PRESETS: readonly AgentPreset[] = [
  {
    name: "never",
    description: "isolated read-only search only (grep/glob); strongest Never/isolation preset",
    tools: ["grep", "glob"],
    maxSteps: 8,
    source: "builtin",
    prompt: [
      "Profile: never.",
      NEVER_RULES + "You are isolated in a nested session: no parent context, no agent tool, no leases.",
      "- Search with grep/glob only; do not assume file contents without a path match.",
      "- Return concise hits (path:line or path). State what was not found.",
    ].join("\n"),
  },
  {
    name: "explore",
    description: "read-only search and reading; returns concise findings with path:line",
    tools: READ_ONLY,
    maxSteps: 12,
    source: "builtin",
    prompt: [
      "Profile: explore.",
      READ_ONLY_RULES + "Find and read the code the task asks about.",
      "- Search broadly first (repo_map, grep, glob), then read only the ranges that matter.",
      "- Report concise findings: each as path:line plus one line of what is there. Say what you could not find. No plans, no code changes.",
    ].join("\n"),
  },
  {
    name: "plan",
    description: "read-only; returns a structured plan with steps, files and risks",
    tools: READ_ONLY,
    maxSteps: 12,
    source: "builtin",
    prompt: [
      "Profile: plan.",
      READ_ONLY_RULES + "Read enough code to plan the task; do not implement it.",
      "Return exactly these sections:",
      "Steps: numbered, each small and verifiable.",
      "Files: every file to change or create, as path (and path:line where known), with one line of why.",
      "Risks: what could break, what is unknown, what needs a decision from the parent.",
    ].join("\n"),
  },
  {
    name: "code",
    description: "full tool set for one scoped implementation task",
    tools: [...READ_ONLY, "write", "edit", "shell", "todo", "apply_patch", "ast_edit", "undo"],
    maxSteps: 20,
    source: "builtin",
    prompt: [
      "Profile: code.",
      "Implement exactly the scoped task and nothing else. Verify it with the repository's own checks when you can, and report what you ran.",
    ].join("\n"),
  },
  {
    name: "review",
    description: "read-only; returns findings with path:line and severity",
    tools: READ_ONLY,
    maxSteps: 12,
    source: "builtin",
    prompt: [
      "Profile: review.",
      READ_ONLY_RULES + "Review the change or code the task names for defects, missing tests and risks.",
      "Return findings, one per line, as: [severity] path:line - problem and the fix. Severity is one of critical, high, medium, low.",
      "If there are no findings, say so and list what you checked. Do not rewrite the code.",
    ].join("\n"),
  },
];

export interface PresetRefusal {
  name: string;
  source: PresetSource;
  file: string;
  /** `profile_ceiling_widens` or a short malformed-file reason. */
  reason: string;
}

export interface PresetSet {
  presets: Map<string, AgentPreset>;
  refused: PresetRefusal[];
}

/**
 * The widening check: names in `tools` outside `ceiling`. Empty means the
 * preset stays within the parent's tools.
 */
export function wideningTools(tools: readonly string[], ceiling: readonly string[] = presetCeiling()): string[] {
  const allowed = new Set(ceiling);
  return tools.filter((name) => !allowed.has(name));
}

interface ParsedFile {
  meta: Map<string, string>;
  body: string;
}

function parseFile(raw: string): ParsedFile | undefined {
  const lines = raw.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start += 1;
  if (start >= lines.length || lines[start].trim() !== "---") return undefined;
  let end = -1;
  for (let i = start + 1; i < Math.min(lines.length, start + 40); i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return undefined;
  const meta = new Map<string, string>();
  for (const line of lines.slice(start + 1, end)) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (m) meta.set(m[1].toLowerCase().replace(/-/g, "_"), m[2].trim().replace(/^["']|["']$/g, ""));
  }
  return { meta, body: lines.slice(end + 1).join("\n").trim() };
}

function parseToolList(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s !== "");
}

const SAFE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/** One preset file: the preset, or the refusal reason. */
export function parsePresetFile(
  raw: string,
  fallbackName: string,
  source: PresetSource,
  ceiling: readonly string[] = presetCeiling(),
): AgentPreset | string {
  const parsed = parseFile(raw);
  if (parsed === undefined) return "missing front-matter";
  const name = (parsed.meta.get("name") ?? fallbackName).trim();
  if (!SAFE_NAME.test(name)) return `invalid name ${JSON.stringify(name)} (lowercase letters, digits, - and _)`;
  const toolsRaw = parsed.meta.get("tools");
  if (toolsRaw === undefined) return "tools is required";
  const toolList = parseToolList(toolsRaw);
  if (toolList.length === 0) return "tools must not be empty";
  const wide = wideningTools(toolList, ceiling);
  if (wide.length > 0) return `${PROFILE_CEILING_WIDENS}: ${wide.join(", ")}`;
  if (parsed.body === "") return "prompt body is empty";
  let maxSteps: number | undefined;
  const stepsRaw = parsed.meta.get("max_steps");
  if (stepsRaw !== undefined) {
    const n = Number(stepsRaw);
    if (!Number.isInteger(n) || n < 1) return "max_steps must be a positive integer";
    maxSteps = n;
  }
  // A workspace file is repository content: it cannot pick the model (ruling 61).
  const model = source === "workspace" ? undefined : parsed.meta.get("model");
  return {
    name,
    description: (parsed.meta.get("description") ?? "").slice(0, PRESET_DESCRIPTION_CAP),
    tools: [...new Set(toolList)],
    prompt: parsed.body.slice(0, PRESET_PROMPT_CAP),
    ...(model !== undefined && model !== "" ? { model } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    source,
  };
}

export interface PresetOptions extends WorkspaceTrustOptions {
  /** Home directory for the user config dir; defaults to the OS home. */
  home?: string;
}

function presetDirs(workspace: string, opts: PresetOptions): { dir: string; source: PresetSource }[] {
  const dirs: { dir: string; source: PresetSource }[] = [];
  let home = opts.home;
  if (home === undefined) {
    try {
      home = homedir();
    } catch {
      home = "";
    }
  }
  if (home !== "") dirs.push({ dir: path.join(userConfigDir(home), "agents"), source: "user" });
  dirs.push({ dir: path.join(stateRoot(workspace), "agents"), source: "workspace" });
  return dirs;
}

/**
 * Built-ins plus user/workspace presets. A user or workspace file that reuses a
 * built-in or earlier name is refused (nothing is silently overridden).
 */
export function loadPresets(workspace: string, opts: PresetOptions = {}): PresetSet {
  const presets = new Map<string, AgentPreset>();
  const refused: PresetRefusal[] = [];
  for (const preset of BUILTIN_PRESETS) presets.set(preset.name, preset);
  const ceiling = presetCeiling();
  const projectAgentsOk =
    opts.trustedWorkspaceHooks === undefined
      ? true
      : resolveWorkspaceProjectAgentsTrust(
          workspace,
          opts.trustedWorkspaceHooks,
          opts.home ?? "",
          opts.onNotice,
        );
  for (const { dir, source } of presetDirs(workspace, opts)) {
    if (source === "workspace" && !projectAgentsOk) {
      if (digestWorkspaceAgents(workspace) !== null) {
        opts.onNotice?.("workspace agent presets ignored (untrusted workspace or digest changed)");
      }
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir)
        .filter((e) => e.endsWith(".md") && !e.startsWith("."))
        .sort()
        .slice(0, PRESET_FILE_CAP);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry);
      let result: AgentPreset | string;
      try {
        if (!statSync(file).isFile()) continue;
        result = parsePresetFile(readFileSync(file, "utf8"), path.basename(entry, ".md"), source, ceiling);
      } catch {
        result = "unreadable";
      }
      if (typeof result === "string") {
        refused.push({ name: path.basename(entry, ".md"), source, file, reason: result });
      } else if (presets.has(result.name)) {
        refused.push({ name: result.name, source, file, reason: `name already defined (${presets.get(result.name)?.source})` });
      } else {
        presets.set(result.name, result);
      }
    }
  }
  return { presets, refused };
}

export type ResolvedPreset = { ok: true; preset: AgentPreset } | { ok: false; error: string };

/** Resolve a `profile` argument to a preset, or a model-readable refusal. */
export function resolvePreset(workspace: string, name: string, opts: PresetOptions = {}): ResolvedPreset {
  const set = loadPresets(workspace, opts);
  const preset = set.presets.get(name);
  if (preset !== undefined) return { ok: true, preset };
  const refusal = set.refused.find((r) => r.name === name);
  if (refusal !== undefined) return { ok: false, error: `profile "${name}" refused: ${refusal.reason}` };
  return { ok: false, error: `unknown profile "${name}" (available: ${[...set.presets.keys()].join(", ")})` };
}

/** One line per preset for the `agent` tool description. */
export function presetCatalog(workspace: string, opts: PresetOptions = {}): string {
  const { presets } = loadPresets(workspace, opts);
  const lines: string[] = [];
  for (const p of presets.values()) {
    const tag = p.source === "builtin" ? "" : ` [${p.source}]`;
    lines.push(`- ${p.name}${tag}: ${p.description}`);
  }
  return "Profiles (optional `profile` argument; a profile picks a subset of the parent's tools, never `agent`):\n" + lines.join("\n");
}
