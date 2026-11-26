/**
 * prompt-working-directory.ts — port of grok `prompt_working_directory`
 * (Tier 3). Source: repo_take/grok-build/crates/codegen/xai-grok-agent/src/
 * builder.rs:1289-1296. A display cwd substitutes for the real worktree path
 * in model-facing prompt text and AGENTS.md file paths, so the model never
 * sees the host's private worktree location. Pure string transform; opt-in.
 */

/** The cwd to show the model: display path when set, else the real path. */
export function displayWorkingDir(realCwd: string, displayCwd?: string): string {
  return displayCwd !== undefined && displayCwd.trim() !== "" ? displayCwd : realCwd;
}

/** Replace every occurrence of the real worktree path in model-facing text. */
export function redactWorktreePath(
  text: string,
  realCwd: string,
  displayCwd?: string,
): string {
  if (displayCwd === undefined || displayCwd.trim() === "" || realCwd.trim() === "") return text;
  return text.split(realCwd).join(displayCwd);
}
