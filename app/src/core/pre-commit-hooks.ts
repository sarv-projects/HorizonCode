/**
 * F-2 reduced (docs/30): detect local pre-commit hook ids so the harness can
 * tell the model what already runs on commit (ADAPT aider harness lint list).
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

const HOOK_ID = /^\s*-\s+id:\s*([^\s#]+)/gm;
const REPO_HOOK = /^\s*-\s+repo:\s*([^\s#]+)/gm;

function parseHookIds(text: string): string[] {
  const ids = new Set<string>();
  for (const re of [HOOK_ID, REPO_HOOK]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const id = m[1]?.trim();
      if (id !== undefined && id !== "") ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/** Hook ids from `<workspace>/.pre-commit-config.yaml`, when present. */
export function detectPreCommitHookIds(workspace: string): string[] {
  const file = path.join(workspace, ".pre-commit-config.yaml");
  if (!existsSync(file)) return [];
  try {
    const text = readFileSync(file, "utf8");
    return parseHookIds(text);
  } catch {
    return [];
  }
}

/** Prompt block listing harness automation the model should not duplicate. */
export function harnessAutomationSection(workspace: string): string {
  const hooks = detectPreCommitHookIds(workspace);
  if (hooks.length === 0) return "";
  const list = hooks.map((h) => `- ${h}`).join("\n");
  return [
    "Harness automation (already runs on git commit via pre-commit; do not ask the user to run these manually before committing):",
    list,
  ].join("\n");
}
